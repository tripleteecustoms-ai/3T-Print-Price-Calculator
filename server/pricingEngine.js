// server/pricingEngine.js
//
// SERVER-AUTHORITATIVE PRICING.
// The browser may show an estimate, but nothing it sends is trusted. Every
// quote and every checkout recalculates from scratch here, using only:
//   - the current (or, for an existing quote, snapshotted) pricing tables
//   - garment/size/print-location IDs (looked up server-side)
//   - quantities
// The client can never say "charge me $X" — only "here are the IDs and counts".

const db = require('./db');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function getSettingNum(key, fallback) {
  const v = getSetting(key, null);
  return v === null ? fallback : Number(v);
}

// The customer builder's steps, in their DEFAULT order. Settings > Layout
// lets the admin store a custom permutation of these same six keys (as the
// `step_order` setting) — the builder just walks them in whatever order
// comes back from /api/business-info. Kept here (rather than duplicated in
// both route files) so admin.js's validation and customer.js's public
// response always agree on the canonical set of step keys.
const BUILDER_STEPS = ['garment', 'color', 'sizes', 'locations', 'artwork', 'contact'];

/**
 * Returns the customer builder's step order as an array, validated to be an
 * exact permutation of BUILDER_STEPS. Falls back to the default order if the
 * stored setting is missing, malformed JSON, or not a clean permutation
 * (e.g. after a partial/corrupt admin save) — the builder must never be
 * handed a step order that omits or duplicates a step.
 */
