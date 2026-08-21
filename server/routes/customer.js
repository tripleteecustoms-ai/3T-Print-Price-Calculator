// server/routes/customer.js
// Public-facing API for the Customer Order Builder + Quote/Checkout pages.
// Every price the customer ever sees comes from calculateQuote() running
// server-side — the client only ever sends IDs and quantities.

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { calculateQuote, buildLivePricingTables, getSetting, getSettingNum, PricingError, round2, getStepOrder, getQuantityTiers, findTierForQty, MAX_QTY } = require('../pricingEngine');
const { isTightDeadline } = require('../businessDays');
const { generateQuoteCode } = require('../idGen');
const storage = require('../services/storageService');
const emailService = require('../services/emailService');
const paymentService = require('../services/paymentService');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Generous on purpose — real customers never come close to these, they only
// stop a scripted hammering of a sensitive/costly endpoint. Windows are 15
// minutes; limits per client IP.
const quoteCreationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: 'Too many quote requests from this device. Please wait a few minutes and try again.' });
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: 'Too many uploads from this device. Please wait a few minutes and try again.' });
const bulkQuoteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: 'Too many requests. Please wait a few minutes and try again.' });

// ---------------------------------------------------------------- catalog
router.get('/garments', (req, res) => {
  const garments = db.prepare('SELECT * FROM garments WHERE active = 1 ORDER BY sort_order, id').all();
  const result = garments.map(g => ({
    id: g.id,
    name: g.name,
    brand: g.brand,
    styleNumber: g.style_number,
    description: g.description,
    imageUrl: g.image_url,
    priceAdjustment: g.customer_price_adjustment,
    colors: db.prepare('SELECT id, name, hex, image_url as imageUrl FROM garment_colors WHERE garment_id = ? AND active = 1 ORDER BY sort_order').all(g.id),
    sizes: db.prepare('SELECT label, surcharge FROM garment_sizes WHERE garment_id = ? AND active = 1 ORDER BY sort_order').all(g.id),
  }));
  res.json({ garments: result });
});

router.get('/print-locations', (req, res) => {
  const qty = Math.min(MAX_QTY, Math.max(1, parseInt(req.query.qty, 10) || 1));
  const tier = findTierForQty(qty, getQuantityTiers());
  const locations = db.prepare('SELECT * FROM print_locations WHERE active = 1 ORDER BY sort_order').all();
  const result = locations.map(l => {
    if (l.included_in_base) return { id: l.id, name: l.name, code: l.code, included: true, addonEach: 0 };
    const row = tier ? db.prepare('SELECT addon_price FROM print_location_tier_pricing WHERE print_location_id=? AND tier_id=?').get(l.id, tier.id) : null;
    return { id: l.id, name: l.name, code: l.code, included: false, addonEach: row ? row.addon_price : null };
  });
  res.json({ printLocations: result });
});

// Public, read-only mirror of the active quantity tiers — used by the
// builder purely for instant client-side UI feedback (banner text, button
// label). The server never trusts this back; calculateQuote() always
// independently re-derives the tier and price from the DB.
router.get('/quantity-tiers', (req, res) => {
  const tiers = db.prepare('SELECT id, label, min_qty, max_qty, checkout_behavior FROM quantity_tiers WHERE active = 1 ORDER BY sort_order').all();
  res.json({ tiers: tiers.map(t => ({ id: t.id, label: t.label, minQty: t.min_qty, maxQty: t.max_qty, checkoutBehavior: t.checkout_behavior })) });
});

router.get('/business-info', (req, res) => {
  res.json({
    businessName: getSetting('business_name', '3T Print Solutions'),
    quoteExpirationDays: getSettingNum('quote_expiration_days', 7),
    termsUrl: getSetting('terms_url', '/terms.html'),
    designSizeSurcharges: {
      large: getSettingNum('design_size_large_surcharge', 1.50),
      oversized: getSettingNum('design_size_oversized_surcharge', 2.50),
    },
    stepOrder: getStepOrder(),
  });
});

