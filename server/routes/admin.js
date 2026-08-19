// server/routes/admin.js
// Owner/admin backend: auth, quotes/orders management, garments, pricing
// matrix, print locations, customers, settings. Everything here requires
// requireAdmin (session cookie) except /login.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/adminAuth');
const { calculateQuote, marginStatus, getSetting, round2, PricingError } = require('../pricingEngine');
const emailService = require('../services/emailService');

const router = express.Router();

const VALID_STATUSES = [
  'draft','quote_generated','quote_viewed','checkout_started','paid','needs_review',
  'artwork_issue','awaiting_customer','approved','in_production','ready_for_pickup',
  'shipped','completed','cancelled','refunded',
];
const ARTWORK_STATUSES = ['pending_review','approved','needs_changes','customer_revision_requested','production_ready'];

// -------------------------------------------------------------------- auth
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  req.session.adminId = admin.id;
  req.session.adminName = admin.display_name || admin.username;
  res.json({ ok: true, displayName: req.session.adminName });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.adminId) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ displayName: req.session.adminName });
});

router.use(requireAdmin);

// --------------------------------------------------------------- dashboard
router.get('/dashboard', (req, res) => {
  const stats = {
    quotesTotal: db.prepare('SELECT COUNT(*) c FROM quotes').get().c,
    quotesGeneratedNotPaid: db.prepare(`SELECT COUNT(*) c FROM quotes WHERE status IN ('quote_generated','quote_viewed','checkout_started')`).get().c,
    paidOrders: db.prepare(`SELECT COUNT(*) c FROM quotes WHERE status NOT IN ('draft','quote_generated','quote_viewed','checkout_started','cancelled') AND paid_at IS NOT NULL`).get().c,
    needsReview: db.prepare(`SELECT COUNT(*) c FROM quotes WHERE status='needs_review'`).get().c,
    revenue30d: db.prepare(`SELECT COALESCE(SUM(amount_paid),0) s FROM quotes WHERE paid_at IS NOT NULL AND paid_at >= datetime('now','-30 days')`).get().s,
    abandonedLast7d: db.prepare(`SELECT COUNT(*) c FROM quotes WHERE paid_at IS NULL AND status NOT IN ('draft','cancelled') AND created_at >= datetime('now','-7 days')`).get().c,
  };
  const recentQuotes = db.prepare(`SELECT q.quote_code, q.status, q.total, q.created_at, c.first_name, c.last_name
    FROM quotes q JOIN customers c ON c.id=q.customer_id ORDER BY q.created_at DESC LIMIT 10`).all();
  res.json({ stats, recentQuotes });
});

// ------------------------------------------------------------------ quotes
router.get('/quotes', (req, res) => {
  const { status, q } = req.query;
  let sql = `SELECT qt.*, c.first_name, c.last_name, c.email, c.phone FROM quotes qt JOIN customers c ON c.id = qt.customer_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND qt.status = ?'; params.push(status); }
  if (q) { sql += ' AND (qt.quote_code LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ?)'; const like = `%${q}%`; params.push(like, like, like, like); }
  sql += ' ORDER BY qt.created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  res.json({ quotes: rows.map(summarizeQuoteRow) });
});

router.get('/orders', (req, res) => {
  // "Paid Orders" nav = quotes that have been paid, regardless of production status
  const rows = db.prepare(`SELECT qt.*, c.first_name, c.last_name, c.email, c.phone FROM quotes qt
    JOIN customers c ON c.id = qt.customer_id WHERE qt.paid_at IS NOT NULL ORDER BY qt.paid_at DESC LIMIT 200`).all();
  res.json({ orders: rows.map(summarizeQuoteRow) });
});

router.get('/quotes/:code', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);
  const printLocations = db.prepare('SELECT * FROM quote_print_locations WHERE quote_id = ?').all(quote.id);
  const artwork = db.prepare('SELECT * FROM artwork_files WHERE quote_id = ?').all(quote.id);
  const events = db.prepare('SELECT * FROM quote_events WHERE quote_id = ? ORDER BY created_at DESC').all(quote.id);
  const snapshot = JSON.parse(quote.pricing_snapshot);

  res.json({
    quote: { ...quote, pricing_snapshot: undefined },
    customer, items, printLocations,
    artwork: artwork.map(f => ({ ...f, url: `/uploads/${f.stored_filename}` })),
    events,
    pricing: snapshot, // FULL internal pricing incl. cost/margin — admin only
  });
});

router.patch('/quotes/:code/status', (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  const previousStatus = quote.status;
  db.prepare('UPDATE quotes SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), quote.id);
  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'status_change', ?)`)
    .run(quote.id, `${previousStatus} -> ${status} (by ${req.session.adminName})`);

  // Email the customer for statuses worth notifying them about (sendStatusUpdateEmail
  // itself no-ops for internal statuses like quote_generated/quote_viewed). Never
  // block the status update on email delivery.
  if (status !== previousStatus) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    emailService.sendStatusUpdateEmail({ ...quote, status }, customer, baseUrl, status)
      .catch(err => console.error('Status update email failed:', err));
  }

  res.json({ ok: true });
});

