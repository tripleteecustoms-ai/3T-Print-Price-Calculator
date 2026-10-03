// server/routes/production.js
// The job ticket for an order: its print slots, each with the customer's
// artwork, the mockup and the print-ready file; the Production PDF; and the
// ZIP of every file. Mounted at /api/admin. Every route needs an admin login,
// and every file here is served through that login (no public file links).

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAdmin } = require('../middleware/adminAuth');
const storage = require('../services/storageService');
const production = require('../services/productionAssets');
const packet = require('../services/productionPacket');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

const quoteByCode = (code) => db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(String(code || ''));
function withQuote(handler) {
  return async (req, res) => {
    const quote = quoteByCode(req.params.code);
    if (!quote) return res.status(404).json({ error: 'Order not found.' });
    try { await handler(req, res, quote); } catch (err) {
      if (err instanceof production.ProductionError) return res.status(400).json({ error: err.message });
      console.error('[production]', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}
// Files are shown in the browser (or downloaded with ?download=1). "sandbox"
// stops an SVG from running anything when it is opened on the admin's own site.
function sendFile(res, filePath, name, mime, download) {
  if (!fs.existsSync(filePath)) return res.status(404).type('text/plain').send('This file is no longer on the server.');
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  if (/svg|html|xml/i.test(mime || '')) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${String(name || 'file').replace(/[^\x20-\x7E]|["\\]/g, '_')}"`);
  fs.createReadStream(filePath).pipe(res);
}

// ---- the job ticket ----
router.get('/orders/:code/production', requireAdmin, withQuote(async (req, res, quote) => {
  res.json(await production.ticket(quote));
}));

// ---- order-level production notes, due date and per-slot notes ----
router.put('/orders/:code/production', requireAdmin, withQuote(async (req, res, quote) => {
  production.saveNotes(quote, req.body || {});
  production.logEvent(quote.id, 'production_notes', `Production details updated by ${req.session.adminName}`);
  res.json(await production.ticket(quoteByCode(quote.quote_code)));
}));

// ---- upload or replace a Mockup or Print Ready file in one slot (the customer's artwork is never touched) ----
router.post('/orders/:code/assets', requireAdmin, upload.single('file'), withQuote(async (req, res, quote) => {
  if (!req.file) throw new production.ProductionError('Choose a file to upload.');
  const kind = String(req.body.kind || '');
  const slotKey = String(req.body.slot || '');
  const slots = production.slotsFor(quote).items.flatMap(it => it.slots);
  const slot = slots.find(s => s.key === slotKey);
  if (!slot) throw new production.ProductionError('That print location is not part of this order.');
  const replacing = kind === 'print_ready' ? slot.printReady : slot.mockups.find(m => m.source === 'admin');
  const asset = production.saveAsset(quote, { slotKey, kind, originalName: req.file.originalname, buffer: req.file.buffer, uploadedBy: req.session.adminName });
  production.bumpRevision(quote.id);
  const what = kind === 'print_ready' ? 'Print ready file' : 'Mockup';
  production.logEvent(quote.id, kind === 'print_ready' ? 'print_ready_file' : 'mockup_file', `${what} for ${slot.fullLabel} ${replacing ? `replaced ("${replacing.name}" -> "${asset.original_filename}")` : `uploaded ("${asset.original_filename}")`} by ${req.session.adminName}`);
  res.json(await production.ticket(quoteByCode(quote.quote_code)));
}));

router.delete('/production/assets/:id', requireAdmin, async (req, res) => {
  const asset = production.assetById(req.params.id);
  if (!asset || asset.replaced_at) return res.status(404).json({ error: 'File not found.' });
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(asset.quote_id);
  production.retireAsset(asset);
  production.bumpRevision(asset.quote_id);
  production.logEvent(asset.quote_id, asset.kind === 'print_ready' ? 'print_ready_file' : 'mockup_file', `${asset.kind === 'print_ready' ? 'Print ready file' : 'Mockup'} "${asset.original_filename}" removed by ${req.session.adminName}`);
  res.json(await production.ticket(quote));
});

// ---- files, all behind the admin login ----
router.get('/production/assets/:id/file', requireAdmin, (req, res) => {
  const asset = production.assetById(req.params.id);
  if (!asset) return res.status(404).json({ error: 'File not found.' });
  sendFile(res, production.assetPath(asset), asset.original_filename, asset.mime_type, req.query.download === '1');
});
router.get('/production/artwork/:id/file', requireAdmin, (req, res) => {
  const f = db.prepare('SELECT * FROM artwork_files WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'File not found.' });
  sendFile(res, path.join(storage.UPLOAD_DIR, path.basename(f.stored_filename)), f.original_filename, f.mime_type, req.query.download === '1');
});
router.get('/production/sent-mockups/:id/file', requireAdmin, (req, res) => {
  const m = db.prepare('SELECT * FROM mockups WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'File not found.' });
  sendFile(res, path.join(storage.UPLOAD_DIR, path.basename(m.stored_filename)), m.original_filename, m.mime_type, req.query.download === '1');
});
// A PNG preview of an artwork file or an uploaded asset (made on first request, then reused).
router.get('/production/preview/:kind/:id', requireAdmin, async (req, res) => {
  const kind = req.params.kind === 'asset' ? 'asset' : 'artwork';
  const row = kind === 'asset' ? production.assetById(req.params.id) : db.prepare('SELECT * FROM artwork_files WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).end();
  const filePath = kind === 'asset' ? production.assetPath(row) : path.join(storage.UPLOAD_DIR, path.basename(row.stored_filename));
  const preview = await production.previewOf(kind, row.id, filePath, row.mime_type);
  if (!preview) return res.status(415).type('text/plain').send('No preview for this file type.');
  sendFile(res, preview.path, `preview-${row.id}.png`, 'image/png', false);
});

// ---- the two downloads: built fresh on every request ----
async function sendPdf(req, res) {
  const quote = quoteByCode(req.params.code);
  if (!quote) return res.status(404).type('text/plain').send('Order not found.');
  try {
    const pdf = await packet.buildPdf(quote);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${pdf.filename}"`);
    res.send(pdf.bytes);
  } catch (err) {
    console.error('[production] pdf', err);
    res.status(500).type('text/plain').send('The Production PDF could not be generated. Please try again.');
  }
}
async function sendZip(req, res) {
  const quote = quoteByCode(req.params.code);
  if (!quote) return res.status(404).type('text/plain').send('Order not found.');
  try {
    const zip = await packet.buildZip(quote);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${zip.filename}"`);
    res.send(zip.bytes);
  } catch (err) {
    console.error('[production] zip', err);
    res.status(500).type('text/plain').send('The files could not be packaged. Please try again.');
  }
}
router.get('/orders/:code/production.pdf', requireAdmin, sendPdf);
router.get('/orders/:code/files.zip', requireAdmin, sendZip);

module.exports = router;
module.exports.sendPdf = sendPdf;
module.exports.sendZip = sendZip;