// ------------------------------------------------------------------ analytics
// First-party, no-PII visit/funnel tracking. Fire-and-forget from the
// frontend — never blocks or breaks the customer experience if it fails.
const ANALYTICS_EVENT_TYPES = ['page_view', 'step_view', 'quote_generated', 'checkout_started'];
router.post('/analytics/track', (req, res) => {
  const b = req.body || {};
  if (!ANALYTICS_EVENT_TYPES.includes(b.eventType)) return res.status(400).json({ error: 'Invalid event type.' });
  if (!b.visitorId) return res.status(400).json({ error: 'Missing visitorId.' });
  const utm = b.utm || {};
  db.prepare(`INSERT INTO analytics_events
    (visitor_id, session_id, event_type, step, path, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, quote_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      String(b.visitorId).slice(0, 64), b.sessionId ? String(b.sessionId).slice(0, 64) : null,
      b.eventType, b.step || null, b.path ? String(b.path).slice(0, 300) : null,
      utm.source || null, utm.medium || null, utm.campaign || null, utm.term || null, utm.content || null,
      b.referrer ? String(b.referrer).slice(0, 300) : null, b.quoteCode || null
    );
  res.status(204).end();
});

// ------------------------------------------------------------- draft token
// Generates a token the browser uses to associate artwork uploads with an
// in-progress order before contact info / final quote exist.
router.post('/draft-token', (req, res) => {
  res.json({ draftToken: crypto.randomUUID() });
});

// --------------------------------------------------------------- estimate
// Live price preview shown while the customer configures the order. Always
// recalculated here — never trusts a client-supplied total.
router.post('/estimate', (req, res) => {
  try {
    const calc = calculateQuote({
      garmentId: req.body.garmentId,
      colorSelections: req.body.colorSelections,
      printLocationIds: req.body.printLocationIds,
      discretionaryAdjustment: 0,
    });
    res.json({ estimate: customerSafeCalc(calc) });
  } catch (err) {
    if (err instanceof PricingError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Could not calculate estimate.' });
  }
});

// ------------------------------------------------------------------- upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, storage.isAllowed(file.mimetype));
  },
});

router.post('/uploads', uploadLimiter, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Unsupported file type. Please upload PNG, JPG, PDF, or SVG.' });
  const { draftToken, printLocationCode, locationName } = req.body;
  if (!draftToken) return res.status(400).json({ error: 'Missing draft token.' });

  const storedFilename = storage.storedFilenameFor(req.file.originalname);
  require('fs').writeFileSync(path.join(storage.UPLOAD_DIR, storedFilename), req.file.buffer);

  const loc = printLocationCode ? db.prepare('SELECT id, name FROM print_locations WHERE code = ?').get(printLocationCode) : null;

  const info = db.prepare(`INSERT INTO artwork_files
    (quote_id, draft_token, print_location_id, location_name, original_filename, stored_filename, mime_type, size_bytes, status)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`)
    .run(draftToken, loc ? loc.id : null, loc ? loc.name : (locationName || null), req.file.originalname, storedFilename, req.file.mimetype, req.file.size);

  res.json({
    file: {
      id: info.lastInsertRowid,
      filename: req.file.originalname,
      url: storage.fileUrl(storedFilename),
      sizeBytes: req.file.size,
      mimeType: req.file.mimetype,
      locationName: loc ? loc.name : (locationName || null),
    },
  });
});

router.delete('/uploads/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM artwork_files WHERE id = ? AND quote_id IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'File not found or already attached to a quote.' });
  try { require('fs').unlinkSync(path.join(storage.UPLOAD_DIR, row.stored_filename)); } catch (e) {}
  db.prepare('DELETE FROM artwork_files WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/uploads/by-draft/:draftToken', (req, res) => {
  const files = db.prepare('SELECT * FROM artwork_files WHERE draft_token = ? AND quote_id IS NULL').all(req.params.draftToken);
  res.json({ files: files.map(mapArtworkFile) });
});

// ------------------------------------------------------ bulk quote requests
// Interim structured lead capture for orders over the 24-piece calculator
// cap, replacing the old mailto: handoff. Deliberately a small field set —
// the full intake (deadline, fulfillment method, shipping address, freight)
// depends on the 1,001-10,000 tier pricing system (Phase 2/3).
router.post('/bulk-quote-requests', bulkQuoteLimiter, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const approxQuantity = b.approxQuantity != null && b.approxQuantity !== '' ? Math.max(0, parseInt(b.approxQuantity, 10) || 0) : null;

  const info = db.prepare(`INSERT INTO bulk_quote_requests (name, email, phone, garment_name, approx_quantity, notes)
    VALUES (?,?,?,?,?,?)`)
    .run(name, email.toLowerCase(), b.phone ? String(b.phone).trim() : null, b.garmentName ? String(b.garmentName).trim() : null, approxQuantity, b.notes ? String(b.notes).trim() : null);

  res.json({ ok: true, id: info.lastInsertRowid });
});

// -------------------------------------------------------------- create quote
router.post('/quotes', quoteCreationLimiter, async (req, res) => {
  try {
    const b = req.body;
    for (const field of ['firstName', 'lastName', 'email', 'phone']) {
      if (!b[field] || !String(b[field]).trim()) {
        return res.status(400).json({ error: `${field} is required.` });
      }
    }
    if (!b.termsAccepted) {
      return res.status(400).json({ error: 'You must confirm the order details before we can generate your quote.' });
    }

    const calc = calculateQuote({
      garmentId: b.garmentId,
      colorSelections: b.colorSelections,
      printLocationIds: b.printLocationIds,
      discretionaryAdjustment: 0,
    });

    // ---- Phase 2 manual-review flags (never block checkout by themselves —
    // qty > 1,000 changes the flow to production review below; a tight
    // deadline is only ever a flag for the admin to notice). ----
    const reviewReasons = [];
    if (calc.quantityTier && calc.quantityTier.checkoutBehavior === 'review') reviewReasons.push('qty_over_1000');
    if (isTightDeadline(b.neededByDate, 3)) reviewReasons.push('tight_deadline');
    // TODO(Phase 4): supplier-inventory-unverifiable, customer-supplied-garment,
    // specialty-print-method, multiple-shipping-destinations, freight-required,
    // extensive-design-work, garment/color-unavailable, weight-exceeds-parcel-limits
    // — none of the underlying systems (inventory checking, freight/shipping
    // fields) exist yet, so those triggers are intentionally not implemented here.
    const isLargeOrder = calc.quantityTier && calc.quantityTier.checkoutBehavior === 'review';

    let shippingAddressJson = null;
    if (b.fulfillmentMethod === 'shipping' && b.shippingAddress && typeof b.shippingAddress === 'object') {
      const a = b.shippingAddress;
      const clean = {
        line1: String(a.line1 || '').trim(), line2: String(a.line2 || '').trim(),
        city: String(a.city || '').trim(), state: String(a.state || '').trim(), zip: String(a.zip || '').trim(),
      };
      if (isLargeOrder && (!clean.line1 || !clean.city || !clean.state || !clean.zip)) {
        return res.status(400).json({ error: 'Please provide a complete shipping address (street, city, state, ZIP) for a production review order.' });
      }
      if (clean.line1 || clean.city || clean.state || clean.zip) shippingAddressJson = JSON.stringify(clean);
    } else if (isLargeOrder && b.fulfillmentMethod === 'shipping') {
      return res.status(400).json({ error: 'Please provide a complete shipping address (street, city, state, ZIP) for a production review order.' });
    }

    const tx = db.transaction(() => {
      // find or create customer by email
      let customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(String(b.email).toLowerCase().trim());
      if (!customer) {
        const info = db.prepare(`INSERT INTO customers (first_name,last_name,email,phone,business_name) VALUES (?,?,?,?,?)`)
          .run(b.firstName.trim(), b.lastName.trim(), String(b.email).toLowerCase().trim(), b.phone.trim(), b.businessName || null);
        customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
      } else {
        db.prepare('UPDATE customers SET first_name=?, last_name=?, phone=?, business_name=? WHERE id=?')
          .run(b.firstName.trim(), b.lastName.trim(), b.phone.trim(), b.businessName || null, customer.id);
      }

      const quoteCode = generateQuoteCode();
      const expirationDays = getSettingNum('quote_expiration_days', 7);
      const expiresAt = new Date(Date.now() + expirationDays * 86400000).toISOString();
      const now = new Date().toISOString();

      const qInfo = db.prepare(`INSERT INTO quotes
        (quote_code, customer_id, status, garment_id, fulfillment_method, event_name, needed_by_date, notes, design_notes,
         discretionary_adjustment, pricing_snapshot, subtotal, total, expires_at, terms_accepted_at, artwork_pending,
         needs_manual_review, review_reasons, shipping_address, original_calculated_price, final_approved_price, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          quoteCode, customer.id, 'quote_generated', calc.garment.id, b.fulfillmentMethod === 'shipping' ? 'shipping' : 'pickup',
          b.orderPurpose || null, b.neededByDate || null, b.notes || null, b.designNotes || null,
          0, JSON.stringify(calc), calc.subtotal, calc.total, expiresAt, now, b.artworkPending ? 1 : 0,
          reviewReasons.length > 0 ? 1 : 0, reviewReasons.length > 0 ? JSON.stringify(reviewReasons) : null,
          shippingAddressJson, calc.total, calc.total, now, now
        );
      const quoteId = qInfo.lastInsertRowid;

      const insItem = db.prepare(`INSERT INTO quote_items (quote_id,color_name,color_hex,size_label,quantity,unit_surcharge) VALUES (?,?,?,?,?,?)`);
      for (const line of calc.lines) insItem.run(quoteId, line.colorName, line.colorHex, line.sizeLabel, line.quantity, line.unitSurcharge);

      const insLoc = db.prepare(`INSERT INTO quote_print_locations (quote_id,print_location_id,location_name,addon_price_each,design_size,design_size_surcharge_each) VALUES (?,?,?,?,?,?)`);
      for (const loc of calc.printLocations) insLoc.run(quoteId, loc.id, loc.name, loc.addonEach, loc.designSize, loc.designSizeSurchargeEach);

      if (b.draftToken) {
        db.prepare('UPDATE artwork_files SET quote_id = ? WHERE draft_token = ? AND quote_id IS NULL').run(quoteId, b.draftToken);
      }

      db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?,?,?)`)
        .run(quoteId, 'generated', `Quote generated for ${calc.totalQty} pcs, total $${calc.total.toFixed(2)}.`
          + (reviewReasons.length ? ` [flagged for review: ${reviewReasons.join(', ')}]` : ''));

      return { quoteId, quoteCode, customer };
    });

    const { quoteId, quoteCode, customer } = tx();
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    emailService.sendQuoteEmail(quote, customer, baseUrl).catch(err => console.error('Email send failed:', err));

    res.json({ quoteCode, quoteId, needsManualReview: reviewReasons.length > 0, reviewReasons });
  } catch (err) {
    if (err instanceof PricingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not generate your quote. Please try again.' });
  }
});

// --------------------------------------------------------------- get quote
router.get('/quotes/:code', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });

  const isExpired = new Date(quote.expires_at).getTime() < Date.now() && !['paid', 'cancelled'].includes(quote.status);
  if (quote.status === 'quote_generated') {
    db.prepare("UPDATE quotes SET status='quote_viewed', viewed_at = COALESCE(viewed_at, ?) WHERE id = ?")
      .run(new Date().toISOString(), quote.id);
    db.prepare(`INSERT INTO quote_events (quote_id, event_type) VALUES (?, 'viewed')`).run(quote.id);
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);
  const printLocations = db.prepare('SELECT * FROM quote_print_locations WHERE quote_id = ?').all(quote.id);
  const artwork = db.prepare('SELECT * FROM artwork_files WHERE quote_id = ?').all(quote.id);
  const snapshot = JSON.parse(quote.pricing_snapshot);

  res.json({
    quote: {
      code: quote.quote_code,
      status: isExpired ? 'expired' : quote.status,
      createdAt: quote.created_at,
      expiresAt: quote.expires_at,
      isExpired,
      fulfillmentMethod: quote.fulfillment_method,
      orderPurpose: quote.event_name,
      neededByDate: quote.needed_by_date,
      notes: quote.notes,
      designNotes: quote.design_notes,
      artworkStatus: quote.artwork_status,
      paidAt: quote.paid_at,
      amountPaid: quote.amount_paid,
      needsManualReview: !!quote.needs_manual_review,
      reviewReasons: quote.review_reasons ? JSON.parse(quote.review_reasons) : [],
      isLargeOrder: !!(quote.review_reasons && JSON.parse(quote.review_reasons).includes('qty_over_1000')),
    },
    customer: { firstName: customer.first_name, lastName: customer.last_name, email: customer.email, phone: customer.phone, businessName: customer.business_name },
    garment: snapshot.garment,
    items,
    printLocations,
    artwork: artwork.map(mapArtworkFile),
    pricing: customerSafeCalc(snapshot),
  });
});

router.post('/quotes/:code/checkout-started', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  db.prepare("UPDATE quotes SET status='checkout_started', checkout_started_at = COALESCE(checkout_started_at, ?) WHERE id = ?")
    .run(new Date().toISOString(), quote.id);
  db.prepare(`INSERT INTO quote_events (quote_id, event_type) VALUES (?, 'checkout_started')`).run(quote.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------- pay / checkout
router.post('/quotes/:code/checkout', async (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  if (new Date(quote.expires_at).getTime() < Date.now()) {
    return res.status(409).json({ error: 'QUOTE_EXPIRED' });
  }
  const reasons = quote.review_reasons ? JSON.parse(quote.review_reasons) : [];
  if (reasons.includes('qty_over_1000')) {
    // Orders over 1,000 pieces never go through normal checkout — they were
    // already routed into production review at quote-generation time.
    return res.status(400).json({ error: 'This order is in production and inventory review. You will receive a confirmed invoice within one business day — no payment is needed here.' });
  }
  if (!req.body.termsAccepted) {
    return res.status(400).json({ error: 'Please confirm the order details before checkout.' });
  }

  // SERVER-SIDE RECALCULATION — the source of truth for the amount charged.
  // We re-run pricing against the *current* live tables and compare to the
  // snapshot; if the live tables changed since the quote was generated we
  // still honor the snapshot (that's the point of freezing a quote), but we
  // never accept anything the client claims about the price.
  const snapshot = JSON.parse(quote.pricing_snapshot);
  const recomputed = calculateQuote({
    garmentId: snapshot.garment.id,
    colorSelections: quote_items_to_selections(quote.id),
    printLocationIds: quote_print_locations_to_selections(quote.id),
    discretionaryAdjustment: quote.discretionary_adjustment,
    floorOverride: !!quote.floor_override,
    overrideUnitPrice: quote.floor_override ? quote.override_unit_price : undefined,
    discountCode: quote.discount_code,
    discountAlreadyApplied: !!quote.discount_code,
  }, snapshot.pricingTablesSnapshot); // price against the FROZEN snapshot tables, not live ones

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  db.prepare('UPDATE quotes SET pricing_snapshot=?, subtotal=?, total=?, discount_amount=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(recomputed), recomputed.subtotal, recomputed.total, recomputed.discountAmount, new Date().toISOString(), quote.id);

  try {
    const checkout = await paymentService.createCheckoutForQuote({ ...quote, pricing_snapshot: JSON.stringify(recomputed) }, customer);
    db.prepare("UPDATE quotes SET status='checkout_started', checkout_started_at=COALESCE(checkout_started_at,?), payment_provider=?, shopify_draft_order_id=? WHERE id=?")
      .run(new Date().toISOString(), checkout.provider, checkout.provider === 'shopify' ? checkout.providerRef : null, quote.id);
    db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'checkout_started', ?)`)
      .run(quote.id, `Provider: ${checkout.provider}`);

    // Email the itemized quote the moment they click Pay & Place Order — so
    // they have a record of the price even if they don't finish paying.
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    emailService.sendQuoteEmail({ ...quote, pricing_snapshot: JSON.stringify(recomputed) }, customer, baseUrl)
      .catch(err => console.error('Checkout quote email failed:', err));

    res.json({ checkoutUrl: checkout.checkoutUrl, provider: checkout.provider });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout. Please try again or request a review.' });
  }
});

