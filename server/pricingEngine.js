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

/** Build the live pricing snapshot object (tables as they exist right now). */
function buildLivePricingTables() {
  const tiers = db.prepare('SELECT quantity, standard_price, hard_floor_price FROM pricing_tiers ORDER BY quantity').all();
  const locations = db.prepare('SELECT * FROM print_locations WHERE active = 1 ORDER BY sort_order').all();
  const locationPricing = {};
  for (const loc of locations) {
    const rows = db.prepare('SELECT quantity, addon_price FROM print_location_pricing WHERE print_location_id = ?').all(loc.id);
    locationPricing[loc.id] = Object.fromEntries(rows.map(r => [r.quantity, r.addon_price]));
  }
  return {
    version: new Date().toISOString(),
    tiers: Object.fromEntries(tiers.map(t => [t.quantity, { standard: t.standard_price, floor: t.hard_floor_price }])),
    locations,
    locationPricing,
    costs: {
      blank_cost: getSettingNum('blank_cost', 3.5),
      front_transfer_cost: getSettingNum('front_transfer_cost', 2.75),
      labor_cost: getSettingNum('labor_cost', 2.5),
      back_transfer_cost: getSettingNum('back_transfer_cost', 2.75),
    },
  };
}

/**
 * Calculate a full quote.
 *
 * @param {object} input
 *   garmentId, colorSelections: [{colorName, colorHex, sizes: [{label, qty}]}]
 *   printLocationIds: [int]
 *   discretionaryAdjustment: number (per-shirt $, owner-only; 0 for customer-generated quotes)
 *   floorOverride: bool (owner explicitly went below floor)
 * @param {object} [pricingTables] - pass a snapshot to price against frozen historical data;
 *   omit to price against the live/current tables.
 */
function calculateQuote(input, pricingTables) {
  const tables = pricingTables || buildLivePricingTables();

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
  if (totalQty > 24) {
    throw new PricingError('BULK_QUOTE_REQUIRED');
  }

  const tier = tables.tiers[totalQty];
  if (!tier) throw new PricingError(`No pricing tier configured for quantity ${totalQty}.`);

  const standardUnit = tier.standard;
  const floorUnit = tier.floor;
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

  finalBaseUnit = finalBaseUnit + (garment.customer_price_adjustment || 0);

  // Print locations
  const selectedLocationIds = [...new Set(input.printLocationIds || [])];
  const printLocations = [];
  let addonPerUnit = 0;
  for (const locId of selectedLocationIds) {
    const loc = tables.locations.find(l => l.id === locId);
    if (!loc) throw new PricingError('Unknown print location selected.');
    const addon = loc.included_in_base ? 0 : (tables.locationPricing[locId]?.[totalQty] ?? null);
    if (addon === null) throw new PricingError(`No pricing configured for ${loc.name} at quantity ${totalQty}.`);
    printLocations.push({ id: loc.id, name: loc.name, included: !!loc.included_in_base, addonEach: addon, internalCostEach: loc.internal_cost_per_unit });
    if (!loc.included_in_base) addonPerUnit += addon;
  }
  // Front is required by the business model; if the customer picked no
  // locations at all, default to Front so a shirt is always printable.
  if (printLocations.length === 0) {
    const front = tables.locations.find(l => l.included_in_base);
    if (front) printLocations.push({ id: front.id, name: front.name, included: true, addonEach: 0, internalCostEach: front.internal_cost_per_unit });
  }

  // Itemized totals
  const baseLineTotal = round2(finalBaseUnit * totalQty);
  const addonLines = printLocations.filter(p => !p.included).map(p => ({
    name: p.name, each: p.addonEach, qty: totalQty, total: round2(p.addonEach * totalQty),
  }));
  const addonLinesTotal = round2(addonLines.reduce((s, l) => s + l.total, 0));

  const surchargedLines = lines.filter(l => l.unitSurcharge > 0);
  const sizeSurchargeTotal = round2(surchargedLines.reduce((s, l) => s + l.unitSurcharge * l.quantity, 0));

  const subtotal = round2(baseLineTotal + addonLinesTotal + sizeSurchargeTotal);

  // ---- internal cost & margin (never returned to customer-facing endpoints) ----
  const blankCost = garment.internal_cost > 0 ? garment.internal_cost : tables.costs.blank_cost;
  const printInternalCostEach = printLocations.reduce((s, p) => s + (p.internalCostEach || 0), 0);
  const directCostUnit = round2(blankCost + tables.costs.labor_cost + printInternalCostEach);
  const directCostTotal = round2(directCostUnit * totalQty);
  const finalUnitPriceAvg = round2((subtotal) / totalQty); // blended, for display only
  const grossProfitTotal = round2(subtotal - directCostTotal);
  const grossMarginPct = subtotal > 0 ? round2((grossProfitTotal / subtotal) * 100) : 0;

  return {
    garment: { id: garment.id, name: garment.name },
    totalQty,
    lines,
    standardUnit, floorUnit, maxDiscount,
    adjustment, finalBaseUnit, belowFloor,
    printLocations, addonLines, addonLinesTotal,
    surchargedLines, sizeSurchargeTotal,
    baseLineTotal, subtotal,
    total: subtotal, // shipping/tax calculated at checkout
    internal: {
      blankCost, directCostUnit, directCostTotal,
      grossProfitTotal, grossMarginPct,
      marginStatus: marginStatus(grossMarginPct),
    },
    pricingTablesVersion: tables.version,
    pricingTablesSnapshot: tables,
  };
}

function marginStatus(pct) {
  if (pct >= 55) return 'STRONG';
  if (pct >= 50) return 'ACCEPTABLE';
  if (pct >= 45) return 'CAUTION';
  return 'LOW_MARGIN';
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

class PricingError extends Error {}

module.exports = { calculateQuote, buildLivePricingTables, getSetting, getSettingNum, marginStatus, PricingError, round2 };
