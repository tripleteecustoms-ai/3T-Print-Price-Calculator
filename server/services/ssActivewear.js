// server/services/ssActivewear.js
//
// S&S Activewear API v2 integration (https://api.ssactivewear.com/V2/).
// Auth is HTTP Basic: account number as the username, API key as the
// password, both entered by the owner in Settings > S&S Activewear (or set
// as SS_ACCOUNT_NUMBER / SS_API_KEY env vars). S&S allows 60 requests per
// minute; one sync is one request per garment.
//
// What a sync does for a linked garment:
//  - blank cost = the S&S customerPrice (the owner's account price) of the
//    base sizes (XS-XL, or the one size for hats/bags), taking the highest
//    price across colors so no color is ever quoted below cost
//  - customer price = the reference garment's (Standard Tee's) tier price
//    + (this garment's cost - the tee's cost) x (1 + markup %)
//  - bigger sizes get a surcharge = (size cost - base cost) x (1 + markup %)
//  - colors (name, hex, swatch, front photo), sizes, and per color/size
//    stock are refreshed; colors/sizes S&S no longer carries are hidden
//  - when first linked, the garment photo is set from S&S unless the owner
//    already uploaded their own

const db = require('../db');
const { getSetting } = require('../pricingEngine');
const { garmentListPrice, floorFor, round2 } = require('../pricingTables');

const DEFAULT_API_BASE = 'https://api.ssactivewear.com/v2';
const IMAGE_BASE = 'https://www.ssactivewear.com/';
const BASE_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL', 'OSFA', 'ONE SIZE', 'OS', 'ADJUSTABLE']);
const DEFAULT_MARKUP_PCT = 60;
const PRODUCT_FIELDS = 'sku,styleID,brandName,styleName,colorName,color1,colorSwatchImage,colorFrontImage,sizeName,sizeOrder,customerPrice,piecePrice,qty';

class SsError extends Error {}