function quote_items_to_selections(quoteId) {
  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quoteId);
  const byColor = {};
  for (const it of items) {
    byColor[it.color_name] = byColor[it.color_name] || { colorName: it.color_name, colorHex: it.color_hex, sizes: [] };
    byColor[it.color_name].sizes.push({ label: it.size_label, qty: it.quantity });
  }
  return Object.values(byColor);
}

function quote_print_locations_to_selections(quoteId) {
  return db.prepare('SELECT print_location_id, design_size FROM quote_print_locations WHERE quote_id=?').all(quoteId)
    .map(r => ({ id: r.print_location_id, designSize: r.design_size }));
}

router.post('/mock-payment/:code/confirm', (req, res) => {
  try {
    const quote = paymentService.confirmMockPayment(req.params.code);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    emailService.sendStatusUpdateEmail(quote, customer, baseUrl, 'paid')
      .catch(err => console.error('Paid confirmation email failed:', err));
    res.json({ ok: true, quoteCode: quote.quote_code });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ------------------------------------------------------------- edit quote
router.post('/quotes/:code/request-review', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  db.prepare("UPDATE quotes SET status='needs_review', updated_at=? WHERE id=?").run(new Date().toISOString(), quote.id);
  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'review_requested', ?)`)
    .run(quote.id, req.body.message || null);
  res.json({ ok: true });
});

router.post('/quotes/:code/recalculate', (req, res) => {
  // Used by the "THIS QUOTE HAS EXPIRED -> RECALCULATE MY ORDER" flow.
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  const snapshot = JSON.parse(quote.pricing_snapshot);
  try {
    const calc = calculateQuote({
      garmentId: snapshot.garment.id,
      colorSelections: quote_items_to_selections(quote.id),
      printLocationIds: quote_print_locations_to_selections(quote.id),
      discretionaryAdjustment: 0,
      discountCode: quote.discount_code,
      discountAlreadyApplied: !!quote.discount_code,
    }); // against LIVE tables — this is a fresh quote
    const expirationDays = getSettingNum('quote_expiration_days', 7);
    const expiresAt = new Date(Date.now() + expirationDays * 86400000).toISOString();
    db.prepare(`UPDATE quotes SET pricing_snapshot=?, subtotal=?, total=?, discount_amount=?, expires_at=?, status='quote_generated', updated_at=? WHERE id=?`)
      .run(JSON.stringify(calc), calc.subtotal, calc.total, calc.discountAmount, expiresAt, new Date().toISOString(), quote.id);
    db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'edited', 'Recalculated after expiration.')`).run(quote.id);
    res.json({ ok: true, quoteCode: quote.quote_code });
  } catch (err) {
    res.status(400).json({ error: err instanceof PricingError ? err.message : 'Could not recalculate.' });
  }
});

