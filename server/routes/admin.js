// server/routes/admin.js
// Owner/admin backend: auth, quotes/orders management, garments, pricing
// matrix, print locations, customers, settings. Everything here requires
// requireAdmin (session cookie) except /login.

const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireAdmin } = require('../middleware/adminAuth');
const { calculateQuote, marginStatus, getSetting, round2, PricingError, BUILDER_STEPS, getStepOrder, isValidStepOrder } = require('../pricingEngine');
const emailService = require('../services/emailService');
const storage = require('../services/storageService');

const router = express.Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)),
});

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

// -------------------------------------------------------------- analytics
const FUNNEL_STEPS = ['garment', 'color', 'sizes', 'locations', 'artwork', 'contact'];

router.get('/analytics', (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // ---- funnel: unique visitors reaching each step, then quote/checkout/paid ----
  const stepCounts = Object.fromEntries(
    db.prepare(`SELECT step, COUNT(DISTINCT visitor_id) as n FROM analytics_events WHERE event_type='step_view' AND created_at >= ? GROUP BY step`)
      .all(cutoff).map(r => [r.step, r.n])
  );
  const totalVisitors = db.prepare(`SELECT COUNT(DISTINCT visitor_id) as n FROM analytics_events WHERE event_type='page_view' AND created_at >= ?`).get(cutoff).n;
  const quotesGeneratedCount = db.prepare(`SELECT COUNT(DISTINCT quote_code) as n FROM analytics_events WHERE event_type='quote_generated' AND quote_code IS NOT NULL AND created_at >= ?`).get(cutoff).n;
  const checkoutStartedCount = db.prepare(`SELECT COUNT(DISTINCT quote_code) as n FROM analytics_events WHERE event_type='checkout_started' AND quote_code IS NOT NULL AND created_at >= ?`).get(cutoff).n;
  const paidCount = db.prepare(`SELECT COUNT(*) as n FROM quotes WHERE paid_at IS NOT NULL AND paid_at >= ?`).get(cutoff).n;

  const funnel = [
    { step: 'visitors', label: 'Visitors', count: totalVisitors },
    ...FUNNEL_STEPS.map(step => ({ step, label: step.charAt(0).toUpperCase() + step.slice(1), count: stepCounts[step] || 0 })),
    { step: 'quote_generated', label: 'Quote Generated', count: quotesGeneratedCount },
    { step: 'checkout_started', label: 'Checkout Started', count: checkoutStartedCount },
    { step: 'paid', label: 'Paid', count: paidCount },
  ];

  // ---- traffic sources (UTM), with conversion through to quotes/paid ----
  const trafficSources = db.prepare(`
    WITH visitor_source AS (
      SELECT visitor_id, COALESCE(MIN(utm_source), 'direct') AS source
      FROM analytics_events WHERE event_type='page_view' AND created_at >= ?
      GROUP BY visitor_id
    ),
    visitor_quotes AS (
      SELECT DISTINCT visitor_id, quote_code FROM analytics_events
      WHERE event_type='quote_generated' AND quote_code IS NOT NULL AND created_at >= ?
    )
    SELECT vs.source,
      COUNT(DISTINCT vs.visitor_id) AS visitors,
      COUNT(DISTINCT vq.quote_code) AS quotesGenerated,
      COUNT(DISTINCT CASE WHEN q.paid_at IS NOT NULL THEN vq.quote_code END) AS paid
    FROM visitor_source vs
    LEFT JOIN visitor_quotes vq ON vq.visitor_id = vs.visitor_id
    LEFT JOIN quotes q ON q.quote_code = vq.quote_code
    GROUP BY vs.source ORDER BY visitors DESC
  `).all(cutoff, cutoff);

  // ---- revenue over time (daily, paid orders only) ----
  const revenueByDay = db.prepare(`
    SELECT date(paid_at) as day, COALESCE(SUM(amount_paid),0) as revenue, COUNT(*) as orders
    FROM quotes WHERE paid_at IS NOT NULL AND paid_at >= ?
    GROUP BY day ORDER BY day
  `).all(cutoff);

  const orderStats = db.prepare(`
    SELECT COUNT(*) as orders, COALESCE(SUM(amount_paid),0) as revenue, COALESCE(AVG(amount_paid),0) as avgOrderValue
    FROM quotes WHERE paid_at IS NOT NULL AND paid_at >= ?
  `).get(cutoff);

  // ---- top-selling garments (paid orders, within window) ----
  const topGarments = db.prepare(`
    SELECT g.name, SUM(qi.quantity) as qty
    FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id JOIN garments g ON g.id = q.garment_id
    WHERE q.paid_at IS NOT NULL AND q.paid_at >= ?
    GROUP BY g.id ORDER BY qty DESC LIMIT 5
  `).all(cutoff);

  // ---- repeat customer rate (all-time — a customer's lifetime behavior, not window-bound) ----
  const totalPayingCustomers = db.prepare(`SELECT COUNT(DISTINCT customer_id) as n FROM quotes WHERE paid_at IS NOT NULL`).get().n;
  const repeatCustomers = db.prepare(`SELECT COUNT(*) as n FROM (SELECT customer_id FROM quotes WHERE paid_at IS NOT NULL GROUP BY customer_id HAVING COUNT(*) > 1)`).get().n;

  res.json({
    days, funnel, trafficSources, revenueByDay,
    orderStats, topGarments,
    repeatCustomers: { total: totalPayingCustomers, repeat: repeatCustomers, rate: totalPayingCustomers > 0 ? round2((repeatCustomers / totalPayingCustomers) * 100) : 0 },
  });
});

