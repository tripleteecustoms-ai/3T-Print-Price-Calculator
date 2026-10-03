// server/pricingTables.js
//
// Trey's official price tables (Sept 2026), in one place so the seed, the
// one-time tier migration, and "Add Garment" all agree.
//
//  - SHIRT_PRICES: Standard Quality T-Shirt, front print included.
//  - ADDON_PRICES: per-piece add-on print prices by column. Front is
//    included in the shirt price, so it has no add-on.
//
// The two tables use different quantity breakpoints, but the app has one
// shared quantity_tiers table. buildTierDefs() makes a tier for every
// breakpoint in EITHER table (the union), so every quantity lands in a tier
// whose shirt price AND add-on price both match the tables exactly.

// [minQty, price]. Each row applies from minQty up to the next row's minQty - 1.
const SHIRT_PRICES = [
  [1, 35.00], [2, 31.00], [3, 28.00], [4, 26.00], [6, 25.00], [8, 24.00],
  [10, 23.00], [12, 22.00], [15, 21.00], [18, 20.00], [21, 19.50],
  [25, 19.00], [30, 18.50], [35, 18.00], [40, 17.50], [45, 16.50],
  [49, 15.75], [51, 15.50], [60, 15.25], [70, 15.00], [80, 14.75],
  [90, 14.50], [100, 14.25], [125, 14.00], [150, 13.75], [175, 13.50],
  [200, 13.25], [250, 13.00], [300, 12.50], [400, 12.00], [500, 11.50],
  [600, 11.00], [750, 10.50], [1000, 10.00],
];

// [minQty, back, chest, sleeve]
const ADDON_PRICES = [
  [1, 10.00, 5.50, 6.50], [2, 9.50, 5.25, 6.20], [3, 9.00, 5.00, 5.85],
  [5, 8.25, 4.50, 5.30], [7, 7.50, 4.10, 4.80], [9, 6.50, 3.60, 4.20],
  [12, 5.82, 3.20, 3.78], [16, 5.55, 3.05, 3.60], [20, 5.25, 2.90, 3.40],
  [24, 5.00, 2.75, 3.25], [30, 4.90, 2.70, 3.20], [40, 4.80, 2.65, 3.15],
  [50, 4.75, 2.60, 3.10], [75, 4.60, 2.55, 3.00], [100, 4.50, 2.50, 2.95],
  [150, 4.40, 2.45, 2.85], [200, 4.30, 2.40, 2.80], [250, 4.25, 2.35, 2.75],
  [350, 4.10, 2.25, 2.65], [500, 4.00, 2.20, 2.60], [750, 3.85, 2.10, 2.50],
  [1000, 3.75, 2.05, 2.45],
];
const ADDON_COLUMN_INDEX = { back: 1, chest: 2, sleeve: 3 };

// Which add-on column each built-in print location uses. Upper Back uses
// the Sleeve column. Locations not listed here (custom ones an admin added)
// keep whatever prices they had.
const LOCATION_ADDON_COLUMN = {
  back: 'back',
  left_chest: 'chest',
  right_chest: 'chest',
  left_sleeve: 'sleeve',
  right_sleeve: 'sleeve',
  upper_back: 'sleeve',
};

const MAX_ORDER_QTY = 10000;
const REVIEW_MIN_QTY = 1000;   // 1,000+ pieces: no instant checkout, Trey reviews first
const FLOOR_PCT = 0.85;        // hard floor = 85% of list
const BASE_SHIRT_PRICE = SHIRT_PRICES[0][1];

// Bumped whenever the tables above change, so the boot-time migration in
// seed.js knows to reinstall them on the live database exactly once.
const PRICING_TABLE_VERSION = '2026-09-shirt-addon-v1';

function rowFor(table, qty) {
  let found = table[0];
  for (const row of table) if (qty >= row[0]) found = row;
  return found;
}

function shirtPriceForQty(qty) { return rowFor(SHIRT_PRICES, qty)[1]; }

function addonPriceForQty(column, qty) {
  const idx = ADDON_COLUMN_INDEX[column];
  if (!idx) throw new Error(`Unknown add-on column "${column}"`);
  return rowFor(ADDON_PRICES, qty)[idx];
}

function formatQty(n) { return n.toLocaleString('en-US'); }