// ------------------------------------------------------------- discount codes
router.post('/quotes/:code/apply-discount', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  const rawCode = String(req.body.code || '').trim();
  if (!rawCode) return res.status(400).json({ error: 'Enter a discount code.' });

  const snapshot = JSON.parse(quote.pricing_snapshot);
  const calc = calculateQuote({
    garmentId: snapshot.garment.id,
    colorSelections: quote_items_to_selections(quote.id),
    printLocationIds: quote_print_locations_to_selections(quote.id),
    discretionaryAdjustment: quote.discretionary_adjustment,
    floorOverride: !!quote.floor_override,
    overrideUnitPrice: quote.floor_override ? quote.override_unit_price : undefined,
    discountCode: rawCode,
    // Re-applying the exact same code that's already on this quote isn't a
    // new redemption — don't let it double-count against the usage limit.
    discountAlreadyApplied: quote.discount_code === rawCode.trim().toUpperCase(),
  }, snapshot.pricingTablesSnapshot);

  if (!calc.discount) {
    return res.status(400).json({ error: calc.discountError || 'That discount code could not be applied.' });
  }

  const tx = db.transaction(() => {
    // Replacing an already-applied code frees up its usage slot first.
    if (quote.discount_code && quote.discount_code !== calc.discount.code) {
      db.prepare('UPDATE discount_codes SET times_used = MAX(0, times_used - 1) WHERE code = ?').run(quote.discount_code);
    }
    if (quote.discount_code !== calc.discount.code) {
      db.prepare('UPDATE discount_codes SET times_used = times_used + 1 WHERE code = ?').run(calc.discount.code);
    }
    db.prepare('UPDATE quotes SET discount_code=?, discount_amount=?, pricing_snapshot=?, subtotal=?, total=?, updated_at=? WHERE id=?')
      .run(calc.discount.code, calc.discountAmount, JSON.stringify(calc), calc.subtotal, calc.total, new Date().toISOString(), quote.id);
    db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'discount_applied', ?)`)
      .run(quote.id, `Applied code ${calc.discount.code} (-$${calc.discountAmount.toFixed(2)})`);
  });
  tx();

  res.json({ ok: true, pricing: customerSafeCalc(calc) });
});

router.post('/quotes/:code/remove-discount', (req, res) => {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(req.params.code);
  if (!quote) return res.status(404).json({ error: 'Quote not found.' });
  if (!quote.discount_code) return res.json({ ok: true }); // nothing to remove

  const snapshot = JSON.parse(quote.pricing_snapshot);
  const calc = calculateQuote({
    garmentId: snapshot.garment.id,
    colorSelections: quote_items_to_selections(quote.id),
    printLocationIds: quote_print_locations_to_selections(quote.id),
    discretionaryAdjustment: quote.discretionary_adjustment,
    floorOverride: !!quote.floor_override,
    overrideUnitPrice: quote.floor_override ? quote.override_unit_price : undefined,
    discountCode: null,
  }, snapshot.pricingTablesSnapshot);

  const tx = db.transaction(() => {
    db.prepare('UPDATE discount_codes SET times_used = MAX(0, times_used - 1) WHERE code = ?').run(quote.discount_code);
    db.prepare('UPDATE quotes SET discount_code=NULL, discount_amount=0, pricing_snapshot=?, subtotal=?, total=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(calc), calc.subtotal, calc.total, new Date().toISOString(), quote.id);
    db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'discount_removed', 'Discount code removed.')`).run(quote.id);
  });
  tx();

  res.json({ ok: true, pricing: customerSafeCalc(calc) });
});