// The customer builder's contact step ("Settings > Contact Form"): heading,
// which optional fields show (and whether they're required), and the
// "what's this order for" choices. Anything missing or malformed in the
// saved value falls back to these defaults, field by field.
const DEFAULT_CONTACT_FORM = {
  title: 'Your Information',
  subtitle: "We'll use this to send your quote and keep you posted on your order.",
  businessName: { show: true, label: 'Business / Organization', required: false },
  neededByDate: { show: true, label: 'Needed By Date', required: false },
  orderPurpose: { show: true, label: "What's this order for?", options: ['Special Event', 'Branded Merch', 'Promotional', 'Retail', 'Something Else'] },
  additionalNotes: { show: true, label: 'Additional Notes', placeholder: 'Anything else we should know?' },
};
function sanitizeContactForm(input) {
  const src = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_CONTACT_FORM;
  const text = (v, fallback, max) => { const s = typeof v === 'string' ? v.trim().slice(0, max) : ''; return s || fallback; };
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const field = (key) => {
    const f = src[key] && typeof src[key] === 'object' ? src[key] : {};
    return { show: bool(f.show, d[key].show), label: text(f.label, d[key].label, 80), required: bool(f.required, false) };
  };
  const purpose = src.orderPurpose && typeof src.orderPurpose === 'object' ? src.orderPurpose : {};
  const seen = new Set();
  const options = (Array.isArray(purpose.options) ? purpose.options : d.orderPurpose.options)
    .map(o => String(o ?? '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)) // no commas: choices are stored comma-separated
    .filter(o => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()))
    .slice(0, 12);
  const notes = src.additionalNotes && typeof src.additionalNotes === 'object' ? src.additionalNotes : {};
  return {
    title: text(src.title, d.title, 80),
    subtitle: text(src.subtitle, d.subtitle, 240),
    businessName: field('businessName'),
    neededByDate: field('neededByDate'),
    orderPurpose: { show: bool(purpose.show, true), label: text(purpose.label, d.orderPurpose.label, 80), options },
    additionalNotes: { show: bool(notes.show, true), label: text(notes.label, d.additionalNotes.label, 80), placeholder: text(notes.placeholder, d.additionalNotes.placeholder, 160) },
  };
}
function getContactForm() {
  let saved = null;
  try { saved = JSON.parse(getSetting('contact_form', '') || 'null'); } catch (e) {}
  return sanitizeContactForm(saved);
}

// Print-area sizes in inches ("Settings > Layout > Design Sizes"). Standard,
// Large and Oversized are the customer's Design Size choices for full front
// and back prints; Chest and Upper Back are the one size those placements
// come in. Used for the size text in the builder and the design preview.
// `scale` only changes how big the box is drawn on the garment photo.
const DEFAULT_DESIGN_SIZES = {
  standard: { wIn: 11, hIn: 14, scale: 1.09 },
  large: { wIn: 13, hIn: 16, scale: 1 },
  oversized: { wIn: 15.5, hIn: 18, scale: 1.06 },
  chest: { wIn: 4, hIn: 4, scale: 1 },
  upperBack: { wIn: 11, hIn: 4, scale: 1 },
};
function sanitizeDesignSizes(input) {
  const out = {};
  for (const key of Object.keys(DEFAULT_DESIGN_SIZES)) {
    const s = input && input[key];
    const w = Number(s && s.wIn), h = Number(s && s.hIn), k = Number(s && s.scale);
    const ok = (n) => Number.isFinite(n) && n >= 1 && n <= 30;
    out[key] = {
      wIn: ok(w) ? Math.round(w * 100) / 100 : DEFAULT_DESIGN_SIZES[key].wIn,
      hIn: ok(h) ? Math.round(h * 100) / 100 : DEFAULT_DESIGN_SIZES[key].hIn,
      scale: Number.isFinite(k) && k >= 0.5 && k <= 2 ? Math.round(k * 100) / 100 : DEFAULT_DESIGN_SIZES[key].scale,
    };
  }
  return out;
}
function getDesignSizes() {
  return sanitizeDesignSizes(parseJson(getSetting('design_sizes', ''), null));
}

// Design placement previews. A garment's mockup config says where the
// Standard (11 in) print area sits on its front/back photo, as fractions of
// the photo; null means "use the built-in defaults".
function sanitizeMockupConfig(input) {
  const out = {};
  for (const view of ['front', 'back']) {
    const v = input && input[view];
    if (!v || typeof v !== 'object') continue;
    const cx = Number(v.cx), top = Number(v.top), w11 = Number(v.w11);
    if ([cx, top, w11].every(Number.isFinite) && cx >= 0 && cx <= 1 && top >= 0 && top <= 1 && w11 >= 0.05 && w11 <= 1) {
      out[view] = { cx: Math.round(cx * 1e4) / 1e4, top: Math.round(top * 1e4) / 1e4, w11: Math.round(w11 * 1e4) / 1e4 };
    }
  }
  return Object.keys(out).length ? out : null;
}
// What the customer's placement editor sends with a quote: one record per
// print location. Everything is re-checked here because it is stored and
// later shown to the owner and the customer.
const PLACEMENT_IMAGE_RE = /^(https:\/\/(www|cdn)\.ssactivewear\.com\/[\w\-./]+|\/uploads\/[\w\-.]+)$/i;
const PLACEMENT_ARTWORK_RE = /^\/uploads\/[\w\-.]+$/;
function sanitizePlacements(list) {
  if (!Array.isArray(list)) return [];
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 1e4) / 1e4 : null; };
  const rect = (r) => {
    if (!r || typeof r !== 'object') return null;
    const out = { x: num(r.x, -0.5, 1.5), y: num(r.y, -0.5, 1.5), w: num(r.w, 0.001, 1.5), h: num(r.h, 0.001, 1.5) };
    return Object.values(out).every(v => v != null) ? out : null;
  };
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const seen = new Set();
  const out = [];
  for (const p of list.slice(0, 12)) {
    if (!p || typeof p !== 'object') continue;
    const locationCode = text(p.locationCode, 40);
    const zone = rect(p.zone), design = rect(p.design);
    const inches = { widthIn: num(p.widthIn, 0.1, 40), heightIn: num(p.heightIn, 0.1, 60), zoneWidthIn: num(p.zoneWidthIn, 0.5, 40), zoneHeightIn: num(p.zoneHeightIn, 0.5, 60), fromLeftIn: num(p.fromLeftIn, 0, 40), fromTopIn: num(p.fromTopIn, 0, 60) };
    if (!/^[a-z0-9_]+$/.test(locationCode) || seen.has(locationCode) || !zone || !design) continue;
    if (!PLACEMENT_IMAGE_RE.test(String(p.imageUrl || '')) || !PLACEMENT_ARTWORK_RE.test(String(p.artworkUrl || ''))) continue;
    if (Object.values(inches).some(v => v == null)) continue;
    seen.add(locationCode);
    out.push({
      locationCode, locationName: text(p.locationName, 80), view: p.view === 'back' ? 'back' : 'front', colorName: text(p.colorName, 80),
      fileName: text(p.fileName, 200), fileType: text(p.fileType, 20).replace(/[^A-Za-z0-9+]/g, ''),
      imageUrl: String(p.imageUrl), artworkUrl: String(p.artworkUrl),
      designSize: ['chest', 'standard', 'large', 'oversized'].includes(p.designSize) ? p.designSize : null,
      areaLabel: text(p.areaLabel, 80),
      zone, design, ...inches,
    });
  }
  return out;
}
function parseJson(raw, fallback) { try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } }

function getStepOrder() {
  const raw = getSetting('step_order', null);
  if (!raw) return [...BUILDER_STEPS];
  try {
    const parsed = JSON.parse(raw);
    if (isValidStepOrder(parsed)) return parsed;
  } catch (e) {}
  return [...BUILDER_STEPS];
}

function isValidStepOrder(arr) {
  if (!Array.isArray(arr) || arr.length !== BUILDER_STEPS.length) return false;
  const sortedGiven = [...arr].sort();
  const sortedCanonical = [...BUILDER_STEPS].sort();
  return sortedGiven.every((v, i) => v === sortedCanonical[i]);
}

// ==================================================================
// PHASE 2: quantity tiers (1-10,000) replacing the old 1-24 exact-quantity
// matrix. See README / rebuild-plan report for the full migration story.
// ==================================================================
const MAX_QTY = 10000;
const MAX_QTY_MESSAGE = 'For orders above 10,000 pieces, contact 3T Print Solutions for a custom production proposal.';

/** All active quantity tiers, in display/sort order. */
function getQuantityTiers() {
  return db.prepare('SELECT * FROM quantity_tiers WHERE active = 1 ORDER BY sort_order').all();
}

/** Find the tier a given quantity falls in (from an already-loaded tier list, or freshly loaded). */
function findTierForQty(qty, tiers) {
  const list = tiers || getQuantityTiers();
  return list.find(t => qty >= t.min_qty && qty <= t.max_qty) || null;
}

/**
 * margin_based pricing_mode: Selling Price = Total Unit Cost / (1 - Target
 * Gross Margin), exactly as the rebuild doc specifies. Verified against its
 * own worked example: $10.00 total cost, 40% target margin -> $16.67 (see
 * test-margin-pricing.js).
 *
 * totalUnitCost is assembled from the flat (tier-invariant) cost fields plus
 * the tier's freight-per-unit, then loaded with the spoilage/payment-
 * processing allowances (modeled as cost-side % markups on that subtotal,
 * consistent with how the doc lists them alongside the other cost fields
 * rather than as a separate percent-of-revenue divisor term).
 */
function computeMarginBasedPrice(costInputs, freightPerUnit) {
  const flatSubtotal = round2(
    Number(costInputs.garment_cost || 0) +
    Number(freightPerUnit || 0) +
    Number(costInputs.dtf_transfer_cost || 0) +
    Number(costInputs.pressing_labor || 0) +
    Number(costInputs.finishing_packaging || 0) +
    Number(costInputs.overhead || 0)
  );
  const spoilageAllowance = round2(flatSubtotal * (Number(costInputs.spoilage_pct || 0) / 100));
  const paymentProcessingAllowance = round2(flatSubtotal * (Number(costInputs.payment_processing_pct || 0) / 100));
  const totalUnitCost = round2(flatSubtotal + spoilageAllowance + paymentProcessingAllowance);
  return { totalUnitCost, sellingPrice: sellingPriceFromCost(totalUnitCost, costInputs.target_margin_pct) };
}

/** The core formula in isolation — Total Unit Cost / (1 - Target Gross Margin). */
function sellingPriceFromCost(totalUnitCost, targetMarginPct) {
  const marginFraction = Number(targetMarginPct || 0) / 100;
  if (marginFraction >= 1) return totalUnitCost; // guard against divide-by-zero/negative on a bad 100%+ input
  return round2(totalUnitCost / (1 - marginFraction));
}

