// server/services/productionAssets.js
//
// The production side of an order: for every print slot (an item and a print
// location) three SEPARATE assets are kept and never mixed up:
//
//   Customer Artwork   the file the customer submitted (artwork_files). Never
//                      overwritten or converted.
//   Mockup             how the artwork should look on the product: stored from
//                      the customer's placement, approved in the print builder,
//                      or uploaded by the shop.
//   Print Ready File   the finalized production artwork the shop uploads. This
//                      is the file that goes to the printer.
//
// Mockups and print-ready files uploaded here live in DATA_DIR/production,
// which is NOT served publicly: they are only reachable through admin-login
// routes. Previews (PNG) are made for the production PDF and the admin pages;
// a master file is never altered to make one.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const storage = require('./storageService');
const { DATA_DIR } = require('../dataDir');
const { computeCheckout } = require('../checkoutRules');

const ASSET_DIR = path.join(DATA_DIR, 'production');
if (!fs.existsSync(ASSET_DIR)) fs.mkdirSync(ASSET_DIR, { recursive: true });

const KINDS = ['mockup', 'print_ready'];
const PRINT_READY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.pdf', '.tif', '.tiff', '.psd', '.ai', '.eps', '.webp'];
const MOCKUP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.pdf', '.svg'];
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.webp': 'image/webp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.psd': 'image/vnd.adobe.photoshop', '.ai': 'application/postscript', '.eps': 'application/postscript',
};
const APPROVED = ['approved', 'production_ready'];
const isProof = (name) => /Approved Mockup$/.test(name || '');
const slug = (s) => String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'File';
const parseJson = (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } };

class ProductionError extends Error {}