// -------------------------------------------------------------- mockup approval
// No-login flow reached from the emailed approval link — the approval_token
// itself is the credential, so anyone with the emailed link can respond
// (same trust model as the quote_code links used throughout this app).
router.get('/mockups/:token', (req, res) => {
  const mockup = db.prepare('SELECT * FROM mockups WHERE approval_token = ?').get(req.params.token);
  if (!mockup) return res.status(404).json({ error: 'This mockup link is invalid or has expired.' });
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(mockup.quote_id);
  const snapshot = JSON.parse(quote.pricing_snapshot);
  res.json({
    mockup: {
      id: mockup.id, url: storage.fileUrl(mockup.stored_filename), status: mockup.status,
      customerNote: mockup.customer_note, uploadedAt: mockup.uploaded_at, respondedAt: mockup.responded_at,
    },
    quote: { code: quote.quote_code, garmentName: snapshot.garment.name, totalQty: snapshot.totalQty },
  });
});

router.post('/mockups/:token/approve', async (req, res) => {
  const mockup = db.prepare('SELECT * FROM mockups WHERE approval_token = ?').get(req.params.token);
  if (!mockup) return res.status(404).json({ error: 'This mockup link is invalid or has expired.' });
  const now = new Date().toISOString();
  db.prepare(`UPDATE mockups SET status='approved', responded_at=? WHERE id=?`).run(now, mockup.id);
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(mockup.quote_id);
  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'mockup_approved', 'Customer approved the mockup.')`).run(quote.id);
  emailService.sendMockupResponseNotification(quote, { status: 'approved' }).catch(err => console.error('Mockup response notification failed:', err));
  res.json({ ok: true });
});

router.post('/mockups/:token/request-changes', async (req, res) => {
  const mockup = db.prepare('SELECT * FROM mockups WHERE approval_token = ?').get(req.params.token);
  if (!mockup) return res.status(404).json({ error: 'This mockup link is invalid or has expired.' });
  const note = String(req.body.note || '').trim();
  const now = new Date().toISOString();
  db.prepare(`UPDATE mockups SET status='changes_requested', customer_note=?, responded_at=? WHERE id=?`).run(note || null, now, mockup.id);
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(mockup.quote_id);
  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'mockup_changes_requested', ?)`)
    .run(quote.id, note ? `Customer requested changes: ${note}` : 'Customer requested changes.');
  emailService.sendMockupResponseNotification(quote, { status: 'changes_requested', customerNote: note }).catch(err => console.error('Mockup response notification failed:', err));
  res.json({ ok: true });
});