/** The union-of-breakpoints tier list: [{ label, min, max, behavior }]. */
function buildTierDefs() {
  const starts = [...new Set([...SHIRT_PRICES.map(r => r[0]), ...ADDON_PRICES.map(r => r[0])])].sort((a, b) => a - b);
  return starts.map((min, i) => {
    const max = i + 1 < starts.length ? starts[i + 1] - 1 : MAX_ORDER_QTY;
    const label = min === max ? formatQty(min) : (i + 1 < starts.length ? `${formatQty(min)}-${formatQty(max)}` : `${formatQty(min)}+`);
    return { label, min, max, behavior: min >= REVIEW_MIN_QTY ? 'review' : 'immediate' };
  });
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/**
 * List price for a garment at a quantity: the tee price plus the garment's
 * flat upcharge (customer_price_adjustment). A negative adjustment (Hat,
 * Tote) is applied as a ratio instead, ((35 + adj) / 35) x tee price, so
 * the discount shrinks with the tee price and never drives the garment
 * toward $0 at high quantities.
 *
 * teePrice defaults to the official tee table; the S&S sync passes the
 * reference garment's actual current tier price instead, so hand edits to
 * the tee's tier prices carry through to every S&S-priced garment.
 */
function garmentListPrice(adjustment, qty, teePrice) {
  const tee = teePrice != null ? Number(teePrice) : shirtPriceForQty(qty);
  const adj = Number(adjustment) || 0;
  if (adj >= 0) return round2(tee + adj);
  return round2(tee * Math.max(0, BASE_SHIRT_PRICE + adj) / BASE_SHIRT_PRICE);
}

function floorFor(listPrice) { return round2(listPrice * FLOOR_PCT); }

// ------------------------------------------------------------------
// Hats and tote bags have their own price tables (Oct 2026) instead of
// following the tee table. garments.price_table says which one a garment
// uses; empty = the normal tee-based pricing above.
//
//  - hat_dtf:        blank hat ($6.00 fixed) + DTF print/labor, one print location.
//  - hat_embroidery: blank hat ($6.00 fixed) + embroidery/labor.
//  - tote:           standard tote blank + one full-color print location.
// ------------------------------------------------------------------
// [minQty, price each]
const HAT_DTF_PRICES = [[1, 10.00], [5, 8.00], [10, 7.00], [12, 6.50], [24, 5.50], [50, 4.00], [75, 3.50], [100, 3.00]];
const HAT_EMBROIDERY_PRICES = [[1, 15.00], [5, 14.00], [10, 13.00], [12, 12.50], [24, 12.00], [50, 11.00], [75, 10.50], [100, 10.00]];
const TOTE_PRICES = [[1, 20.00], [5, 20.00], [10, 18.00], [12, 17.00], [24, 15.00], [50, 13.00], [75, 12.00], [100, 11.00]];
const HAT_BLANK_PRICE = 6.00;
const PRICE_TABLES = {
  hat_dtf: { label: 'Hat: $6 blank + DTF print', rows: HAT_DTF_PRICES, blank: HAT_BLANK_PRICE },
  hat_embroidery: { label: 'Hat: $6 blank + embroidery', rows: HAT_EMBROIDERY_PRICES, blank: HAT_BLANK_PRICE },
  tote: { label: 'Tote bag (blank + one print)', rows: TOTE_PRICES, blank: 0 },
};
const SPECIAL_PRICE_TABLE_VERSION = '2026-10-hat-tote-v2';

/** What embroidery costs over DTF on a hat, each, at a quantity. */
function hatEmbroideryUpcharge(qty) { return round2(rowFor(HAT_EMBROIDERY_PRICES, qty)[1] - rowFor(HAT_DTF_PRICES, qty)[1]); }

/** List price each from a named table, or null when the garment uses normal tee-based pricing. */
function priceTableListPrice(tableKey, qty) {
  const table = PRICE_TABLES[tableKey];
  if (!table) return null;
  return round2(rowFor(table.rows, qty)[1] + table.blank);
}

/** Rewrites every tier price of a garment from its price table. Returns false when it has none. */
function applyGarmentPriceTable(db, garmentId) {
  const g = db.prepare('SELECT id, price_table FROM garments WHERE id=?').get(garmentId);
  if (!g || !PRICE_TABLES[g.price_table]) return false;
  const upsert = db.prepare(`INSERT INTO garment_tier_prices (garment_id,tier_id,standard_price,hard_floor_price,is_estimated_price,updated_at) VALUES (?,?,?,?,0,?)
    ON CONFLICT(garment_id,tier_id) DO UPDATE SET standard_price=excluded.standard_price, hard_floor_price=excluded.hard_floor_price, is_estimated_price=0, updated_at=excluded.updated_at`);
  const now = new Date().toISOString();
  for (const t of db.prepare('SELECT id, min_qty FROM quantity_tiers').all()) {
    const list = priceTableListPrice(g.price_table, t.min_qty);
    upsert.run(g.id, t.id, list, floorFor(list), now);
  }
  return true;
}

module.exports = {
  SHIRT_PRICES, ADDON_PRICES, LOCATION_ADDON_COLUMN, MAX_ORDER_QTY, REVIEW_MIN_QTY, FLOOR_PCT,
  PRICING_TABLE_VERSION, buildTierDefs, shirtPriceForQty, addonPriceForQty, garmentListPrice, floorFor, round2,
  PRICE_TABLES, SPECIAL_PRICE_TABLE_VERSION, priceTableListPrice, applyGarmentPriceTable, hatEmbroideryUpcharge,
};
