// server/routes/customer.js
// Public-facing API for the Customer Order Builder + Quote/Checkout pages.
// Every price the customer ever sees comes from calculateQuote() running
// server-side — the client only ever sends IDs and quantities.

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { calculateQuote, buildLivePricingTables, getSetting, getSettingNum, PricingError, round2 } = require('../pricingEngine');
const { generateQuoteCode } = require('../idGen');
const storage = require('../services/storageService');
const emailService = require('../services/emailService');
const paymentService = require('../services/paymentService');

const router = express.Router();

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
  const qty = Math.min(24, Math.max(1, parseInt(req.query.qty, 10) || 1));
  const locations = db.prepare('SELECT * FROM print_locations WHERE active = 1 ORDER BY sort_order').all();
  const result = locations.map(l => {
    const price = l.included_in_base ? 0 : db.prepare('SELECT addon_price FROM print_location_pricing WHERE print_location_id=? AND quantity=?').get(l.id, qty)?.addon_price ?? null;
    return { id: l.id, name: l.name, code: l.code, included: !!l.included_in_base, addonEach: price };
  });
  res.json({ printLocations: result });
});

router.get('/business-info', (req, res) => {
  res.json({
    businessName: getSetting('business_name', '3T Print Solutions'),
    quoteExpirationDays: getSettingNum('quote_expiration_days', 7),
    termsUrl: getSetting('terms_url', '/terms.html'),
  });
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
    if (err instanceof PricingError && err.message === 'BULK_QUOTE_REQUIRED') {
      return res.status(200).json({ bulkQuoteRequired: true });
    }
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

router.post('/uploads', upload.single('file'), (req, res) => {
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

// -------------------------------------------------------------- create quote
router.post('/quotes', async (req, res) => {
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
         discretionary_adjustment, pricing_snapshot, subtotal, total, expires_at, terms_accepted_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          quoteCode, customer.id, 'quote_generated', calc.garment.id, b.fulfillmentMethod === 'shipping' ? 'shipping' : 'pickup',
          b.orderPurpose || null, b.neededByDate || null, b.notes || null, b.designNotes || null,
          0, JSON.stringify(calc), calc.subtotal, calc.total, expiresAt, now, now, now
        );
      const quoteId = qInfo.lastInsertRowid;

      const insItem = db.prepare(`INSERT INTO quote_items (quote_id,color_name,color_hex,size_label,quantity,unit_surcharge) VALUES (?,?,?,?,?,?)`);
      for (const line of calc.lines) insItem.run(quoteId, line.colorName, line.colorHex, line.sizeLabel, line.quantity, line.unitSurcharge);

      const insLoc = db.prepare(`INSERT INTO quote_print_locations (quote_id,print_location_id,location_name,addon_price_each) VALUES (?,?,?,?)`);
      for (const loc of calc.printLocations) insLoc.run(quoteId, loc.id, loc.name, loc.addonEach);

      if (b.draftToken) {
        db.prepare('UPDATE artwork_files SET quote_id = ? WHERE draft_token = ? AND quote_id IS NULL').run(quoteId, b.draftToken);
      }

      db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?,?,?)`)
        .run(quoteId, 'generated', `Quote generated for ${calc.totalQty} pcs, total $${calc.total.toFixed(2)}.`);

      return { quoteId, quoteCode, customer };
    });

    const { quoteId, quoteCode, customer } = tx();
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    emailService.sendQuoteEmail(quote, customer, baseUrl).catch(err => console.error('Email send failed:', err));

    res.json({ quoteCode, quoteId });
  } catch (err) {
    if (err instanceof PricingError) {
      if (err.message === 'BULK_QUOTE_REQUIRED') return res.status(200).json({ bulkQuoteRequired: true });
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
    printLocationIds: db.prepare('SELECT print_location_id FROM quote_print_locations WHERE quote_id=?').all(quote.id).map(r => r.print_location_id),
    discretionaryAdjustment: quote.discretionary_adjustment,
    floorOverride: !!quote.floor_override,
    overrideUnitPrice: quote.floor_override ? quote.override_unit_price : undefined,
  }, snapshot.pricingTablesSnapshot); // price against the FROZEN snapshot tables, not live ones

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
  db.prepare('UPDATE quotes SET pricing_snapshot=?, subtotal=?, total=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(recomputed), recomputed.subtotal, recomputed.total, new Date().toISOString(), quote.id);

  try {
    const checkout = await paymentService.createCheckoutForQuote({ ...quote, pricing_snapshot: JSON.stringify(recomputed) }, customer);
    db.prepare("UPDATE quotes SET status='checkout_started', checkout_started_at=COALESCE(checkout_started_at,?), payment_provider=?, shopify_draft_order_id=? WHERE id=?")
      .run(new Date().toISOString(), checkout.provider, checkout.provider === 'shopify' ? checkout.providerRef : null, quote.id);
    db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'checkout_started', ?)`)
      .run(quote.id, `Provider: ${checkout.provider}`);
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

router.post('/mock-payment/:code/confirm', (req, res) => {
  try {
    const quote = paymentService.confirmMockPayment(req.params.code);
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
      printLocationIds: db.prepare('SELECT print_location_id FROM quote_print_locations WHERE quote_id=?').all(quote.id).map(r => r.print_location_id),
      discretionaryAdjustment: 0,
    }); // against LIVE tables — this is a fresh quote
    const expirationDays = getSettingNum('quote_expiration_days', 7);
    const expiresAt = new Date(Date.now() + expirationDays * 86400000).toISOString();
    db.prepare(`UPDATE quotes SET pricing_snapshot=?, subtotal=?, total=?, expires_at=?, status='quote_generated', updated_at=? WHERE id=?`)
      .run(JSON.stringify(calc), calc.subtotal, calc.total, expiresAt, new Date().toISOString(), quote.id);
    db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'edited', 'Recalculated after expiration.')`).run(quote.id);
    res.json({ ok: true, quoteCode: quote.quote_code });
  } catch (err) {
    res.status(400).json({ error: err instanceof PricingError ? err.message : 'Could not recalculate.' });
  }
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
    standardUnit: calc.standardUnit,          // fine to show — this IS the advertised price
    finalBaseUnit: calc.finalBaseUnit,
    printLocations: calc.printLocations.map(p => ({ name: p.name, included: p.included, addonEach: p.addonEach })),
    addonLines: calc.addonLines,
    addonLinesTotal: calc.addonLinesTotal,
    surchargedLines: calc.surchargedLines.map(l => ({ colorName: l.colorName, sizeLabel: l.sizeLabel, quantity: l.quantity, unitSurcharge: l.unitSurcharge })),
    sizeSurchargeTotal: calc.sizeSurchargeTotal,
    baseLineTotal: calc.baseLineTotal,
    subtotal: calc.subtotal,
    total: calc.total,
    garment: calc.garment,
    // deliberately omitted: floorUnit, maxDiscount, adjustment, belowFloor, internal.*
  };
}

module.exports = router;