// ------------------------------------------------------------------ helpers
function mapArtworkFile(f) {
  return {
    id: f.id, filename: f.original_filename, url: storage.fileUrl(f.stored_filename),
    mimeType: f.mime_type, sizeBytes: f.size_bytes, locationName: f.location_name, status: f.status,
    uploadedAt: f.uploaded_at,
  };
}

/** Strip internal cost/margin fields before anything reaches the customer. */
function customerSafeCalc(calc) {
  return {
    totalQty: calc.totalQty,
    quantityTier: calc.quantityTier,           // { id, label, checkoutBehavior } — drives the "Submit for Production Review" branch
    // isEstimatedPrice deliberately NOT exposed here — "this price is an
    // unreviewed placeholder" is an internal flag for the admin UI, not
    // something to surface to a customer as doubt about their own quote.
    standardUnit: calc.standardUnit,          // fine to show — this IS the advertised price
    finalBaseUnit: calc.finalBaseUnit,
    printLocations: calc.printLocations.map(p => ({ name: p.name, included: p.included, addonEach: p.addonEach, designSize: p.designSize, designSizeSurchargeEach: p.designSizeSurchargeEach })),
    addonLines: calc.addonLines,
    addonLinesTotal: calc.addonLinesTotal,
    surchargedLines: calc.surchargedLines.map(l => ({ colorName: l.colorName, sizeLabel: l.sizeLabel, quantity: l.quantity, unitSurcharge: l.unitSurcharge })),
    sizeSurchargeTotal: calc.sizeSurchargeTotal,
    designSizeLines: calc.designSizeLines,
    designSizeSurchargeTotal: calc.designSizeSurchargeTotal,
    discount: calc.discount,
    discountError: calc.discountError,
    discountAmount: calc.discountAmount,
    baseLineTotal: calc.baseLineTotal,
    subtotal: calc.subtotal,
    total: calc.total,
    garment: calc.garment,
    // deliberately omitted: floorUnit, maxDiscount, adjustment, belowFloor, internal.*
  };
}

module.exports = router;