function apiBase() {
  return (getSetting('ss_api_base', '') || process.env.SS_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
}
function credentials() {
  return {
    account: (getSetting('ss_account_number', '') || process.env.SS_ACCOUNT_NUMBER || '').trim(),
    apiKey: (getSetting('ss_api_key', '') || process.env.SS_API_KEY || '').trim(),
  };
}
function isConfigured() {
  const { account, apiKey } = credentials();
  return !!(account && apiKey);
}
function markupPct() {
  const v = Number(getSetting('ss_markup_pct', DEFAULT_MARKUP_PCT));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MARKUP_PCT;
}
function referenceGarmentId() {
  const stored = Number(getSetting('ss_reference_garment_id', 0));
  if (stored && db.prepare('SELECT id FROM garments WHERE id=?').get(stored)) return stored;
  const tee = db.prepare("SELECT id FROM garments WHERE name = 'Standard Quality T-Shirt'").get();
  return tee ? tee.id : null;
}

async function ssGet(pathAndQuery) {
  const { account, apiKey } = credentials();
  if (!account || !apiKey) throw new SsError('Add your S&S account number and API key in Settings > S&S Activewear first.');
  let resp;
  try {
    resp = await fetch(apiBase() + pathAndQuery, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${account}:${apiKey}`).toString('base64'),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new SsError(`Could not reach S&S Activewear (${err.message}).`);
  }
  if (resp.status === 401 || resp.status === 403) throw new SsError('S&S rejected the account number or API key. Double-check both in Settings > S&S Activewear.');
  if (resp.status === 404) return [];
  if (resp.status === 429) throw new SsError('S&S rate limit reached (60 requests per minute). Wait a minute and try again.');
  if (!resp.ok) throw new SsError(`S&S returned an error (HTTP ${resp.status}).`);
  const body = await resp.json().catch(() => null);
  if (!Array.isArray(body)) throw new SsError('S&S returned an unexpected response.');
  return body;
}

function fullImageUrl(p) {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return IMAGE_BASE + String(p).replace(/^\/+/, '');
}
function priceOf(p) {
  return Number(p.customerPrice) || Number(p.piecePrice) || 0;
}
function validHex(h) {
  return /^#?[0-9a-f]{6}$/i.test(String(h || '')) ? (String(h).startsWith('#') ? h : '#' + h) : null;
}

/** Find S&S styles by free text ("Gildan 5000", "18500", "hoodie"). */
async function searchStyles(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const rows = await ssGet('/styles/?search=' + encodeURIComponent(q));
  return rows.slice(0, 25).map(s => ({
    styleID: s.styleID, brandName: s.brandName, styleName: s.styleName, title: s.title,
    description: s.description || '', baseCategory: s.baseCategory || '', styleImage: fullImageUrl(s.styleImage),
  }));
}

/** Resolve "Brand Style" (or a bare style number / styleID) to one S&S style, preferring an exact match. */
async function resolveStyle(query) {
  const q = String(query || '').trim();
  if (/^\d+$/.test(q)) {
    const byId = await ssGet('/styles/?styleid=' + encodeURIComponent(q));
    if (byId.length) return byId[0];
  }
  const rows = await ssGet('/styles/?search=' + encodeURIComponent(q));
  if (!rows.length) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(q);
  return rows.find(s => norm(`${s.brandName}${s.styleName}`) === target)
    || rows.find(s => norm(s.styleName) === target)
    || rows.find(s => target.endsWith(norm(s.styleName)) && target.startsWith(norm(s.brandName).slice(0, 4)))
    || (rows.length === 1 ? rows[0] : null);
}

async function fetchProducts(styleID) {
  try {
    return await ssGet(`/products/?styleid=${encodeURIComponent(styleID)}&fields=${PRODUCT_FIELDS}`);
  } catch (err) {
    // If S&S ever refuses the fields filter on this query, fall back to the full payload.
    if (err instanceof SsError && /HTTP 400/.test(err.message)) return ssGet(`/products/?styleid=${encodeURIComponent(styleID)}`);
    throw err;
  }
}

/** Boil S&S's one-row-per-SKU product list down to costs, colors, sizes, and stock. */
function summarizeProducts(products) {
  const colors = new Map();  // name -> { hex, swatch, image, stock: {size: qty} }
  const sizes = new Map();   // name -> { order, cost (max across colors) }
  for (const p of products) {
    const colorName = String(p.colorName || '').trim();
    const sizeName = String(p.sizeName || '').trim();
    if (!colorName || !sizeName) continue;
    if (!colors.has(colorName)) {
      colors.set(colorName, { hex: validHex(p.color1), swatch: fullImageUrl(p.colorSwatchImage), image: fullImageUrl(p.colorFrontImage), stock: {} });
    }
    colors.get(colorName).stock[sizeName] = Math.max(0, Math.floor(Number(p.qty) || 0));
    const price = priceOf(p);
    const s = sizes.get(sizeName) || { order: p.sizeOrder != null ? String(p.sizeOrder) : sizeName, cost: 0 };
    s.cost = Math.max(s.cost, price);
    sizes.set(sizeName, s);
  }
  const sizeList = [...sizes.entries()].map(([label, s]) => ({ label, order: s.order, cost: round2(s.cost) }))
    .sort((a, b) => a.order.localeCompare(b.order, 'en', { numeric: true }));
  let baseSizes = sizeList.filter(s => BASE_SIZES.has(s.label.toUpperCase()));
  if (!baseSizes.length) baseSizes = sizeList.length ? [sizeList.reduce((lo, s) => (s.cost < lo.cost ? s : lo))] : [];
  const baseCost = round2(Math.max(0, ...baseSizes.map(s => s.cost)));
  return { colors, sizes: sizeList, baseCost };
}

/**
 * Link (if needed) and sync one garment. Returns a short summary.
 * opts.styleQuery: link to this S&S style first ("Gildan 18500" or a styleID).
 */
async function syncGarment(garmentId, opts = {}) {
  let garment = db.prepare('SELECT * FROM garments WHERE id=?').get(garmentId);
  if (!garment) throw new SsError('Garment not found.');

  let styleID = garment.ss_style_id;
  let styleName = garment.ss_style_name;
  if (opts.styleQuery || !styleID) {
    const query = opts.styleQuery || `${garment.brand || ''} ${garment.style_number || ''}`.trim();
    if (!query) throw new SsError('Enter an S&S style (for example "Gildan 5000") to link this garment.');
    const style = await resolveStyle(query);
    if (!style) throw new SsError(`S&S has no style matching "${query}". Try the exact brand and style number as S&S lists it, or use Import from S&S to search.`);
    styleID = style.styleID;
    styleName = `${style.brandName} ${style.styleName}`;
    db.prepare('UPDATE garments SET ss_style_id=?, ss_style_name=?, updated_at=? WHERE id=?').run(styleID, styleName, new Date().toISOString(), garmentId);
    if (!garment.image_url && style.styleImage) {
      db.prepare('UPDATE garments SET image_url=? WHERE id=?').run(fullImageUrl(style.styleImage), garmentId);
    }
    garment = db.prepare('SELECT * FROM garments WHERE id=?').get(garmentId);
  }

  let products;
  try {
    products = await fetchProducts(styleID);
    if (!products.length) throw new SsError(`S&S returned no products for ${styleName || 'style ' + styleID}.`);
  } catch (err) {
    db.prepare('UPDATE garments SET ss_sync_error=? WHERE id=?').run(err.message, garmentId);
    throw err;
  }
  const summary = summarizeProducts(products);
  const markup = 1 + markupPct() / 100;
  const refId = referenceGarmentId();
  const isReference = refId === garment.id;

  // The upcharge needs the reference tee's cost; sync it first if it's linked but never synced.
  let refCost = null;
  if (!isReference && refId) {
    let ref = db.prepare('SELECT id, ss_cost, ss_style_id FROM garments WHERE id=?').get(refId);
    if (ref && ref.ss_cost == null && !opts._syncingReference) {
      await syncGarment(refId, { _syncingReference: true }).catch(() => {});
      ref = db.prepare('SELECT id, ss_cost FROM garments WHERE id=?').get(refId);
    }
    refCost = ref ? ref.ss_cost : null;
  }

  const now = new Date().toISOString();
  const totalStock = [...summary.colors.values()].reduce((sum, c) => sum + Object.values(c.stock).reduce((a, b) => a + b, 0), 0);
  const inventoryStatus = totalStock === 0 ? 'out_of_stock' : totalStock < 500 ? 'low_stock' : 'in_stock';
  let upcharge = null;
  let repriced = false;

  db.transaction(() => {
    // ---- cost + status (the garment photo was set from S&S when linked, only if the owner had none) ----
    db.prepare(`UPDATE garments SET internal_cost=?, ss_cost=?, ss_last_sync=?, ss_sync_error=NULL, supplier='S&S Activewear',
      supplier_sku=?, last_cost_update=?, inventory_status=?, updated_at=? WHERE id=?`)
      .run(summary.baseCost, summary.baseCost, now, String(styleID), now.slice(0, 10), inventoryStatus, now, garment.id);
    db.prepare('INSERT INTO garment_cost_inputs (garment_id, garment_cost) VALUES (?,?) ON CONFLICT(garment_id) DO UPDATE SET garment_cost=excluded.garment_cost, updated_at=CURRENT_TIMESTAMP')
      .run(garment.id, summary.baseCost);

    // ---- colors: upsert by name, hide ones S&S no longer carries ----
    const existingColors = db.prepare('SELECT * FROM garment_colors WHERE garment_id=?').all(garment.id);
    const byName = new Map(existingColors.map(c => [c.name.toLowerCase(), c]));
    let sort = 0;
    for (const [name, c] of [...summary.colors.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const found = byName.get(name.toLowerCase());
      if (found) {
        db.prepare('UPDATE garment_colors SET name=?, hex=?, image_url=?, swatch_url=?, sort_order=? WHERE id=?')
          .run(name, c.hex || found.hex, c.image || found.image_url, c.swatch || found.swatch_url, sort++, found.id);
        byName.delete(name.toLowerCase());
      } else {
        db.prepare('INSERT INTO garment_colors (garment_id,name,hex,image_url,swatch_url,active,sort_order) VALUES (?,?,?,?,?,1,?)')
          .run(garment.id, name, c.hex || '#CCCCCC', c.image || null, c.swatch || null, sort++);
      }
    }
    for (const gone of byName.values()) db.prepare('UPDATE garment_colors SET active=0 WHERE id=?').run(gone.id);

    // ---- sizes + surcharges from real S&S size pricing ----
    const existingSizes = db.prepare('SELECT * FROM garment_sizes WHERE garment_id=?').all(garment.id);
    const sizeByLabel = new Map(existingSizes.map(s => [s.label.toLowerCase(), s]));
    summary.sizes.forEach((s, i) => {
      const surcharge = round2(Math.max(0, s.cost - summary.baseCost) * markup);
      const found = sizeByLabel.get(s.label.toLowerCase());
      if (found) {
        db.prepare('UPDATE garment_sizes SET label=?, surcharge=?, sort_order=? WHERE id=?').run(s.label, surcharge, i, found.id);
        sizeByLabel.delete(s.label.toLowerCase());
      } else {
        db.prepare('INSERT INTO garment_sizes (garment_id,label,surcharge,active,sort_order) VALUES (?,?,?,1,?)').run(garment.id, s.label, surcharge, i);
      }
    });
    for (const gone of sizeByLabel.values()) db.prepare('UPDATE garment_sizes SET active=0 WHERE id=?').run(gone.id);

    // ---- stock ----
    db.prepare('DELETE FROM ss_inventory WHERE garment_id=?').run(garment.id);
    const insStock = db.prepare('INSERT INTO ss_inventory (garment_id,color_name,size_label,qty,updated_at) VALUES (?,?,?,?,?)');
    for (const [name, c] of summary.colors) for (const [size, qty] of Object.entries(c.stock)) insStock.run(garment.id, name, size, qty, now);

    // ---- customer pricing: reference tee price + cost difference x markup ----
    if (!isReference && refCost != null && garment.ss_price_sync && garment.pricing_mode !== 'margin_based') {
      upcharge = round2((summary.baseCost - refCost) * markup);
      db.prepare('UPDATE garments SET customer_price_adjustment=? WHERE id=?').run(upcharge, garment.id);
      const refPrices = Object.fromEntries(db.prepare('SELECT tier_id, standard_price FROM garment_tier_prices WHERE garment_id=?').all(refId).map(r => [r.tier_id, r.standard_price]));
      const upsert = db.prepare(`INSERT INTO garment_tier_prices (garment_id,tier_id,standard_price,hard_floor_price,is_estimated_price,updated_at) VALUES (?,?,?,?,0,?)
        ON CONFLICT(garment_id,tier_id) DO UPDATE SET standard_price=excluded.standard_price, hard_floor_price=excluded.hard_floor_price, is_estimated_price=0, updated_at=excluded.updated_at`);
      for (const t of db.prepare('SELECT id, min_qty FROM quantity_tiers').all()) {
        const list = garmentListPrice(upcharge, t.min_qty, refPrices[t.id]);
        upsert.run(garment.id, t.id, list, floorFor(list), now);
      }
      repriced = true;
    }
  })();

  return {
    garmentId: garment.id, styleID, styleName, baseCost: summary.baseCost, colors: summary.colors.size, sizes: summary.sizes.length,
    totalStock, upcharge, repriced, isReference,
    note: !isReference && refCost == null ? 'Prices not updated: link and sync the reference garment (Standard Tee) first.' : null,
  };
}

/** Sync every linked garment, reference garment first. */
async function syncAll() {
  const refId = referenceGarmentId();
  const linked = db.prepare('SELECT id, name FROM garments WHERE ss_style_id IS NOT NULL AND active=1').all()
    .sort((a, b) => (a.id === refId ? -1 : b.id === refId ? 1 : 0));
  const results = [];
  for (const g of linked) {
    try { results.push({ name: g.name, ok: true, ...(await syncGarment(g.id)) }); }
    catch (err) { results.push({ garmentId: g.id, name: g.name, ok: false, error: err.message }); }
  }
  db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('ss_last_sync_all',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(new Date().toISOString(), new Date().toISOString());
  return results;
}

/** Called hourly from server/index.js: runs syncAll() at most once a day when auto-sync is on. */
async function maybeAutoSync() {
  if (!isConfigured() || getSetting('ss_auto_sync', '1') !== '1') return null;
  const last = getSetting('ss_last_sync_all', '');
  if (last && Date.now() - new Date(last).getTime() < 23 * 60 * 60 * 1000) return null;
  if (!db.prepare('SELECT id FROM garments WHERE ss_style_id IS NOT NULL AND active=1 LIMIT 1').get()) return null;
  const results = await syncAll();
  console.log(`[S&S] daily sync: ${results.filter(r => r.ok).length} ok, ${results.filter(r => !r.ok).length} failed`);
  return results;
}

/** Stock per color/size for a linked garment: { colorName: { sizeLabel: qty } }, or null if not linked. */
function stockFor(garmentId) {
  const rows = db.prepare('SELECT color_name, size_label, qty FROM ss_inventory WHERE garment_id=?').all(garmentId);
  if (!rows.length) return null;
  const out = {};
  for (const r of rows) (out[r.color_name] = out[r.color_name] || {})[r.size_label] = r.qty;
  return out;
}

module.exports = {
  SsError, isConfigured, credentials, markupPct, referenceGarmentId, searchStyles, resolveStyle, syncGarment, syncAll, maybeAutoSync, stockFor,
  summarizeProducts, fullImageUrl, DEFAULT_MARKUP_PCT, ssGet,
};
