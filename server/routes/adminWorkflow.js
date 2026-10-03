// server/routes/adminWorkflow.js
// Admin review tools: the artwork review queue (staged status changes that
// only save and email when "Activate Updates" is pressed), deleting submitted
// artwork, the sent-email viewer, and the files that live on an order and a
// customer profile (artwork, mockups, emails, activity).
//
// Mounted at /api/admin ahead of routes/admin.js, so every route here checks
// requireAdmin itself.

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAdmin } = require('../middleware/adminAuth');
const emailService = require('../services/emailService');
const storage = require('../services/storageService');

const router = express.Router();

// What the owner sees -> what is stored. The two older statuses still exist
// on past files: a customer revision request is still under review, and
// "production ready" is approved.
const ARTWORK_STATUS_LABELS = { pending_review: 'Pending', needs_changes: 'Needs Review', approved: 'Approved', declined: 'Declined' };
const SETTABLE_STATUSES = Object.keys(ARTWORK_STATUS_LABELS);
const FILTERS = {
  active: ['pending_review', 'needs_changes', 'customer_revision_requested', 'declined'],
  pending: ['pending_review'],
  needs_review: ['needs_changes', 'customer_revision_requested'],
  declined: ['declined'],
  approved: ['approved', 'production_ready'],
};
// Snapshots of the mockup a customer approved in the builder are proofs, not artwork to review.
const NOT_A_PROOF = "(af.location_name IS NULL OR af.location_name NOT LIKE '%Approved Mockup')";

function artworkRow(f) {
  return { ...f, url: `/uploads/${f.stored_filename}`, downloadUrl: `/api/admin/artwork/${f.id}/download`, statusLabel: statusLabel(f.status) };
}
function statusLabel(status) {
  if (status === 'customer_revision_requested') return 'Needs Review';
  if (status === 'production_ready') return 'Approved';
  return ARTWORK_STATUS_LABELS[status] || status;
}
function baseUrlOf(req) { return `${req.protocol}://${req.get('host')}`; }
function logEvent(quoteId, type, detail) {
  db.prepare('INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?,?,?)').run(quoteId, type, detail);
}

// ------------------------------------------------------------ artwork queue
router.get('/artwork', requireAdmin, (req, res) => {
  const filter = FILTERS[req.query.filter] ? req.query.filter : 'active';
  const statuses = FILTERS[filter];
  const search = String(req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(`SELECT af.*, q.quote_code, q.status AS order_status, c.id AS customer_id, c.first_name, c.last_name
    FROM artwork_files af JOIN quotes q ON q.id = af.quote_id JOIN customers c ON c.id = q.customer_id
    WHERE af.quote_id IS NOT NULL AND ${NOT_A_PROOF} AND af.status IN (${statuses.map(() => '?').join(',')})
    ORDER BY af.uploaded_at DESC LIMIT 400`).all(...statuses);
  if (search) rows = rows.filter(f => `${f.quote_code} ${f.first_name} ${f.last_name} ${f.original_filename}`.toLowerCase().includes(search));
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([key, list]) => [key,
    db.prepare(`SELECT COUNT(*) n FROM artwork_files af WHERE af.quote_id IS NOT NULL AND ${NOT_A_PROOF} AND af.status IN (${list.map(() => '?').join(',')})`).get(...list).n]));
  res.json({ filter, counts, artwork: rows.map(artworkRow) });
});

// Saves every staged change at once, then emails each affected customer one
// summary of what changed on their order. Nothing is emailed before this.
router.post('/artwork/activate', requireAdmin, async (req, res) => {
  const changes = Array.isArray(req.body && req.body.changes) ? req.body.changes : [];
  if (!changes.length) return res.status(400).json({ error: 'There are no staged changes to activate.' });
  if (changes.length > 500) return res.status(400).json({ error: 'Too many changes at once.' });
  const wanted = new Map();
  for (const c of changes) {
    const id = Number(c && c.id);
    if (!Number.isInteger(id) || !SETTABLE_STATUSES.includes(c.status)) return res.status(400).json({ error: 'One of the staged changes is not valid.' });
    wanted.set(id, c.status);
  }

  const byQuote = new Map(); // quote id -> [{ file, status }]
  const apply = db.transaction(() => {
    for (const [id, status] of wanted) {
      const file = db.prepare('SELECT * FROM artwork_files WHERE id = ? AND quote_id IS NOT NULL').get(id);
      if (!file || file.status === status) continue;
      db.prepare('UPDATE artwork_files SET status = ? WHERE id = ?').run(status, id);
      logEvent(file.quote_id, 'artwork_status', `${file.location_name || 'Artwork'} "${file.original_filename}" changed to ${statusLabel(status)} (by ${req.session.adminName})`);
      if (!byQuote.has(file.quote_id)) byQuote.set(file.quote_id, []);
      byQuote.get(file.quote_id).push({ file, status });
    }
    // The order's overall artwork status follows its files.
    for (const quoteId of byQuote.keys()) {
      const files = db.prepare(`SELECT af.status FROM artwork_files af WHERE af.quote_id = ? AND ${NOT_A_PROOF} AND COALESCE(af.location_name,'') != 'Reference'`).all(quoteId).map(f => f.status);
      const overall = files.length && files.every(s => FILTERS.approved.includes(s)) ? 'approved'
        : files.some(s => s === 'declined') ? 'declined'
        : files.some(s => FILTERS.needs_review.includes(s)) ? 'needs_changes' : 'pending_review';
      db.prepare('UPDATE quotes SET artwork_status = ?, updated_at = ? WHERE id = ?').run(overall, new Date().toISOString(), quoteId);
      logEvent(quoteId, 'artwork_activated', `Artwork updates activated by ${req.session.adminName}: ${byQuote.get(quoteId).length} file${byQuote.get(quoteId).length === 1 ? '' : 's'}`);
    }
  });
  apply();

  let emailed = 0;
  const emailErrors = [];
  for (const [quoteId, list] of byQuote) {
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
    if (!customer || !customer.email) continue;
    try {
      await emailService.sendArtworkUpdateEmail(quote, customer, baseUrlOf(req), list.map(({ file, status }) => ({
        filename: file.original_filename, location: file.location_name, status, label: statusLabel(status),
      })));
      emailed++;
    } catch (err) {
      console.error('Artwork update email failed:', err.message);
      emailErrors.push(`#${quote.quote_code}: ${err.message}`);
    }
  }
  const saved = [...byQuote.values()].reduce((n, list) => n + list.length, 0);
  res.json({ ok: true, saved, orders: byQuote.size, emailed, emailErrors });
});