/** Build the live pricing snapshot object (tables as they exist right now), scoped to one garment. */
function buildLivePricingTables(garmentId) {
  const tierRows = getQuantityTiers();
  const locations = db.prepare('SELECT * FROM print_locations WHERE active = 1 ORDER BY sort_order').all();

  const locationTierPricing = {}; // { locationId: { tierId: { addon, estimated } } }
  for (const loc of locations) {
    const rows = db.prepare('SELECT tier_id, addon_price, is_estimated_price FROM print_location_tier_pricing WHERE print_location_id = ?').all(loc.id);
    locationTierPricing[loc.id] = Object.fromEntries(rows.map(r => [r.tier_id, { addon: r.addon_price, estimated: !!r.is_estimated_price }]));
  }

  const garment = garmentId ? db.prepare('SELECT * FROM garments WHERE id = ?').get(garmentId) : null;
  const garmentTierPrices = {}; // { tierId: { standard, floor, estimated } }
  let costInputs = null;
  let tierFreight = {}; // { tierId: freightPerUnit }
  if (garment) {
    if (garment.pricing_mode === 'margin_based') {
      costInputs = db.prepare('SELECT * FROM garment_cost_inputs WHERE garment_id = ?').get(garment.id) || {};
      const freightRows = db.prepare('SELECT tier_id, freight_per_unit FROM garment_tier_freight WHERE garment_id = ?').all(garment.id);
      tierFreight = Object.fromEntries(freightRows.map(r => [r.tier_id, r.freight_per_unit]));
      for (const tier of tierRows) {
        const { totalUnitCost, sellingPrice } = computeMarginBasedPrice(costInputs, tierFreight[tier.id] || 0);
        // margin_based has no separate admin-set floor — the natural floor is
        // "never sell below the fully-loaded cost without an explicit override".
        garmentTierPrices[tier.id] = { standard: sellingPrice, floor: totalUnitCost, estimated: false };
      }
    } else {
      const rows = db.prepare('SELECT tier_id, standard_price, hard_floor_price, is_estimated_price FROM garment_tier_prices WHERE garment_id = ?').all(garment.id);
      for (const r of rows) garmentTierPrices[r.tier_id] = { standard: r.standard_price, floor: r.hard_floor_price, estimated: !!r.is_estimated_price };
    }
  }

  // Hats priced from the DTF table can be embroidered instead: what that
  // adds per hat at each tier (embroidery table minus DTF table).
  let embroideryUpcharge = null; // { tierId: $ each }
  if (garment && garment.price_table === 'hat_dtf') {
    const { hatEmbroideryUpcharge } = require('./pricingTables');
    embroideryUpcharge = Object.fromEntries(tierRows.map(t => [t.id, hatEmbroideryUpcharge(t.min_qty)]));
  }

  return {
    version: new Date().toISOString(),
    quantityTiers: tierRows,
    garmentPricingMode: garment ? garment.pricing_mode : null,
    embroideryUpcharge,
    garmentTierPrices,
    locations,
    locationTierPricing,
    costs: {
      blank_cost: getSettingNum('blank_cost', 3.5),
      front_transfer_cost: getSettingNum('front_transfer_cost', 2.75),
      labor_cost: getSettingNum('labor_cost', 2.5),
      back_transfer_cost: getSettingNum('back_transfer_cost', 2.75),
    },
    designSizeSurcharges: {
      chest: 0, // the included front print done left-chest size instead of full front
      standard: 0,
      large: getSettingNum('design_size_large_surcharge', 1.50),
      oversized: getSettingNum('design_size_oversized_surcharge', 2.50),
    },
  };
}

const DESIGN_SIZE_LABELS = { chest: 'Left Chest', standard: 'Standard', large: 'Large Graphic', oversized: 'Oversized' };

/**
 * Calculate a full quote.
 *
 * @param {object} input
 *   garmentId, colorSelections: [{colorName, colorHex, sizes: [{label, qty}]}]
 *   printLocationIds: [int | {id:int, designSize:'standard'|'large'|'oversized'}]
 *   decoration: 'dtf' | 'embroidery' (hats only; ignored for everything else)
 *   discretionaryAdjustment: number (per-shirt $, owner-only; 0 for customer-generated quotes)
 *   floorOverride: bool (owner explicitly went below floor)
 * @param {object} [pricingTables] - pass a snapshot to price against frozen historical data;
 *   omit to price against the live/current tables.
 */