// ----------------------------------------------------------- discount codes
const DISCOUNT_TYPES = ['percent', 'flat'];

router.get('/discount-codes', (req, res) => {
  const rows = db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC').all();
  res.json({ discountCodes: rows });
});

router.post('/discount-codes', (req, res) => {
  const b = req.body;
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Enter a code.' });
  if (!DISCOUNT_TYPES.includes(b.type)) return res.status(400).json({ error: 'Type must be "percent" or "flat".' });
  const value = Number(b.value);
  if (!(value > 0)) return res.status(400).json({ error: 'Enter a value greater than 0.' });
  if (b.type === 'percent' && value > 100) return res.status(400).json({ error: 'Percentage discounts cannot exceed 100%.' });

  const existing = db.prepare('SELECT id FROM discount_codes WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: `Code "${code}" already exists.` });

  const usageLimit = b.usageLimit === '' || b.usageLimit == null ? null : Math.max(0, parseInt(b.usageLimit, 10) || 0);
  const expiresAt = b.expiresAt || null;

  const info = db.prepare(`INSERT INTO discount_codes (code, type, value, usage_limit, expires_at, active) VALUES (?,?,?,?,?,?)`)
    .run(code, b.type, value, usageLimit, expiresAt, b.active === false ? 0 : 1);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/discount-codes/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Discount code not found.' });
  const b = req.body;

  const type = b.type != null ? b.type : existing.type;
  if (!DISCOUNT_TYPES.includes(type)) return res.status(400).json({ error: 'Type must be "percent" or "flat".' });
  const value = b.value != null ? Number(b.value) : existing.value;
  if (!(value > 0)) return res.status(400).json({ error: 'Enter a value greater than 0.' });
  if (type === 'percent' && value > 100) return res.status(400).json({ error: 'Percentage discounts cannot exceed 100%.' });

  const usageLimit = b.usageLimit === undefined ? existing.usage_limit
    : (b.usageLimit === '' || b.usageLimit == null ? null : Math.max(0, parseInt(b.usageLimit, 10) || 0));
  const expiresAt = b.expiresAt === undefined ? existing.expires_at : (b.expiresAt || null);
  const active = b.active === undefined ? existing.active : (b.active ? 1 : 0);

  db.prepare(`UPDATE discount_codes SET type=?, value=?, usage_limit=?, expires_at=?, active=?, updated_at=? WHERE id=?`)
    .run(type, value, usageLimit, expiresAt, active, new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

router.delete('/discount-codes/:id', (req, res) => {
  db.prepare('DELETE FROM discount_codes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------- reminders
// Manual, repeatable "nudge" for any order that hasn't been paid yet —
// deliberately not tied to a status change (unlike sendStatusUpdateEmail),
// so the admin can send it as many times as makes sense.
router.post('/quotes/:code/send-reminder', async (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  if (quote.paid_at) return res.status(400).json({ error: 'This order has already been paid — a reminder would not make sense.' });

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    await emailService.sendReminderEmail(quote, customer, baseUrl);
    res.json({ ok: true });
  } catch (err) {
    console.error('Reminder email failed:', err);
    res.status(500).json({ error: 'Could not send the reminder email. Please try again.' });
  }
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
    printLocationIds: db.prepare('SELECT print_location_id, design_size FROM quote_print_locations WHERE quote_id=?').all(quote.id).map(r => ({ id: r.print_location_id, designSize: r.design_size })),
    discretionaryAdjustment,
    floorOverride: !!floorOverride,
    overrideUnitPrice: finalOverrideUnitPrice,
    discountCode: quote.discount_code,
    discountAlreadyApplied: !!quote.discount_code,
  }, snapshot.pricingTablesSnapshot);

  db.prepare(`UPDATE quotes SET discretionary_adjustment=?, discretionary_adjustment_note=?, floor_override=?, override_unit_price=?,
    pricing_snapshot=?, subtotal=?, total=?, discount_amount=?, updated_at=? WHERE id=?`)
    .run(discretionaryAdjustment, note || null, floorOverride, finalOverrideUnitPrice, JSON.stringify(recalculated),
      recalculated.subtotal, recalculated.total, recalculated.discountAmount, new Date().toISOString(), quote.id);

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

// Dedicated image-upload endpoint (separate from the text-field PUT above) so
// the admin garment card can upload a photo directly instead of pasting a URL.
router.post('/garments/:id/image', imageUpload.single('image'), (req, res) => {
  const exists = db.prepare('SELECT id, image_url FROM garments WHERE id=?').get(req.params.id);
  if (!exists) return res.status(404).json({ error: 'Garment not found.' });
  if (!req.file) return res.status(400).json({ error: 'Unsupported file type. Please upload PNG, JPG, WEBP, or SVG.' });

  const storedFilename = storage.storedFilenameFor(req.file.originalname);
  fs.writeFileSync(path.join(storage.UPLOAD_DIR, storedFilename), req.file.buffer);
  const imageUrl = storage.fileUrl(storedFilename);

  db.prepare('UPDATE garments SET image_url=?, updated_at=? WHERE id=?').run(imageUrl, new Date().toISOString(), req.params.id);

  // Best-effort cleanup of the previous uploaded image (ignore failures —
  // e.g. it was an external URL, or the file's already gone).
  if (exists.image_url && exists.image_url.startsWith('/uploads/')) {
    try { fs.unlinkSync(path.join(storage.UPLOAD_DIR, exists.image_url.replace('/uploads/', ''))); } catch (e) {}
  }

  res.json({ ok: true, imageUrl });
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

// ---------------------------------------------------------------- mockups
// Owner-uploaded design mockups sent to a customer for approval before
// production. Lives entirely under its own admin "Mockups" tab — the
// customer never sees an admin UI, just the emailed image + a lightweight
// approve/request-changes page (see server/routes/customer.js).
router.get('/mockups/orders', (req, res) => {
  // Orders eligible to have a mockup uploaded for them — anything active
  // (not cancelled/refunded), regardless of payment status, since mockups
  // are often sent before the customer pays.
  const rows = db.prepare(`SELECT qt.quote_code, qt.status, c.first_name, c.last_name FROM quotes qt
    JOIN customers c ON c.id = qt.customer_id
    WHERE qt.status NOT IN ('cancelled','refunded')
    ORDER BY qt.created_at DESC LIMIT 300`).all();
  res.json({ orders: rows.map(r => ({ quoteCode: r.quote_code, status: r.status, customerName: `${r.first_name} ${r.last_name}` })) });
});

router.get('/mockups', (req, res) => {
  const rows = db.prepare(`SELECT m.*, q.quote_code, c.first_name, c.last_name FROM mockups m
    JOIN quotes q ON q.id = m.quote_id JOIN customers c ON c.id = q.customer_id
    ORDER BY m.uploaded_at DESC LIMIT 300`).all();
  res.json({ mockups: rows.map(m => ({ ...m, url: `/uploads/${m.stored_filename}` })) });
});

router.post('/quotes/:code/mockups', imageUpload.single('image'), async (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  if (!req.file) return res.status(400).json({ error: 'Unsupported file type. Please upload PNG, JPG, WEBP, or SVG.' });

  const storedFilename = storage.storedFilenameFor(req.file.originalname);
  fs.writeFileSync(path.join(storage.UPLOAD_DIR, storedFilename), req.file.buffer);
  const approvalToken = crypto.randomUUID();

  const info = db.prepare(`INSERT INTO mockups (quote_id, original_filename, stored_filename, mime_type, size_bytes, status, approval_token)
    VALUES (?,?,?,?,?, 'pending_customer', ?)`)
    .run(quote.id, req.file.originalname, storedFilename, req.file.mimetype, req.file.size, approvalToken);

  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'mockup_uploaded', ?)`)
    .run(quote.id, `Mockup uploaded by ${req.session.adminName}, sent for customer approval.`);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  try {
    await emailService.sendMockupApprovalEmail(quote, customer, baseUrl, { imageUrl: storage.fileUrl(storedFilename), approvalToken });
  } catch (err) {
    console.error('Mockup approval email failed:', err);
    // The mockup is still uploaded/saved even if the email failed to send —
    // don't lose the upload, just surface the email problem to the admin.
    return res.status(207).json({ ok: true, id: info.lastInsertRowid, emailError: err.message || 'Could not email the customer.' });
  }

  res.json({ ok: true, id: info.lastInsertRowid });
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

const STEP_LABELS = { garment: 'Garment', color: 'Color', sizes: 'Sizes', locations: 'Print Locations', artwork: 'Artwork', contact: 'Contact Info' };

// Customer builder step order ("Settings > Layout"). Validated separately
// from the generic /settings route above because a malformed value here
// (missing a step, a duplicate, an unknown key) would break the live
// customer builder outright — getStepOrder() falls back to the default
// order for anything that isn't a clean permutation, but we still reject
// bad input up front so the admin gets a clear error instead of a save
// that silently does nothing.
router.get('/settings/step-order', (req, res) => {
  res.json({ stepOrder: getStepOrder(), defaultOrder: BUILDER_STEPS, stepLabels: STEP_LABELS });
});
router.put('/settings/step-order', (req, res) => {
  const { stepOrder } = req.body || {};
  if (!isValidStepOrder(stepOrder)) {
    return res.status(400).json({ error: `Step order must include each of: ${BUILDER_STEPS.join(', ')} — exactly once each.` });
  }
  db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('step_order',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(JSON.stringify(stepOrder), new Date().toISOString());
  res.json({ ok: true, stepOrder });
});

// Lets the admin confirm their email provider actually works (e.g. Gmail
// app-password auth) without needing to wait for a real order event.
router.post('/test-email', async (req, res) => {
  const to = getSetting('gmail_address', '') || getSetting('business_email', '');
  if (!to) return res.status(400).json({ error: 'Set a Gmail Address or Business Email first, then try again.' });
  try {
    await emailService.send({
      quoteId: null, to, subject: 'Test email from 3T Print Solutions',
      html: '<p>This is a test email confirming your email provider is connected and working.</p>',
    });
    res.json({ ok: true, sentTo: to });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not send test email.' });
  }
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