// Permanently removes a submitted file. Artwork on a completed order is part
// of that order's history and stays.
router.delete('/artwork/:id', requireAdmin, (req, res) => {
  const file = db.prepare('SELECT af.*, q.status AS order_status, q.quote_code FROM artwork_files af LEFT JOIN quotes q ON q.id = af.quote_id WHERE af.id = ?').get(Number(req.params.id));
  if (!file) return res.status(404).json({ error: 'Artwork not found.' });
  if (file.order_status === 'completed') {
    return res.status(409).json({ error: `Order #${file.quote_code} is completed, so its artwork is kept as part of the order history.` });
  }
  db.prepare('DELETE FROM artwork_files WHERE id = ?').run(file.id);
  // The stored file goes too, unless another record still points at it (duplicated items share one upload).
  const stillUsed = db.prepare('SELECT 1 FROM artwork_files WHERE stored_filename = ? LIMIT 1').get(file.stored_filename);
  if (!stillUsed) {
    const filePath = path.join(storage.UPLOAD_DIR, path.basename(file.stored_filename));
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { console.error('Could not remove artwork file:', err.message); }
  }
  if (file.quote_id) logEvent(file.quote_id, 'artwork_deleted', `${file.location_name || 'Artwork'} "${file.original_filename}" deleted by ${req.session.adminName}`);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ emails
const EMAIL_COLUMNS = `e.id, e.quote_id, e.to_email, e.bcc_email, e.subject, e.provider, e.sent_at, q.quote_code,
  COALESCE(c.id, c2.id) AS customer_id, COALESCE(c.first_name, c2.first_name) AS first_name, COALESCE(c.last_name, c2.last_name) AS last_name`;
const EMAIL_JOINS = `FROM emails_sent e LEFT JOIN quotes q ON q.id = e.quote_id LEFT JOIN customers c ON c.id = q.customer_id
  LEFT JOIN customers c2 ON c.id IS NULL AND c2.id = (SELECT MIN(id) FROM customers WHERE LOWER(email) = LOWER(e.to_email))`;
function emailRow(e) {
  return {
    id: e.id, to: e.to_email, copyTo: e.bcc_email, subject: e.subject, sentAt: e.sent_at, quoteCode: e.quote_code || null,
    quote_id: e.quote_id, to_email: e.to_email, bcc_email: e.bcc_email, sent_at: e.sent_at, provider: e.provider, // the field names this list has always had
    customerId: e.customer_id || null, customerName: e.first_name ? `${e.first_name} ${e.last_name || ''}`.trim() : null,
    // A row is written only after the mail provider accepted the message.
    status: e.provider === 'mock' ? 'Logged (test mode, not delivered)' : 'Sent',
  };
}
router.get('/emails', requireAdmin, (req, res) => {
  const search = String(req.query.q || '').trim().toLowerCase();
  let rows = db.prepare(`SELECT ${EMAIL_COLUMNS} ${EMAIL_JOINS} ORDER BY e.id DESC LIMIT 500`).all().map(emailRow);
  if (search) rows = rows.filter(e => `${e.to} ${e.subject} ${e.quoteCode || ''} ${e.customerName || ''}`.toLowerCase().includes(search));
  res.json({ emails: rows });
});
router.get('/emails/:id', requireAdmin, (req, res) => {
  const row = db.prepare(`SELECT ${EMAIL_COLUMNS}, e.body_html ${EMAIL_JOINS} WHERE e.id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Email not found.' });
  res.json({ email: { ...emailRow(row), bodyHtml: row.body_html, body_html: row.body_html } });
});

// ------------------------------------------------- mockups on an order
function mockupsFor(whereSql, param) {
  const sent = db.prepare(`SELECT m.*, q.quote_code FROM mockups m JOIN quotes q ON q.id = m.quote_id WHERE ${whereSql} ORDER BY m.id DESC`).all(param)
    .map(m => ({ id: m.id, kind: 'sent', quoteCode: m.quote_code, name: m.original_filename, url: `/uploads/${m.stored_filename}`, status: m.status, customerNote: m.customer_note, at: m.uploaded_at, respondedAt: m.responded_at }));
  const approved = db.prepare(`SELECT af.*, q.quote_code FROM artwork_files af JOIN quotes q ON q.id = af.quote_id WHERE ${whereSql} AND af.location_name LIKE '%Approved Mockup' ORDER BY af.id`).all(param)
    .map(f => ({ id: f.id, kind: 'approved_in_builder', quoteCode: f.quote_code, name: f.location_name, url: `/uploads/${f.stored_filename}`, status: 'approved', at: f.uploaded_at }));
  return [...sent, ...approved];
}
router.get('/quotes/:code/mockups', requireAdmin, (req, res) => {
  const quote = db.prepare('SELECT id FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  res.json({ mockups: mockupsFor('q.id = ?', quote.id) });
});

// ------------------------------------------- everything on a customer profile
router.get('/customers/:id/files', requireAdmin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  const artwork = db.prepare(`SELECT af.*, q.quote_code FROM artwork_files af JOIN quotes q ON q.id = af.quote_id
    WHERE q.customer_id = ? AND ${NOT_A_PROOF} ORDER BY af.uploaded_at DESC`).all(customer.id).map(artworkRow);
  const emails = db.prepare(`SELECT ${EMAIL_COLUMNS} ${EMAIL_JOINS}
    WHERE q.customer_id = ? OR LOWER(e.to_email) = LOWER(?) ORDER BY e.id DESC LIMIT 200`).all(customer.id, customer.email || '').map(emailRow);
  const activity = db.prepare(`SELECT ev.event_type, ev.detail, ev.created_at, q.quote_code FROM quote_events ev JOIN quotes q ON q.id = ev.quote_id
    WHERE q.customer_id = ? ORDER BY ev.id DESC LIMIT 300`).all(customer.id);
  const account = require('../services/customerAccounts').adminSummary(customer.id);
  res.json({ artwork, mockups: mockupsFor('q.customer_id = ?', customer.id), emails, activity, account });
});

// ------------------------------------------------------------ user access
// Customer logins: search, then send password-reset or verification emails
// to one or many. Passwords are never shown here (only a hash is stored).
const accounts = require('../services/customerAccounts');
router.get('/user-access', requireAdmin, (req, res) => {
  res.json({ users: accounts.adminList(req.query.q) });
});
router.post('/user-access/send', requireAdmin, async (req, res) => {
  const kind = (req.body || {}).kind === 'verification' ? 'verification' : 'reset';
  const ids = Array.isArray((req.body || {}).accountIds) ? req.body.accountIds : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one user.' });
  try {
    const result = await accounts.adminSend(kind, ids, baseUrlOf(req));
    db.prepare('INSERT INTO admin_action_log (admin_id, admin_name, action_type, detail) VALUES (?,?,?,?)')
      .run(req.session.adminId, req.session.adminName, kind === 'reset' ? 'password_reset_sent' : 'verification_resent', JSON.stringify(`${result.sent} user(s)`));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not send the emails.' });
  }
});

// ------------------------------------------------------------ analytics
// The report behind the Analytics page (server/services/analyticsReport.js).
router.get('/analytics/report', requireAdmin, (req, res) => {
  const ownHosts = [req.get('host'), process.env.RENDER_EXTERNAL_URL].filter(Boolean).map(h => String(h).replace(/^https?:\/\//, '').split(/[/:]/)[0]);
  res.json(require('../services/analyticsReport').report(String(req.query.range || '30'), { ownHosts }));
});

// ------------------------------------------------------------ live updates
router.get('/live', requireAdmin, (req, res) => require('../services/realtime').stream(req, res));

// ------------------------------------------- Shopify / Square connections
router.post('/webhooks/shopify/register', requireAdmin, async (req, res) => {
  try {
    res.json(await require('./webhooks').registerShopifyWebhooks(process.env.RENDER_EXTERNAL_URL || baseUrlOf(req)));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not reach Shopify.' });
  }
});
router.get('/webhooks/status', requireAdmin, (req, res) => {
  const last = (provider) => db.prepare('SELECT topic, received_at FROM webhook_events WHERE provider = ? ORDER BY received_at DESC LIMIT 1').get(provider) || null;
  const base = process.env.RENDER_EXTERNAL_URL || baseUrlOf(req);
  res.json({
    shopify: { url: `${base}/api/webhooks/shopify`, last: last('shopify') },
    square: { url: `${base}/api/webhooks/square`, last: last('square'), keySaved: !!require('../pricingEngine').getSetting('square_webhook_signature_key', '') },
  });
});

module.exports = router;
module.exports.statusLabel = statusLabel;