router.patch('/quotes/:code/artwork-status', (req, res) => {
  const { status, fileId } = req.body;
  if (!ARTWORK_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid artwork status.' });
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  if (fileId) {
    db.prepare('UPDATE artwork_files SET status=? WHERE id=? AND quote_id=?').run(status, fileId, quote.id);
  } else {
    db.prepare('UPDATE artwork_files SET status=? WHERE quote_id=?').run(status, quote.id);
    db.prepare('UPDATE quotes SET artwork_status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), quote.id);
  }
  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'status_change', ?)`)
    .run(quote.id, `Artwork ${fileId ? 'file' : 'overall'} -> ${status} (by ${req.session.adminName})`);
  res.json({ ok: true });
});

// ------------------------------------------------------------- price override
router.post('/quotes/:code/override', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  const snapshot = JSON.parse(quote.pricing_snapshot);

  const { adjustment, overrideUnitPrice, confirmedBelowFloor, note } = req.body;
  const floorUnit = snapshot.floorUnit;

  let discretionaryAdjustment = Number(adjustment) || 0;
  let floorOverride = 0;
  let finalOverrideUnitPrice = null;

  if (overrideUnitPrice != null && overrideUnitPrice !== '') {
    const requested = Number(overrideUnitPrice);
    if (requested < floorUnit - 0.0001) {
      if (!confirmedBelowFloor) {
        return res.status(409).json({
          error: 'BELOW_FLOOR_CONFIRMATION_REQUIRED',
          message: 'This price is below your approved floor. Confirm to override.',
          floorUnit, requested,
        });
      }
      floorOverride = 1;
      finalOverrideUnitPrice = requested;
    } else {
      discretionaryAdjustment = round2(snapshot.standardUnit - requested);
    }
  }

  const recalculated = calculateQuote({
    garmentId: snapshot.garment.id,
    colorSelections: itemsToSelections(quote.id),
    printLocationIds: db.prepare('SELECT print_location_id FROM quote_print_locations WHERE quote_id=?').all(quote.id).map(r => r.print_location_id),
    discretionaryAdjustment,
    floorOverride: !!floorOverride,
    overrideUnitPrice: finalOverrideUnitPrice,
  }, snapshot.pricingTablesSnapshot);

  db.prepare(`UPDATE quotes SET discretionary_adjustment=?, discretionary_adjustment_note=?, floor_override=?, override_unit_price=?,
    pricing_snapshot=?, subtotal=?, total=?, updated_at=? WHERE id=?`)
    .run(discretionaryAdjustment, note || null, floorOverride, finalOverrideUnitPrice, JSON.stringify(recalculated),
      recalculated.subtotal, recalculated.total, new Date().toISOString(), quote.id);

  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'override', ?)`)
    .run(quote.id, `${req.session.adminName} set price to $${recalculated.finalBaseUnit.toFixed(2)}/unit` + (floorOverride ? ' [BELOW FLOOR — confirmed]' : '') + (note ? ` — ${note}` : ''));

  res.json({ ok: true, pricing: recalculated });
});

// --------------------------------------------------------------- customers
router.get('/customers', (req, res) => {
  const { q } = req.query;
  let sql = `SELECT c.*,
      (SELECT COUNT(*) FROM quotes WHERE customer_id=c.id) as quote_count,
      (SELECT COUNT(*) FROM quotes WHERE customer_id=c.id AND paid_at IS NOT NULL) as order_count,
      (SELECT COALESCE(SUM(amount_paid),0) FROM quotes WHERE customer_id=c.id AND paid_at IS NOT NULL) as lifetime_value
    FROM customers c WHERE 1=1`;
  const params = [];
  if (q) { sql += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)'; const like = `%${q}%`; params.push(like, like, like); }
  sql += ' ORDER BY c.created_at DESC LIMIT 300';
  res.json({ customers: db.prepare(sql).all(...params) });
});

// ---------------------------------------------------------------- garments
router.get('/garments', (req, res) => {
  const garments = db.prepare('SELECT * FROM garments ORDER BY sort_order, id').all();
  res.json({ garments: garments.map(g => ({
    ...g,
    colors: db.prepare('SELECT * FROM garment_colors WHERE garment_id=? ORDER BY sort_order').all(g.id),
    sizes: db.prepare('SELECT * FROM garment_sizes WHERE garment_id=? ORDER BY sort_order').all(g.id),
  })) });
});