function calculateQuote(input, pricingTables) {
  // Stickers, posters and mylar packs are priced from the print catalog, not
  // the garment tables (required here, not at the top: that file needs this one).
  if (input.printSelection) return require('./printProducts').calculatePrintQuote(input, pricingTables);

  const tables = pricingTables || buildLivePricingTables(input.garmentId);

  const garment = db.prepare('SELECT * FROM garments WHERE id = ?').get(input.garmentId);
  if (!garment) throw new PricingError('Unknown garment.');

  const sizeRows = db.prepare('SELECT label, surcharge FROM garment_sizes WHERE garment_id = ? AND active = 1').all(garment.id);
  const surchargeBySize = Object.fromEntries(sizeRows.map(s => [s.label, s.surcharge]));

  // Flatten all color/size lines and total quantity
  const lines = [];
  let totalQty = 0;
  for (const sel of input.colorSelections || []) {
    for (const sz of sel.sizes || []) {
      const qty = Math.max(0, Math.floor(Number(sz.qty) || 0));
      if (qty <= 0) continue;
      if (!(sz.label in surchargeBySize)) {
        throw new PricingError(`Size "${sz.label}" is not available for this garment.`);
      }
      lines.push({
        colorName: sel.colorName,
        colorHex: sel.colorHex || null,
        sizeLabel: sz.label,
        quantity: qty,
        unitSurcharge: surchargeBySize[sz.label] || 0,
      });
      totalQty += qty;
    }
  }

  if (totalQty < 1) throw new PricingError('Add at least one shirt to your order.');
  if (!Number.isInteger(totalQty)) throw new PricingError('Quantities must be whole numbers.');
  if (totalQty > MAX_QTY) throw new PricingError(MAX_QTY_MESSAGE);

  const quantityTier = findTierForQty(totalQty, tables.quantityTiers);
  if (!quantityTier) throw new PricingError(`No pricing tier configured for quantity ${totalQty}.`);

  const tierPrice = tables.garmentTierPrices[quantityTier.id];
  if (!tierPrice) throw new PricingError(`No pricing configured for this garment at quantity ${totalQty}.`);

  // Decoration method: only hats offer a choice (DTF print or embroidery).
  // Embroidery costs more per hat; the difference is part of the unit price.
  let decoration = null;
  if (tables.embroideryUpcharge) {
    const embroidered = input.decoration === 'embroidery';
    const upchargeEach = embroidered ? round2(tables.embroideryUpcharge[quantityTier.id] || 0) : 0;
    decoration = { method: embroidered ? 'embroidery' : 'dtf', label: embroidered ? 'Embroidery' : 'DTF Print', upchargeEach };
  }
  const decorationEach = decoration ? decoration.upchargeEach : 0;

  const standardUnit = round2(tierPrice.standard + decorationEach);
  const floorUnit = round2(tierPrice.floor + decorationEach);
  const isEstimatedPrice = !!tierPrice.estimated;
  const maxDiscount = Math.round((standardUnit - floorUnit) * 100) / 100;

  let adjustment = Number(input.discretionaryAdjustment) || 0;
  if (adjustment < 0) adjustment = 0;

  let finalBaseUnit = Math.max(standardUnit - adjustment, floorUnit);
  let belowFloor = false;
  if (input.floorOverride && input.overrideUnitPrice != null) {
    // Owner explicitly typed a price below the floor with confirmation.
    finalBaseUnit = Math.max(0, Number(input.overrideUnitPrice));
    belowFloor = finalBaseUnit < floorUnit - 0.0001;
  }
  // NOTE: garment.customer_price_adjustment is NOT re-applied here — under
  // the Phase 2 tier model each garment's per-tier standard/floor prices are
  // directly admin-editable (and were seeded already including any prior
  // adjustment, see seed.js's migration), so adding it again would double-
  // count it. The column/admin field is kept only for backward-compat
  // display; it no longer affects the calculated price.

  // Print locations — each entry is either a plain location id (legacy /
  // no design-size chosen -> defaults to "standard", no surcharge) or
  // { id, designSize } from the artwork step's per-location size selector.
  const seenLocationIds = new Set();
  const selectedLocations = [];
  for (const entry of input.printLocationIds || []) {
    const isObj = entry !== null && typeof entry === 'object';
    const id = isObj ? entry.id : entry;
    if (seenLocationIds.has(id)) continue;
    seenLocationIds.add(id);
    const designSize = isObj && entry.designSize ? entry.designSize : 'standard';
    if (!(designSize in tables.designSizeSurcharges)) {
      throw new PricingError(`Unknown design size "${designSize}".`);
    }
    selectedLocations.push({ id, designSize });
  }
  // "Chest" is a size of the included front print only. A garment whose
  // front can only take a chest print (polos) always gets that size.
  for (const sel of selectedLocations) {
    const loc = tables.locations.find(l => l.id === sel.id);
    const isFront = !!(loc && loc.included_in_base);
    if (isFront && garment.front_chest_only) sel.designSize = 'chest';
    else if (!isFront && sel.designSize === 'chest') sel.designSize = 'standard';
  }

  const printLocations = [];
  let addonPerUnit = 0;
  for (const { id: locId, designSize } of selectedLocations) {
    const loc = tables.locations.find(l => l.id === locId);
    if (!loc) throw new PricingError('Unknown print location selected.');
    const locTierEntry = loc.included_in_base ? null : tables.locationTierPricing[locId]?.[quantityTier.id];
    const addon = loc.included_in_base ? 0 : (locTierEntry ? locTierEntry.addon : null);
    if (addon === null || addon === undefined) throw new PricingError(`No pricing configured for ${loc.name} at quantity ${totalQty}.`);
    const designSizeSurchargeEach = tables.designSizeSurcharges[designSize] || 0;
    printLocations.push({
      id: loc.id, name: loc.name, included: !!loc.included_in_base, addonEach: addon, internalCostEach: loc.internal_cost_per_unit,
      designSize, designSizeSurchargeEach, addonEstimated: locTierEntry ? !!locTierEntry.estimated : false,
    });
    if (!loc.included_in_base) addonPerUnit += addon;
  }
  // Front is required by the business model; if the customer picked no
  // locations at all, default to Front so a shirt is always printable.
  if (printLocations.length === 0) {
    const front = tables.locations.find(l => l.included_in_base);
    if (front) printLocations.push({ id: front.id, name: front.name, included: true, addonEach: 0, internalCostEach: front.internal_cost_per_unit, designSize: garment.front_chest_only ? 'chest' : 'standard', designSizeSurchargeEach: 0 });
  }

  // Itemized totals
  const baseLineTotal = round2(finalBaseUnit * totalQty);
  const addonLines = printLocations.filter(p => !p.included).map(p => ({
    name: p.name, each: p.addonEach, qty: totalQty, total: round2(p.addonEach * totalQty),
  }));
  const addonLinesTotal = round2(addonLines.reduce((s, l) => s + l.total, 0));

  const surchargedLines = lines.filter(l => l.unitSurcharge > 0);
  const sizeSurchargeTotal = round2(surchargedLines.reduce((s, l) => s + l.unitSurcharge * l.quantity, 0));

  const designSizeLines = printLocations.filter(p => p.designSizeSurchargeEach > 0).map(p => ({
    locationName: p.name, designSize: p.designSize, designSizeLabel: DESIGN_SIZE_LABELS[p.designSize] || p.designSize,
    each: p.designSizeSurchargeEach, qty: totalQty, total: round2(p.designSizeSurchargeEach * totalQty),
  }));
  const designSizeSurchargeTotal = round2(designSizeLines.reduce((s, l) => s + l.total, 0));

  const subtotal = round2(baseLineTotal + addonLinesTotal + sizeSurchargeTotal + designSizeSurchargeTotal);

  const { discount, discountError } = resolveDiscount(input, subtotal);
  const discountAmount = discount ? discount.amount : 0;
  const total = round2(Math.max(0, subtotal - discountAmount));

  // ---- internal cost & margin (never returned to customer-facing endpoints) ----
  const blankCost = garment.internal_cost > 0 ? garment.internal_cost : tables.costs.blank_cost;
  const printInternalCostEach = printLocations.reduce((s, p) => s + (p.internalCostEach || 0), 0);
  const directCostUnit = round2(blankCost + tables.costs.labor_cost + printInternalCostEach);
  const directCostTotal = round2(directCostUnit * totalQty);
  const finalUnitPriceAvg = round2(total / totalQty); // blended, for display only — reflects any applied discount
  const grossProfitTotal = round2(total - directCostTotal);
  const grossMarginPct = total > 0 ? round2((grossProfitTotal / total) * 100) : 0;
  // Informational only (never blocks the customer-facing flow) — flags a
  // quote for the admin UI to badge when it's priced below the configurable
  // "minimum target margin" setting. Default seeded at 20%, a generic
  // placeholder that needs Trey's real input (see Settings > Pricing).
  const minimumTargetMarginPct = getSettingNum('minimum_target_margin_pct', 20);
  const belowMinimumMargin = total > 0 && grossMarginPct < minimumTargetMarginPct;

  return {
    garment: { id: garment.id, name: garment.name + (decoration && decoration.method === 'embroidery' ? ' (Embroidered)' : ''), isOther: !!garment.is_other },
    decoration,
    totalQty,
    lines,
    quantityTier: quantityTier ? { id: quantityTier.id, label: quantityTier.label, checkoutBehavior: quantityTier.checkout_behavior } : null,
    isEstimatedPrice,
    standardUnit, floorUnit, maxDiscount,
    adjustment, finalBaseUnit, belowFloor,
    printLocations, addonLines, addonLinesTotal,
    surchargedLines, sizeSurchargeTotal,
    designSizeLines, designSizeSurchargeTotal,
    baseLineTotal, subtotal,
    discount, discountError, discountAmount,
    total, // = subtotal - discountAmount; shipping/tax calculated at checkout
    internal: {
      blankCost, directCostUnit, directCostTotal,
      grossProfitTotal, grossMarginPct,
      marginStatus: marginStatus(grossMarginPct),
      minimumTargetMarginPct, belowMinimumMargin,
    },
    pricingTablesVersion: tables.version,
    pricingTablesSnapshot: tables,
  };
}