// ------------------------------------------------------------------ revision
/** Call whenever something a printer would care about changes. The Production PDF shows this number. */
function bumpRevision(quoteId) {
  db.prepare('UPDATE quotes SET production_revision = COALESCE(production_revision, 1) + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), quoteId);
}
function logEvent(quoteId, type, detail) {
  db.prepare('INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?,?,?)').run(quoteId, type, detail);
}

// ------------------------------------------------------------------ stored assets
function assetPath(asset) { return path.join(ASSET_DIR, path.basename(asset.stored_filename)); }
function currentAssets(quoteId) {
  return db.prepare('SELECT * FROM production_assets WHERE quote_id = ? AND replaced_at IS NULL ORDER BY id').all(quoteId);
}
function assetById(id) { return db.prepare('SELECT * FROM production_assets WHERE id = ?').get(Number(id)); }

/**
 * Saves a mockup or print-ready file into a slot. An existing file in that
 * slot is retired (kept on disk and in history), never overwritten; the
 * customer's own artwork is a different record and is not touched.
 */
function saveAsset(quote, { slotKey, kind, originalName, buffer, uploadedBy, source = 'admin' }) {
  if (!KINDS.includes(kind)) throw new ProductionError('Choose Mockup or Print Ready.');
  const ext = path.extname(originalName || '').toLowerCase();
  const allowed = kind === 'print_ready' ? PRINT_READY_EXTENSIONS : MOCKUP_EXTENSIONS;
  if (!allowed.includes(ext)) throw new ProductionError(`That file type is not accepted here. Use ${allowed.map(e => e.slice(1).toUpperCase()).join(', ')}.`);
  if (!buffer || !buffer.length) throw new ProductionError('That file is empty.');
  const storedFilename = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(ASSET_DIR, storedFilename), buffer);
  const now = new Date().toISOString();
  // only a shop-uploaded file replaces a shop-uploaded file; a stored placement mockup stays alongside as its own source
  db.prepare('UPDATE production_assets SET replaced_at = ? WHERE quote_id = ? AND slot_key = ? AND kind = ? AND source = ? AND replaced_at IS NULL').run(now, quote.id, slotKey, kind, source);
  const id = db.prepare(`INSERT INTO production_assets (quote_id, slot_key, kind, source, original_filename, stored_filename, mime_type, size_bytes, uploaded_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(quote.id, slotKey, kind, source, String(originalName).slice(0, 200), storedFilename, MIME_BY_EXT[ext] || 'application/octet-stream', buffer.length, uploadedBy || null, now).lastInsertRowid;
  return assetById(id);
}
/** Takes a mockup or print-ready file out of its slot. The file stays on disk as history. */
function retireAsset(asset) {
  db.prepare('UPDATE production_assets SET replaced_at = ? WHERE id = ?').run(new Date().toISOString(), asset.id);
}

// ------------------------------------------------------------------ slots
function fileRef(f) {
  return { id: f.id, name: f.original_filename, mime: f.mime_type, sizeBytes: f.size_bytes, status: f.status, uploadedAt: f.uploaded_at,
    path: path.join(storage.UPLOAD_DIR, path.basename(f.stored_filename)), viewUrl: `/api/admin/production/artwork/${f.id}/file`, previewUrl: `/api/admin/production/preview/artwork/${f.id}` };
}
function assetRef(a) {
  return { id: a.id, name: a.original_filename, mime: a.mime_type, sizeBytes: a.size_bytes, source: a.source, uploadedBy: a.uploaded_by, uploadedAt: a.created_at,
    path: assetPath(a), viewUrl: `/api/admin/production/assets/${a.id}/file`, previewUrl: `/api/admin/production/preview/asset/${a.id}`, removable: true };
}
const inches = (n) => `${Math.round(Number(n) * 100) / 100}`;
const DESIGN_SIZE_LABEL = { chest: 'Left chest size', standard: 'Standard', large: 'Large graphic', oversized: 'Oversized' };

/**
 * The order broken into items and print slots, each with its three assets.
 * Returns { items: [{ label, product, ..., slots: [{ key, label, dimensions, customerArtwork[], mockups[], printReady }] }], references[], orderMockups[] }.
 */
function slotsFor(quote) {
  const snap = parseJson(quote.pricing_snapshot, {});
  const files = db.prepare('SELECT * FROM artwork_files WHERE quote_id = ? ORDER BY id').all(quote.id);
  const assets = currentAssets(quote.id);
  const notes = parseJson(quote.slot_notes_json, {});
  const mockupAssets = (key) => assets.filter(a => a.slot_key === key && a.kind === 'mockup').map(a => ({ ...assetRef(a), sourceLabel: a.source === 'placement' ? "Customer's placement" : 'Uploaded by the shop' }));
  const printReady = (key) => { const a = assets.filter(x => x.slot_key === key && x.kind === 'print_ready').pop(); return a ? assetRef(a) : null; };
  const references = files.filter(f => f.location_name === 'Reference').map(fileRef);
  const orderMockups = db.prepare('SELECT * FROM mockups WHERE quote_id = ? ORDER BY id DESC').all(quote.id).map(m => ({
    id: 'sent-' + m.id, name: m.original_filename, mime: m.mime_type, sizeBytes: m.size_bytes, path: path.join(storage.UPLOAD_DIR, path.basename(m.stored_filename)),
    viewUrl: `/api/admin/production/sent-mockups/${m.id}/file`, previewUrl: `/api/admin/production/sent-mockups/${m.id}/file`,
    sourceLabel: `Sent for approval: ${{ pending_customer: 'awaiting customer', approved: 'approved', changes_requested: 'changes requested' }[m.status] || m.status}`, status: m.status, customerNote: m.customer_note, uploadedAt: m.uploaded_at,
  }));

  const items = [];
  if (snap.printOrder) {
    // ---- print products: one item per configured design; its slots are the artwork sides that were uploaded ----
    const list = Array.isArray(snap.printOrder.items) && snap.printOrder.items.length ? snap.printOrder.items : [snap.printOrder];
    const multi = list.length > 1 || !!snap.printOrder.multi;
    list.forEach((it, i) => {
      const prefix = multi && it.label ? `${it.label} - ` : '';
      const mine = files.filter(f => f.location_name !== 'Reference' && (prefix ? String(f.location_name || '').startsWith(prefix) : true));
      const sideOf = (f) => (prefix ? String(f.location_name || '').slice(prefix.length) : String(f.location_name || 'Artwork')) || 'Artwork';
      const artwork = mine.filter(f => !isProof(f.location_name));
      const proofs = mine.filter(f => isProof(f.location_name));
      const sides = [...new Set(artwork.map(sideOf))];
      if (!sides.length) sides.push('Artwork');
      const placements = it.placements || {};
      items.push({
        label: it.label || snap.printOrder.familyName || 'Item', product: it.productName, brandStyle: '', colors: [], sizeBreakdown: it.sizeLabel, quantity: it.qty, unit: it.unit || 'piece',
        printMethod: [snap.printOrder.familyName || 'Print', ...(it.options || []).map(o => `${o.group}: ${o.choice}`)].join(' · '),
        details: [
          it.orientation ? `Orientation: ${it.orientation}` : '', it.border != null ? `White border: ${it.border > 0 ? it.border + ' in' : 'none'}` : '',
          it.backArtwork ? `Back: ${it.backArtwork === 'different' ? 'different artwork' : 'same as front'}` : '',
          ...(it.addons || []).map(a => `Add-on: ${a.name}`), it.includeMisprints ? 'Include usable misprints' : '',
          it.design && it.design.method !== 'upload' ? `Design: ${it.design.methodLabel}${it.design.templateName ? ` (${it.design.templateName})` : ''}` : '',
        ].filter(Boolean),
        designBrief: it.design && it.design.brief && Object.keys(it.design.brief).length ? it.design.brief : null,
        slots: sides.map((side, s) => {
          const key = `item${i + 1}-${slug(side).toLowerCase()}`;
          const sideKey = /back/i.test(side) ? 'back' : 'front';
          const pl = placements[sideKey];
          const sideProofs = proofs.filter(f => { const rest = sideOf(f); return /back/i.test(rest) === /back/i.test(side) || proofs.length === 1 || (s === 0 && !/back/i.test(rest)); });
          return {
            key, label: side, fullLabel: `${it.label || it.productName} / ${side}`,
            dimensions: it.canvas ? `${inches(it.canvas.width)} × ${inches(it.canvas.height)} in print area` + (pl && pl.scale != null ? `, artwork at ${Math.round(pl.scale * 100)}% scale` : '') : (it.sizeLabel || ''),
            customerArtwork: artwork.filter(f => sideOf(f) === side).map(fileRef),
            mockups: [...sideProofs.map(f => ({ ...fileRef(f), sourceLabel: 'Approved by the customer in the order form' })), ...mockupAssets(key)],
            printReady: printReady(key), note: notes[key] || '',
          };
        }),
      });
    });
  } else {
    // ---- apparel: one item (the garment, in its colors and sizes); one slot per print location ----
    const garment = db.prepare('SELECT * FROM garments WHERE id = ?').get(quote.garment_id) || {};
    const lines = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id').all(quote.id);
    const byColor = new Map();
    for (const l of lines) { if (!byColor.has(l.color_name)) byColor.set(l.color_name, []); byColor.get(l.color_name).push(`${l.size_label}-${l.quantity}`); }
    const locations = db.prepare('SELECT qpl.*, pl.code FROM quote_print_locations qpl LEFT JOIN print_locations pl ON pl.id = qpl.print_location_id WHERE qpl.quote_id = ? ORDER BY qpl.id').all(quote.id);
    const placements = parseJson(quote.placements_json, []);
    items.push({
      label: (snap.garment && snap.garment.name) || garment.name || 'Garment',
      product: quote.custom_garment_description || garment.name || (snap.garment && snap.garment.name),
      brandStyle: [garment.brand, garment.style_number].filter(Boolean).join(' ') || '',
      colors: [...byColor.keys()],
      sizeBreakdown: [...byColor.entries()].map(([color, sizes]) => `${color}: ${sizes.join(' / ')}`).join('\n'),
      quantity: snap.totalQty, unit: 'piece',
      printMethod: snap.decoration ? snap.decoration.label : 'DTF Print',
      details: [quote.customer_supplied_garment ? 'Customer is supplying the garments' : ''].filter(Boolean),
      designBrief: null,
      slots: locations.map(loc => {
        const key = `loc-${loc.print_location_id}`;
        const p = placements.find(x => x.locationName === loc.location_name || (loc.code && x.locationCode === loc.code));
        return {
          key, label: loc.location_name, fullLabel: `${(snap.garment && snap.garment.name) || 'Garment'} / ${loc.location_name}`,
          dimensions: p
            ? `${inches(p.widthIn)} × ${inches(p.heightIn)} in, ${inches(p.fromLeftIn)} in from left and ${inches(p.fromTopIn)} in from top of the ${inches(p.zoneWidthIn)} × ${inches(p.zoneHeightIn)} in print area`
            : `${DESIGN_SIZE_LABEL[loc.design_size] || 'Standard'} design size (customer did not place the artwork)`,
          placement: p || null,
          customerArtwork: files.filter(f => f.location_name !== 'Reference' && !isProof(f.location_name) && (f.print_location_id === loc.print_location_id || f.location_name === loc.location_name)).map(fileRef),
          mockups: mockupAssets(key), printReady: printReady(key), note: notes[key] || '',
        };
      }),
    });
  }
  return { items, references, orderMockups };
}

// ------------------------------------------------------------------ production status
// Independent of Shopify's payment and fulfillment statuses. The later stages
// follow the order's own status; the early ones follow the artwork and the
// print-ready files. Declined artwork is a flag on the artwork, never a stage.
const STAGES = ['Artwork Pending', 'Artwork Approved', 'Print Ready', 'In Production', 'Ready for Pickup', 'Completed'];
function productionStatus(quote, breakdown) {
  const slots = breakdown.items.flatMap(it => it.slots);
  const artwork = slots.flatMap(s => s.customerArtwork);
  const declined = artwork.filter(f => f.status === 'declined').length;
  let stage;
  if (quote.status === 'completed') stage = 'Completed';
  else if (quote.status === 'ready_for_pickup' || quote.status === 'shipped') stage = 'Ready for Pickup';
  else if (quote.status === 'in_production') stage = 'In Production';
  else if (slots.length && slots.every(s => s.printReady)) stage = 'Print Ready';
  else if (artwork.length && artwork.every(f => APPROVED.includes(f.status))) stage = 'Artwork Approved';
  else stage = 'Artwork Pending';
  return {
    stage, stages: STAGES, index: STAGES.indexOf(stage),
    label: stage === 'Ready for Pickup' && quote.status === 'shipped' ? 'Shipped' : stage,
    declinedArtwork: declined,
    printReadyCount: slots.filter(s => s.printReady).length, slotCount: slots.length,
  };
}

// ------------------------------------------------------------------ the whole job ticket
function publicRef(ref) { if (!ref) return ref; const { path: _hidden, ...rest } = ref; return rest; }
function orderName(quote) { return quote.shopify_order_number || null; }
function fileBase(quote) {
  const number = String(orderName(quote) || '').replace(/[^0-9A-Za-z]/g, '');
  return `${number ? `Order-${number}_` : ''}${quote.quote_code}`;
}
/** Everything the job ticket page, the PDF and the ZIP are built from. `withPaths` keeps the on-disk paths (server use only). */
async function ticket(quote, { withPaths = false } = {}) {
  await ensurePlacementMockups(quote).catch(err => console.error('[production] placement mockups:', err.message));
  quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quote.id);
  const snap = parseJson(quote.pricing_snapshot, {});
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id) || {};
  const breakdown = slotsFor(quote);
  const checkout = computeCheckout(snap.total, { rushRule: snap.rushRule, rush: !!quote.rush, paymentOption: quote.payment_option, shipping: quote.fulfillment_method === 'shipping' });
  const address = parseJson(quote.shipping_address, null);
  const strip = (list) => withPaths ? list : list.map(publicRef);
  const paid = quote.paid_at ? (Number(quote.balance_due) > 0.009 ? `Deposit paid ($${Number(quote.amount_paid).toFixed(2)}), balance $${Number(quote.balance_due).toFixed(2)} due` : `Paid in full ($${Number(quote.amount_paid || 0).toFixed(2)})`) : 'Not paid';
  return {
    orderNumber: orderName(quote), quoteCode: quote.quote_code, fileBase: fileBase(quote),
    revision: quote.production_revision || 1,
    orderStatus: quote.status, production: productionStatus(quote, breakdown),
    customer: { id: customer.id, name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(), email: customer.email, phone: customer.phone, business: customer.business_name || '' },
    orderDate: quote.created_at, paidAt: quote.paid_at, dueDate: quote.needed_by_date || '',
    fulfillment: quote.fulfillment_method === 'shipping' ? `Shipping${address ? `: ${address.line1}${address.line2 ? ', ' + address.line2 : ''}, ${address.city}, ${address.state} ${address.zip}` : ''}` : 'Local pickup',
    rush: !!quote.rush, paymentStatus: paid, orderPurpose: quote.event_name || '',
    customerNotes: quote.notes || '', designNotes: quote.design_notes || '', productionNotes: quote.production_notes || '',
    reorderOf: quote.reorder_source_quote_id ? (db.prepare('SELECT quote_code FROM quotes WHERE id = ?').get(quote.reorder_source_quote_id) || {}).quote_code : null,
    pricing: {
      unit: snap.finalBaseUnit, base: snap.baseLineTotal, lines: (snap.addonLines || []).map(l => ({ name: l.name, total: l.total })), sizeSurcharges: snap.sizeSurchargeTotal || 0,
      designSize: (snap.designSizeLines || []).map(l => ({ name: `${l.locationName}: ${l.designSizeLabel}`, total: l.total })),
      discount: snap.discount ? { code: snap.discount.code, amount: snap.discountAmount } : null,
      orderTotal: checkout.orderTotal, rushFee: checkout.rushFee, tax: checkout.taxAmount, shipping: checkout.shippingFee, grandTotal: checkout.grandTotal,
    },
    items: breakdown.items.map(it => ({ ...it, slots: it.slots.map(s => ({ ...s, customerArtwork: strip(s.customerArtwork), mockups: strip(s.mockups), printReady: withPaths ? s.printReady : publicRef(s.printReady) })) })),
    references: strip(breakdown.references), orderMockups: strip(breakdown.orderMockups),
    links: {
      viewQuote: `/admin/orders/${quote.quote_code}`, editQuote: `/admin/orders/${quote.quote_code}/edit`, mockups: `/admin/orders/${quote.quote_code}/mockups`,
      printReady: `/admin/orders/${quote.quote_code}/print-ready`, productionPdf: `/admin/orders/${quote.quote_code}/production.pdf`, allFiles: `/admin/orders/${quote.quote_code}/files.zip`,
      customerQuotePage: `/quote.html?id=${encodeURIComponent(quote.quote_code)}`,
    },
  };
}

function saveNotes(quote, { productionNotes, dueDate, slotNotes }) {
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const notes = parseJson(quote.slot_notes_json, {});
  if (slotNotes && typeof slotNotes === 'object') for (const [key, value] of Object.entries(slotNotes).slice(0, 200)) { if (/^[a-z0-9-]{1,60}$/.test(key)) notes[key] = text(value, 600); }
  const due = dueDate === undefined ? quote.needed_by_date : (text(dueDate, 10) || null);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new ProductionError('Enter the due date as a date.');
  db.prepare('UPDATE quotes SET production_notes = ?, slot_notes_json = ?, needed_by_date = ? WHERE id = ?')
    .run(productionNotes === undefined ? quote.production_notes : text(productionNotes, 4000), JSON.stringify(notes), due, quote.id);
  bumpRevision(quote.id);
}

// ------------------------------------------------------------------ images: sizes, previews, stored mockups
function imageSize(buffer) {
  try {
    if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let i = 2;
      while (i < buffer.length - 9) {
        if (buffer[i] !== 0xFF) { i++; continue; }
        const marker = buffer[i + 1];
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) return { w: buffer.readUInt16BE(i + 7), h: buffer.readUInt16BE(i + 5) };
        i += 2 + buffer.readUInt16BE(i + 2);
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}
let resvgReady = null;
let fontBuffers = [];
function resvg() {
  if (!resvgReady) {
    resvgReady = (async () => {
      const lib = require('@resvg/resvg-wasm');
      await lib.initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
      // SVG artwork with live (un-outlined) text needs a font to draw with: use whatever the server has.
      for (const p of ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:\\Windows\\Fonts\\arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']) {
        try { if (fs.existsSync(p)) fontBuffers.push(new Uint8Array(fs.readFileSync(p))); } catch (e) { /* optional */ }
      }
      return lib;
    })();
  }
  return resvgReady;
}
async function renderSvg(svg, width) {
  const lib = await resvg();
  const r = new lib.Resvg(svg, { fitTo: { mode: 'width', value: Math.max(16, Math.round(width)) }, font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } });
  const out = r.render();
  const png = Buffer.from(out.asPng());
  const size = { w: out.width, h: out.height };
  out.free(); r.free();
  return { png, size };
}
const dataUri = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`;

const PREVIEW_WIDTH = 1400;
/**
 * A PNG preview of a file, for the admin pages and the production PDF. Made
 * once and cached; the file it is made from is only read, never changed.
 * Returns { path, size } or null when the format cannot be previewed (PDF, PSD, AI, TIFF...).
 */
async function previewOf(kind, id, filePath, mime) {
  const cached = path.join(ASSET_DIR, `preview-${kind}-${id}.png`);
  if (fs.existsSync(cached)) return { path: cached, size: imageSize(fs.readFileSync(cached)) };
  if (!fs.existsSync(filePath) || !['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'].includes(mime)) return null;
  try {
    const buffer = fs.readFileSync(filePath);
    let result;
    if (mime === 'image/svg+xml') {
      result = await renderSvg(buffer, PREVIEW_WIDTH);
    } else {
      const size = imageSize(buffer) || { w: PREVIEW_WIDTH, h: PREVIEW_WIDTH };
      const w = Math.min(size.w, PREVIEW_WIDTH), h = Math.round(w * size.h / size.w);
      result = await renderSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image href="${dataUri(mime === 'image/jpg' ? 'image/jpeg' : mime, buffer)}" width="${w}" height="${h}"/></svg>`, w);
    }
    fs.writeFileSync(cached, result.png);
    return { path: cached, size: result.size };
  } catch (err) {
    console.error(`[production] preview of ${kind} ${id} failed:`, err.message);
    return null;
  }
}

const failedMockups = new Map(); // "quoteId:slot" -> when the last attempt failed, so a broken photo link is not retried on every page load
async function fetchImage(url) {
  if (/^\/uploads\//.test(url)) {
    const p = path.join(storage.UPLOAD_DIR, path.basename(url));
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  if (!/^https:\/\/(www|cdn)\.ssactivewear\.com\//i.test(url)) return null; // the only outside host garment photos come from
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return resp.ok ? Buffer.from(await resp.arrayBuffer()) : null;
}
/**
 * Apparel: turns each placement the customer made (artwork positioned on the
 * garment photo) into a stored PNG mockup, once. After that the mockup is a
 * file of its own and no longer depends on the browser or on the garment's
 * current photo or print-area settings.
 */
async function ensurePlacementMockups(quote) {
  const placements = parseJson(quote.placements_json, []);
  if (!placements.length) return 0;
  const locations = db.prepare('SELECT qpl.print_location_id, qpl.location_name, pl.code FROM quote_print_locations qpl LEFT JOIN print_locations pl ON pl.id = qpl.print_location_id WHERE qpl.quote_id = ?').all(quote.id);
  let made = 0;
  for (const p of placements) {
    const loc = locations.find(l => l.location_name === p.locationName || (l.code && l.code === p.locationCode));
    if (!loc || !p.zone || !p.design) continue;
    const slotKey = `loc-${loc.print_location_id}`;
    if (db.prepare("SELECT 1 FROM production_assets WHERE quote_id = ? AND slot_key = ? AND kind = 'mockup' AND source = 'placement'").get(quote.id, slotKey)) continue; // made before (even if since removed)
    const failKey = `${quote.id}:${slotKey}`;
    if (Date.now() - (failedMockups.get(failKey) || 0) < 15 * 60 * 1000) continue;
    try {
      const [photo, art] = await Promise.all([fetchImage(p.imageUrl), fetchImage(p.artworkUrl)]);
      const size = photo && imageSize(photo);
      if (!photo || !size || !art) throw new Error('garment photo or artwork not available');
      const artMime = MIME_BY_EXT[path.extname(p.artworkUrl).toLowerCase()];
      if (!['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'].includes(artMime)) throw new Error('artwork format cannot be drawn on a mockup');
      const W = Math.min(size.w, 1100), H = Math.round(W * size.h / size.w);
      const px = (r) => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
      const z = px(p.zone), d = px(p.design);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <image href="${dataUri(photo[0] === 0xFF ? 'image/jpeg' : 'image/png', photo)}" width="${W}" height="${H}"/>
        <rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="none" stroke="#ffffff" stroke-opacity="0.9" stroke-width="2" stroke-dasharray="8 6"/>
        <rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" fill="none" stroke="#000000" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="8 6"/>
        <image href="${dataUri(artMime, art)}" x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" preserveAspectRatio="xMidYMid meet"/>
      </svg>`;
      const { png } = await renderSvg(svg, W);
      saveAsset(quote, { slotKey, kind: 'mockup', source: 'placement', originalName: `${slug(p.locationName)}-Mockup.png`, buffer: png, uploadedBy: 'Customer placement' });
      made++;
    } catch (err) {
      failedMockups.set(failKey, Date.now());
      console.error(`[production] mockup for #${quote.quote_code} ${p.locationName}:`, err.message);
    }
  }
  return made;
}

module.exports = {
  ASSET_DIR, KINDS, STAGES, ProductionError, saveAsset, retireAsset, assetById, assetPath, bumpRevision, logEvent,
  slotsFor, productionStatus, ticket, saveNotes, previewOf, imageSize, ensurePlacementMockups, fileBase, slug, parseJson, MIME_BY_EXT,
};