router.post('/garments', (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO garments (name,brand,style_number,description,image_url,internal_cost,customer_price_adjustment,active,sort_order)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    b.name || 'New Garment', b.brand || '', b.styleNumber || '', b.description || '', b.imageUrl || '',
    Number(b.internalCost) || 0, Number(b.customerPriceAdjustment) || 0, b.active === false ? 0 : 1, Number(b.sortOrder) || 0);
  res.json({ id: info.lastInsertRowid });
});

router.put('/garments/:id', (req, res) => {
  const b = req.body;
  const exists = db.prepare('SELECT id FROM garments WHERE id=?').get(req.params.id);
  if (!exists) return res.status(404).json({ error: 'Garment not found.' });
  db.prepare(`UPDATE garments SET name=?, brand=?, style_number=?, description=?, image_url=?, internal_cost=?,
    customer_price_adjustment=?, active=?, sort_order=?, updated_at=? WHERE id=?`)
    .run(b.name, b.brand || '', b.styleNumber || '', b.description || '', b.imageUrl || '', Number(b.internalCost) || 0,
      Number(b.customerPriceAdjustment) || 0, b.active === false ? 0 : 1, Number(b.sortOrder) || 0, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

router.delete('/garments/:id', (req, res) => {
  db.prepare('UPDATE garments SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/garments/:id/colors', (req, res) => {
  const b = req.body;
  const info = db.prepare('INSERT INTO garment_colors (garment_id,name,hex,image_url,active,sort_order) VALUES (?,?,?,?,?,?)')
    .run(req.params.id, b.name || 'New Color', b.hex || '#000000', b.imageUrl || '', b.active === false ? 0 : 1, Number(b.sortOrder) || 0);
  res.json({ id: info.lastInsertRowid });
});
router.put('/colors/:id', (req, res) => {
  const b = req.body;
  db.prepare('UPDATE garment_colors SET name=?, hex=?, image_url=?, active=?, sort_order=? WHERE id=?')
    .run(b.name, b.hex, b.imageUrl || '', b.active === false ? 0 : 1, Number(b.sortOrder) || 0, req.params.id);
  res.json({ ok: true });
});
router.delete('/colors/:id', (req, res) => {
  db.prepare('DELETE FROM garment_colors WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/garments/:id/sizes', (req, res) => {
  const b = req.body;
  const info = db.prepare('INSERT INTO garment_sizes (garment_id,label,surcharge,active,sort_order) VALUES (?,?,?,?,?)')
    .run(req.params.id, b.label || 'New Size', Number(b.surcharge) || 0, b.active === false ? 0 : 1, Number(b.sortOrder) || 0);
  res.json({ id: info.lastInsertRowid });
});
router.put('/sizes/:id', (req, res) => {
  const b = req.body;
  db.prepare('UPDATE garment_sizes SET label=?, surcharge=?, active=?, sort_order=? WHERE id=?')
    .run(b.label, Number(b.surcharge) || 0, b.active === false ? 0 : 1, Number(b.sortOrder) || 0, req.params.id);
  res.json({ ok: true });
});
router.delete('/sizes/:id', (req, res) => {
  db.prepare('DELETE FROM garment_sizes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ----------------------------------------------------------------- pricing
router.get('/pricing-tiers', (req, res) => {
  res.json({ tiers: db.prepare('SELECT * FROM pricing_tiers ORDER BY quantity').all() });
});
router.put('/pricing-tiers/:qty', (req, res) => {
  const qty = Number(req.params.qty);
  const { standardPrice, hardFloorPrice } = req.body;
  if (!qty || qty < 1 || qty > 24) return res.status(400).json({ error: 'Quantity must be 1-24.' });
  if (Number(hardFloorPrice) > Number(standardPrice)) return res.status(400).json({ error: 'Hard floor cannot exceed standard price.' });
  db.prepare('UPDATE pricing_tiers SET standard_price=?, hard_floor_price=?, updated_at=? WHERE quantity=?')
    .run(Number(standardPrice), Number(hardFloorPrice), new Date().toISOString(), qty);
  res.json({ ok: true });
});

router.get('/cost-settings', (req, res) => {
  const keys = ['blank_cost','front_transfer_cost','labor_cost','back_transfer_cost'];
  const rows = db.prepare(`SELECT key,value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`).all(...keys);
  res.json({ costs: Object.fromEntries(rows.map(r => [r.key, Number(r.value)])) });
});
router.put('/cost-settings', (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
  const now = new Date().toISOString();
  for (const key of ['blank_cost','front_transfer_cost','labor_cost','back_transfer_cost']) {
    if (req.body[key] != null) upsert.run(key, String(Number(req.body[key])), now);
  }
  res.json({ ok: true });
});

// -------------------------------------------------------- print locations
router.get('/print-locations', (req, res) => {
  const locations = db.prepare('SELECT * FROM print_locations ORDER BY sort_order').all();
  res.json({ printLocations: locations.map(l => ({
    ...l,
    pricing: db.prepare('SELECT quantity, addon_price FROM print_location_pricing WHERE print_location_id=? ORDER BY quantity').all(l.id),
  })) });
});
router.post('/print-locations', (req, res) => {
  const b = req.body;
  const code = (b.code || b.name || 'location').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
  const info = db.prepare(`INSERT INTO print_locations (name,code,included_in_base,internal_cost_per_unit,active,sort_order)
    VALUES (?,?,?,?,?,?)`).run(b.name || 'New Location', code, b.includedInBase ? 1 : 0, Number(b.internalCostPerUnit) || 0, 1, Number(b.sortOrder) || 99);
  const locId = info.lastInsertRowid;
  const insPricing = db.prepare('INSERT INTO print_location_pricing (print_location_id, quantity, addon_price) VALUES (?,?,?)');
  for (let q = 1; q <= 24; q++) insPricing.run(locId, q, b.includedInBase ? 0 : (Number(b.defaultAddon) || 0));
  res.json({ id: locId });
});
router.put('/print-locations/:id', (req, res) => {
  const b = req.body;
  db.prepare('UPDATE print_locations SET name=?, included_in_base=?, internal_cost_per_unit=?, active=?, sort_order=? WHERE id=?')
    .run(b.name, b.includedInBase ? 1 : 0, Number(b.internalCostPerUnit) || 0, b.active === false ? 0 : 1, Number(b.sortOrder) || 0, req.params.id);
  res.json({ ok: true });
});
router.delete('/print-locations/:id', (req, res) => {
  db.prepare('UPDATE print_locations SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
router.put('/print-locations/:id/pricing/:qty', (req, res) => {
  const { addonPrice } = req.body;
  db.prepare(`INSERT INTO print_location_pricing (print_location_id, quantity, addon_price) VALUES (?,?,?)
    ON CONFLICT(print_location_id, quantity) DO UPDATE SET addon_price=excluded.addon_price`)
    .run(req.params.id, Number(req.params.qty), Number(addonPrice));
  res.json({ ok: true });
});

// ------------------------------------------------------------------ artwork
router.get('/artwork', (req, res) => {
  const { status } = req.query;
  let sql = `SELECT af.*, q.quote_code, c.first_name, c.last_name FROM artwork_files af
    JOIN quotes q ON q.id = af.quote_id JOIN customers c ON c.id = q.customer_id WHERE af.quote_id IS NOT NULL`;
  const params = [];
  if (status) { sql += ' AND af.status = ?'; params.push(status); }
  sql += ' ORDER BY af.uploaded_at DESC LIMIT 300';
  const rows = db.prepare(sql).all(...params);
  res.json({ artwork: rows.map(f => ({ ...f, url: `/uploads/${f.stored_filename}` })) });
});

// ------------------------------------------------------------------ emails
router.get('/emails', (req, res) => {
  res.json({ emails: db.prepare('SELECT id, quote_id, to_email, subject, provider, sent_at FROM emails_sent ORDER BY sent_at DESC LIMIT 200').all() });
});
router.get('/emails/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM emails_sent WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json({ email: row });
});

// ----------------------------------------------------------------- settings
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});
router.put('/settings', (req, res) => {
  const upsert = db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(req.body || {})) upsert.run(k, String(v), now);
  res.json({ ok: true });
});

router.post('/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!bcrypt.compareSync(currentPassword || '', admin.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), admin.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ helpers
function itemsToSelections(quoteId) {
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);
  const byColor = {};
  for (const it of items) {
    byColor[it.color_name] = byColor[it.color_name] || { colorName: it.color_name, colorHex: it.color_hex, sizes: [] };
    byColor[it.color_name].sizes.push({ label: it.size_label, qty: it.quantity });
  }
  return Object.values(byColor);
}

function summarizeQuoteRow(q) {
  let snapshot = {};
  try { snapshot = JSON.parse(q.pricing_snapshot); } catch (e) {}
  return {
    quoteCode: q.quote_code, status: q.status, total: q.total, createdAt: q.created_at, paidAt: q.paid_at,
    expiresAt: q.expires_at, customerName: `${q.first_name} ${q.last_name}`, email: q.email, phone: q.phone,
    totalQty: snapshot.totalQty, marginStatus: snapshot.internal?.marginStatus,
  };
}

module.exports = router;