/**
 * Look up input.discountCode against a subtotal. Shared by apparel and print
 * product quotes. Returns { discount, discountError }.
 */
function resolveDiscount(input, subtotal) {
  // ---- discount code (never trust a client-supplied amount — only the code) ----
  // A bad/expired/exhausted code is NOT a hard error — the customer just
  // doesn't get a discount, with a reason surfaced via discountError, so a
  // coupon typo never blocks them from seeing a price at all.
  let discount = null;
  let discountError = null;
  const rawCode = (input.discountCode || '').trim();
  if (rawCode) {
    const normalized = rawCode.toUpperCase();
    const row = db.prepare('SELECT * FROM discount_codes WHERE code = ?').get(normalized);
    // When re-deriving pricing for a quote that already has THIS code
    // committed (checkout/recalculate/override all pass discountCode from
    // the quote's own stored discount_code), times_used already counts this
    // quote's own redemption — don't let that count against its own limit.
    const effectiveTimesUsed = (row && input.discountAlreadyApplied) ? Math.max(0, row.times_used - 1) : (row ? row.times_used : 0);
    if (!row) {
      discountError = 'That discount code was not found.';
    } else if (!row.active) {
      discountError = 'That discount code is no longer active.';
    } else if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      discountError = 'That discount code has expired.';
    } else if (row.usage_limit != null && effectiveTimesUsed >= row.usage_limit) {
      discountError = 'That discount code has reached its usage limit.';
    } else {
      const amount = row.type === 'percent'
        ? round2(subtotal * (row.value / 100))
        : Math.min(round2(row.value), subtotal);
      discount = { code: row.code, type: row.type, value: row.value, amount };
    }
  }
  return { discount, discountError };
}

function marginStatus(pct) {
  if (pct >= 55) return 'STRONG';
  if (pct >= 50) return 'ACCEPTABLE';
  if (pct >= 45) return 'CAUTION';
  return 'LOW_MARGIN';
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

class PricingError extends Error {}

module.exports = {
  calculateQuote, resolveDiscount, buildLivePricingTables, getSetting, getSettingNum, marginStatus, PricingError, round2,
  BUILDER_STEPS, getStepOrder, isValidStepOrder, getContactForm, sanitizeContactForm, DEFAULT_CONTACT_FORM,
  sanitizeMockupConfig, sanitizePlacements, parseJson, getDesignSizes, sanitizeDesignSizes, DEFAULT_DESIGN_SIZES,
  getQuantityTiers, findTierForQty, computeMarginBasedPrice, sellingPriceFromCost, MAX_QTY, MAX_QTY_MESSAGE,
};
