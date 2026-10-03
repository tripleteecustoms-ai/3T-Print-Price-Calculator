// server/printProducts.js
// Non-apparel products: Stickers / Labels, Custom Posters / Prints, Custom
// Mylar Packs and Yard Signs.
//
// The whole catalog is one admin-editable JSON document in the settings
// table (admin: Print Products). For each product it holds:
//   sizes    — each with its real dimensions and printable area (used for
//              the artwork editor and scale mockups) and its price tables:
//              quantity -> price for the whole order
//   options  — single-choice groups (bag color, sides, finish). A group is
//              priced one of two ways:
//                * "table" groups pick WHICH price table is used: mylar is
//                  priced straight from a table of quantity × sides ×
//                  finish, never worked out from a formula;
//                * the rest add a per-piece price (with quantity breaks)
//                  and/or a flat amount per order on top (e.g. bag color).
//   addons   — optional extras: flat per order (a matching pound bag) or,
//              with perPiece, charged on every piece (a stake per yard sign)
//   design   — whether the shop can create the artwork, premade designs,
//              and the design / logo fees
//
// A print order is stored as an ordinary quote, so the quote page,
// checkout, payments, emails and the admin Quotes list all work unchanged:
// calculateQuote() hands off to calculatePrintQuote() here whenever it is
// given a printSelection, and the result has the same shape as an apparel
// calculation. Everything the customer configured is kept as structured
// values in the result's printOrder (never as one text description).
//
// Same rule as apparel: the client only ever sends ids, dimensions and a
// quantity, and every price comes from this file.

const db = require('./db');
const { getSetting, getSettingNum, PricingError, round2, marginStatus, resolveDiscount } = require('./pricingEngine');

const SETTING_KEY = 'print_catalog';
const FAMILY_KEYS = ['stickers', 'posters', 'mylar', 'yardsigns'];
const DEFAULT_MAX_QTY = 10000;

// Seeded from the owner's price tables (2026-09-28 workbook and the product
// flow revision). Every family starts switched off ("Coming soon" on the
// start page) until the owner reviews it in admin; entries marked
// PLACEHOLDER below are structure the owner still has to price.
const packs = (quantities, prices) => quantities.map((qty, i) => ({ qty, price: prices[i] }));
const stickerPacks = (...prices) => packs([25, 50, 100], prices);
const posterPacks = (...prices) => packs([1, 5, 10], prices);
const included = (id, name, description = '', swatch = '') => ({ id, name, description, swatch, flat: 0, each: [] });
// The shop can create the artwork for any product: $50 design fee, +$50 if a logo has to be designed too.
// A custom design includes one revision after the first proof.
const designRequest = (extra = {}) => ({ enabled: true, premade: false, custom: true, customFee: 50, logoFee: 50, revisions: 1, templates: [], ...extra });

// Bag colors: black and white are standard, every other color is +$0.25 a pack.
const MYLAR_COLORS = [
  ['black', 'Black', '#111111'], ['white', 'White', '#FFFFFF'], ['red', 'Red', '#D62828'], ['orange', 'Orange', '#F77F00'],
  ['yellow', 'Yellow', '#FFD60A'], ['green', 'Green', '#2A9D4B'], ['blue', 'Blue', '#1D4ED8'], ['purple', 'Purple', '#7B2CBF'],
  ['pink', 'Pink', '#FF5DA2'], ['silver', 'Silver', 'silver'], ['gold', 'Gold', 'gold'], ['holographic', 'Holographic', 'holographic'],
];
const mylarColorGroup = () => ({
  id: 'color', name: 'Bag Color', description: 'The color of the bag itself. Black and white are standard.', table: false,
  choices: MYLAR_COLORS.map(([id, name, swatch]) => ({
    ...included(id, name, '', swatch),
    each: id === 'black' || id === 'white' ? [] : [{ minQty: 1, price: 0.25 }],
  })),
});
const sidesGroup = (table) => ({
  id: 'sides', name: 'Printing', description: 'Print one side or both.', table,
  choices: [included('single', 'Single-Sided', 'Printed on the front only.'), included('double', 'Double-Sided', 'Printed on the front and back.')],
});
// Official mylar base prices: quantity × sides × finish. Used exactly as listed.
const MYLAR_QTYS = [1, 8, 16, 32, 64, 128, 256];
const MYLAR_TABLES = [
  { key: 'single|unlaminated', packs: packs(MYLAR_QTYS, [15, 30, 50, 70, 120, 210, 380]) },
  { key: 'single|laminated', packs: packs(MYLAR_QTYS, [55, 70, 90, 110, 160, 250, 420]) },
  { key: 'double|unlaminated', packs: packs(MYLAR_QTYS, [20, 40, 70, 90, 160, 300, 560]) },
  { key: 'double|laminated', packs: packs(MYLAR_QTYS, [60, 80, 110, 130, 200, 340, 600]) },
];
const mylarOptions = () => [
  mylarColorGroup(),
  sidesGroup(true),
  {
    id: 'lamination', name: 'Finish', description: 'Add premium lamination?', table: true,
    choices: [included('unlaminated', 'Unlaminated', 'Standard printed finish.'), included('laminated', 'Laminated', 'Protective premium laminate over the print.')],
  },
];
const YARD_QTYS = [1, 5, 10, 25, 50, 100];
const DEFAULT_CATALOG = {
  families: [
    {
      key: 'stickers', name: 'Stickers / Labels', active: false,
      products: [{
        id: 'stk-gloss', name: 'Glossy Stickers & Labels', unit: 'sticker', costEach: 0, active: true,
        description: 'Glossy printed and cut. For logos, QR stickers, product and packaging labels.',
        customQty: true, maxQty: DEFAULT_MAX_QTY, customSize: true, quickQtys: [25, 50, 100],
        sizes: [
          { id: '2x2', label: '2×2 in', w: 2, h: 2, packs: stickerPacks(30, 45, 75) },
          { id: '2x4', label: '2×4 in', w: 2, h: 4, packs: stickerPacks(35, 55, 85) },
          { id: '3x3', label: '3×3 in', w: 3, h: 3, packs: stickerPacks(45, 65, 105) },
          { id: '3x5', label: '3×5 in', w: 3, h: 5, packs: stickerPacks(45, 75, 120) },
          { id: '4x4', label: '4×4 in', w: 4, h: 4, packs: stickerPacks(60, 85, 140) },
          { id: '4x5', label: '4×5 in', w: 4, h: 5, packs: stickerPacks(55, 90, 150) },
          { id: '5x5', label: '5×5 in', w: 5, h: 5, packs: stickerPacks(65, 110, 185) },
          { id: '5x6', label: '5×6 in', w: 5, h: 6, packs: stickerPacks(75, 135, 215) },
          { id: '8x8', label: '8×8 in', w: 8, h: 8, packs: stickerPacks(160, 285, 480) },
        ],
        options: [{ id: 'finish', name: 'Finish', description: 'Sticker material and finish.', table: false,
          choices: [included('gloss', 'Standard Gloss', 'Printed sticker material without premium lamination.')] }],
        addons: [], design: designRequest(),
      }],
    },
    {
      key: 'posters', name: 'Custom Posters / Prints', active: false,
      products: [{
        id: 'poster', name: 'Posters', unit: 'poster', costEach: 0, active: true,
        description: 'Printed on standard poster paper. All copies in an order are the same size and design.',
        customQty: true, maxQty: DEFAULT_MAX_QTY, customSize: true, quickQtys: [1, 5, 10],
        // Totals for 1 / 5 / 10 posters, used exactly as listed.
        sizes: [
          { id: '5x7', label: '5×7 in', w: 5, h: 7, packs: posterPacks(5, 20, 35) },
          { id: '8x10', label: '8×10 in', w: 8, h: 10, packs: posterPacks(7, 30, 50) },
          { id: '11x14', label: '11×14 in', w: 11, h: 14, packs: posterPacks(10, 40, 70) },
          { id: '12x18', label: '12×18 in', w: 12, h: 18, packs: posterPacks(13, 50, 85) },
          { id: '16x20', label: '16×20 in', w: 16, h: 20, packs: posterPacks(20, 60, 100) },
          { id: '18x24', label: '18×24 in', w: 18, h: 24, packs: posterPacks(24, 75, 120) },
          { id: '20x30', label: '20×30 in', w: 20, h: 30, packs: posterPacks(32, 125, 220) },
          { id: '24x36', label: '24×36 in', w: 24, h: 36, packs: posterPacks(40, 160, 280) },
        ],
        options: [{ id: 'finish', name: 'Finish', description: 'Poster paper and finish.', table: false,
          choices: [included('standard', 'Standard', 'Standard poster finish.')] }],
        addons: [], design: designRequest(),
      }],
    },
    {
      key: 'mylar', name: 'Custom Mylar Packs', active: false,
      products: [
        {
          id: 'myl-std', name: '3.5 Pack', unit: 'pack', costEach: 0, active: true,
          description: 'Standard small mylar pouch. Empty printed packaging.',
          customQty: true, maxQty: DEFAULT_MAX_QTY, customSize: false, insurancePct: 5,
          // The bag is about 4 in wide by 5 in tall; the label covers nearly the whole face.
          sizes: [{ id: '3.5', label: '3.5 pack', w: 4, h: 5, printW: 3.625, printH: 4.7, packs: [], tables: MYLAR_TABLES }],
          options: mylarOptions(),
          // 64 packs is the half-pound mark; a pound bag on its own is $30 (the Pound Bag product).
          addons: [{ id: 'pound-bag', name: 'Matching large pound bag', description: 'One large bag printed to match. $20 with 64 packs or more (normally $30).', price: 20, minQty: 64 }],
          design: designRequest({ premade: true }),
        },
        {
          id: 'myl-zip', name: 'Zip Pack', unit: 'pack', costEach: 0, active: false, // PLACEHOLDER: needs prices
          description: 'Approximately 1 oz capacity. Empty printed packaging.',
          customQty: true, maxQty: DEFAULT_MAX_QTY, customSize: false, insurancePct: 5,
          sizes: [{ id: 'zip', label: 'Zip pack', w: 5, h: 8, packs: [], tables: [] }],
          options: mylarOptions(), addons: [], design: designRequest({ premade: true }),
        },
        {
          id: 'myl-pound', name: 'Pound Bag', unit: 'bag', costEach: 0, active: true,
          description: 'Large-format pound bag. Empty printed packaging, printed front and back.',
          customQty: true, maxQty: DEFAULT_MAX_QTY, customSize: false, insurancePct: 5,
          sizes: [{ id: 'pound', label: 'Pound bag', w: 14, h: 16, packs: [{ qty: 1, price: 30 }] }],
          options: [mylarColorGroup()], addons: [], design: designRequest({ premade: true }),
        },
        {
          id: 'myl-rect', name: 'Rectangular Pack', unit: 'pack', costEach: 0, active: false, // PLACEHOLDER: needs prices
          description: 'For smaller amounts, roughly 3, 5 or 7 grams. Empty printed packaging.',
          customQty: true, maxQty: DEFAULT_MAX_QTY, customSize: false, insurancePct: 5,
          sizes: [{ id: 'rect', label: 'Rectangular pack', w: 3, h: 4.5, packs: [], tables: [] }],
          options: mylarOptions(), addons: [], design: designRequest({ premade: true }),
        },
      ],
    },
    {
      key: 'yardsigns', name: 'Yard Signs', active: false,
      rushPct: 25, rushMin: 20, // rush production: +25%, at least $20
      products: [{
        id: 'yard-sign', name: 'Yard Sign', unit: 'sign', costEach: 0, active: true,
        description: '18×24 corrugated plastic yard sign.',
        // Official yard sign prices: one standard size, quantity × sides. Other
        // sizes are quoted by hand (start page > Other).
        customQty: true, maxQty: DEFAULT_MAX_QTY, customSize: false, quickQtys: YARD_QTYS,
        sizes: [{
          id: '18x24', label: '18×24 in', w: 24, h: 18, packs: [],
          tables: [
            { key: 'single', packs: packs(YARD_QTYS, [20, 75, 120, 225, 350, 550]) },
            { key: 'double', packs: packs(YARD_QTYS, [25, 100, 160, 300, 450, 700]) },
          ],
        }],
        options: [sidesGroup(true)],
        addons: [{ id: 'h-stake', name: 'H-Stake', description: 'A metal H-stake for each sign.', price: 3, minQty: 0, perPiece: true }],
        design: designRequest(),
      }],
    },
  ],
};
const NO_DESIGN = { enabled: false, premade: false, custom: false, customFee: 0, logoFee: 0, revisions: 0, templates: [] };

// ------------------------------------------------------------ sanitizing
const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const price = (v) => { const n = round2(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 1e6 ? n : null; };
const inches = (v) => { const n = Math.round(Number(v) * 1000) / 1000; return Number.isFinite(n) && n > 0 && n <= 240 ? n : 0; };
function uniqueId(value, seen, where) {
  if (!ID_RE.test(String(value || '')) || seen.has(String(value))) throw new PricingError(`${where} needs a unique id.`);
  seen.add(String(value));
  return String(value);
}
function sanitizePacks(list, where) {
  const seenQty = new Set();
  return (Array.isArray(list) ? list : []).map(k => {
    const qty = Math.floor(Number(k && k.qty));
    const amount = price(k && k.price);
    if (!(qty >= 1 && qty <= 100000) || seenQty.has(qty)) throw new PricingError(`${where}: quantities must be whole numbers, each used once.`);
    if (amount === null) throw new PricingError(`${where}: the ${qty} quantity needs a price.`);
    seenQty.add(qty);
    return { qty, price: amount };
  }).sort((a, b) => a.qty - b.qty);
}

/**
 * Turn whatever the admin editor sent into a well-formed catalog, or throw
 * a PricingError naming the first problem. The families are fixed (they are
 * the cards on the start page); everything inside them is editable. Fields
 * a saved catalog doesn't have yet take their defaults, so an older saved
 * catalog keeps working after an upgrade.
 */
function sanitizeCatalog(input) {
  const families = (input && Array.isArray(input.families)) ? input.families : [];
  return {
    families: FAMILY_KEYS.map(key => {
      const fallback = DEFAULT_CATALOG.families.find(f => f.key === key);
      const f = families.find(x => x && x.key === key) || fallback;
      const seenProducts = new Set();
      const products = (Array.isArray(f.products) ? f.products : []).map(p => {
        const where = `${fallback.name}: "${text(p && p.name, 80) || 'unnamed product'}"`;
        const id = uniqueId(p && p.id, seenProducts, where);
        if (!text(p.name, 80)) throw new PricingError(`${fallback.name}: every product needs a name.`);

        const seenGroups = new Set();
        const options = (Array.isArray(p.options) ? p.options : []).map(g => {
          const groupId = uniqueId(g && g.id, seenGroups, `${where}: every option group`);
          if (!text(g.name, 60)) throw new PricingError(`${where}: every option group needs a name.`);
          const seenChoices = new Set();
          const choices = (Array.isArray(g.choices) ? g.choices : []).map(c => {
            const choiceId = uniqueId(c && c.id, seenChoices, `${where}, ${text(g.name, 60)}: every choice`);
            const flat = price(c.flat == null || c.flat === '' ? 0 : c.flat);
            if (!text(c.name, 60) || flat === null) throw new PricingError(`${where}, ${text(g.name, 60)}: every choice needs a name and valid prices.`);
            const seenBreaks = new Set();
            const each = (Array.isArray(c.each) ? c.each : []).map(b => {
              const minQty = Math.max(1, Math.floor(Number(b && b.minQty) || 1));
              const amount = price(b && b.price);
              if (amount === null || seenBreaks.has(minQty)) throw new PricingError(`${where}, ${text(g.name, 60)}, ${text(c.name, 60)}: per-piece prices need a valid price and one row per quantity.`);
              seenBreaks.add(minQty);
              return { minQty, price: amount };
            }).sort((a, b) => a.minQty - b.minQty);
            return { id: choiceId, name: text(c.name, 60), description: text(c.description, 300), swatch: text(c.swatch, 20), flat, each };
          });
          if (!choices.length) throw new PricingError(`${where}, ${text(g.name, 60)}: add at least one choice.`);
          return { id: groupId, name: text(g.name, 60), description: text(g.description, 300), table: !!g.table, choices };
        });
        // Every combination of the "table" groups' choices is one price table per size.
        const tableKeys = tableCombinations(options).map(combo => combo.key);

        const seenSizes = new Set();
        const sizes = (Array.isArray(p.sizes) ? p.sizes : []).map(s => {
          const sizeId = uniqueId(s && s.id, seenSizes, `${where}: every size`);
          const label = text(s.label, 60);
          if (!label) throw new PricingError(`${where}: every size needs a label.`);
          const tables = tableKeys.map(key => {
            const saved = (Array.isArray(s.tables) ? s.tables : []).find(t => t && t.key === key);
            return { key, packs: sanitizePacks(saved && saved.packs, `${where}, ${label}`) };
          });
          return {
            id: sizeId, label, w: inches(s.w), h: inches(s.h), printW: inches(s.printW), printH: inches(s.printH),
            packs: tableKeys.length ? [] : sanitizePacks(s.packs, `${where}, ${label}`), tables,
          };
        });

        const seenAddons = new Set();
        const addons = (Array.isArray(p.addons) ? p.addons : []).map(a => {
          const addonId = uniqueId(a && a.id, seenAddons, `${where}: every add-on`);
          const amount = price(a.price);
          if (!text(a.name, 80) || amount === null) throw new PricingError(`${where}: every add-on needs a name and a price.`);
          return { id: addonId, name: text(a.name, 80), description: text(a.description, 300), price: amount, minQty: Math.max(0, Math.floor(Number(a.minQty) || 0)), perPiece: !!a.perPiece };
        });

        const d = (p.design && typeof p.design === 'object') ? p.design : {};
        const seenTemplates = new Set();
        const design = {
          enabled: !!d.enabled, premade: !!d.premade, custom: !!d.custom,
          customFee: price(d.customFee) || 0, logoFee: price(d.logoFee) || 0,
          revisions: Math.max(0, Math.min(20, Math.floor(Number(d.revisions) || 0))),
          templates: (Array.isArray(d.templates) ? d.templates : []).map(t => ({
            id: uniqueId(t && t.id, seenTemplates, `${where}: every premade design`),
            name: text(t.name, 80) || 'Design',
            category: t.category === 'signature' ? 'signature' : 'reusable',
            imageUrl: text(t.imageUrl, 400), backImageUrl: text(t.backImageUrl, 400),
          })),
        };

        return {
          id, name: text(p.name, 80), description: text(p.description, 400),
          unit: text(p.unit, 30) || 'piece', costEach: price(p.costEach) || 0, active: p.active !== false,
          customQty: p.customQty !== false,
          maxQty: Math.max(1, Math.min(1000000, Math.floor(Number(p.maxQty) || DEFAULT_MAX_QTY))),
          customSize: !!p.customSize,
          // the quantity buttons shown to customers; empty = the quantities in the price table
          quickQtys: [...new Set((Array.isArray(p.quickQtys) ? p.quickQtys : []).map(q => Math.floor(Number(q))).filter(q => q >= 1 && q <= 100000))].sort((a, b) => a - b).slice(0, 12),
          // optional order insurance, as a percent of the order (0 = not offered)
          insurancePct: Math.max(0, Math.min(100, Number(p.insurancePct) || 0)),
          sizes, options, addons, design,
        };
      });
      return {
        key, name: text(f.name, 60) || fallback.name, active: !!f.active,
        // this product type's own rush fee: percent of the order (0 = the store-wide rate) and a minimum charge
        rushPct: Math.max(0, Math.min(500, Number(f.rushPct) || 0)), rushMin: price(f.rushMin) || 0,
        products,
      };
    }),
  };
}

/** Every combination of the table groups' choices: [{ key: 'single|laminated', label: 'Single-Sided, Laminated' }]. */
function tableCombinations(options) {
  const groups = options.filter(g => g.table);
  if (!groups.length) return [];
  return groups.reduce((combos, g) => combos.flatMap(combo => g.choices.map(c => ({
    key: combo.key ? `${combo.key}|${c.id}` : c.id, label: combo.label ? `${combo.label}, ${c.name}` : c.name,
  }))), [{ key: '', label: '' }]);
}
function sizeHasPrices(size) { return size.packs.length > 0 || (size.tables || []).some(t => t.packs.length > 0); }

// Bumped when products gain settings that an already-saved catalog would
// otherwise be missing. A catalog saved under an older version gets those
// settings from the shipped defaults (matched by product id) the next time
// it is read, and keeps everything the owner has edited.
const CATALOG_VERSION = 4;
function upgradeSavedCatalog(saved) {
  if (!saved || (saved.version || 1) >= CATALOG_VERSION) return saved;
  for (const f of saved.families || []) {
    const defaults = DEFAULT_CATALOG.families.find(d => d.key === f.key);
    // v4: a product type can have its own rush fee
    if (defaults && f.rushPct === undefined && defaults.rushPct) { f.rushPct = defaults.rushPct; f.rushMin = defaults.rushMin; }
    for (const p of f.products || []) {
      const d = defaults && defaults.products.find(x => x.id === p.id);
      if (!d) continue;
      // v2: quick quantity buttons, order insurance, one revision on custom design
      if (p.quickQtys === undefined && d.quickQtys) p.quickQtys = d.quickQtys;
      if (p.insurancePct === undefined && d.insurancePct) p.insurancePct = d.insurancePct;
      if ((saved.version || 1) < 2 && p.design && p.design.revisions === 2) p.design.revisions = d.design.revisions; // 2 was the old placeholder
      // v3: yard signs get the full list of standard sizes (to be priced) and custom sizes
      // v4: yard signs move to the official price table (18×24, quantity × sides, H-stake per sign)
      if (f.key === 'yardsigns') {
        for (const key of ['description', 'sizes', 'options', 'addons', 'quickQtys', 'customSize']) p[key] = JSON.parse(JSON.stringify(d[key]));
      }
    }
  }
  return saved;
}

function getCatalog() {
  const raw = getSetting(SETTING_KEY, null);
  if (raw) {
    try { return sanitizeCatalog(upgradeSavedCatalog(JSON.parse(raw))); } catch (e) { /* unreadable: fall back to the defaults */ }
  }
  return sanitizeCatalog(DEFAULT_CATALOG);
}

function saveCatalog(input) {
  const catalog = { ...sanitizeCatalog(input), version: CATALOG_VERSION };
  db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(SETTING_KEY, JSON.stringify(catalog), new Date().toISOString());
  return catalog;
}

/** What the customer pages get: which families are open, and their sellable products (no costs). */
function publicCatalog() {
  return {
    families: getCatalog().families.map(f => ({
      key: f.key, name: f.name, active: f.active, rushPct: f.rushPct, rushMin: f.rushMin,
      products: !f.active ? [] : f.products
        .filter(p => p.active && p.sizes.some(sizeHasPrices))
        .map(p => {
          const { costEach, active, ...rest } = p;
          return { ...rest, sizes: p.sizes.filter(sizeHasPrices) };
        }),
    })),
  };
}

// quotes.garment_id is a required link to a garment, so each family has one
// hidden stand-in garment (archived: it never shows in the builder or the
// admin Garments list). Its name is what the admin lists show for the order.
function familyGarmentId(family) {
  const marker = 'PRINT:' + family.key;
  const row = db.prepare('SELECT id FROM garments WHERE style_number = ? AND archived = 1').get(marker);
  if (row) return row.id;
  const id = db.prepare(`INSERT INTO garments
    (name, brand, style_number, description, image_url, internal_cost, customer_price_adjustment, active, sort_order)
    VALUES (?,?,?,?,?,?,?,0,?)`).run(family.name, '', marker, 'Stand-in for print product orders. Managed under Print Products.', '', 0, 0, 9999).lastInsertRowid;
  db.prepare('UPDATE garments SET archived = 1 WHERE id = ?').run(id);
  return id;
}

// ------------------------------------------------------------ pricing rules
/**
 * Price for a quantity from a price table (a list of { qty, price }).
 *  - A listed quantity costs exactly its listed price.
 *  - Any other quantity (when the product allows custom quantities) is
 *    charged at the per-piece rate of the nearest listed quantity below it,
 *    and never more than the next listed quantity up would cost.
 */
function priceForQty(product, table, qty) {
  const exact = table.find(k => k.qty === qty);
  if (exact) return exact.price;
  if (!product.customQty) throw new PricingError('Choose one of the listed quantities.');
  if (qty < table[0].qty) throw new PricingError(`The minimum order is ${table[0].qty}.`);
  if (qty > product.maxQty) throw new PricingError(`For more than ${product.maxQty.toLocaleString('en-US')}, contact us for a custom quote.`);
  const lower = [...table].reverse().find(k => k.qty <= qty);
  const next = table.find(k => k.qty > qty);
  const amount = round2((lower.price / lower.qty) * qty);
  return next ? Math.min(amount, next.price) : amount;
}

/** A per-piece price with quantity breaks: the row with the largest minQty that the order reaches. */
function eachPriceFor(breaks, qty) {
  if (!breaks.length) return 0;
  const reached = breaks.filter(b => b.minQty <= qty);
  return (reached.length ? reached[reached.length - 1] : breaks[0]).price;
}

/**
 * A custom size is priced as the smallest listed size it fits inside
 * (either way round). Returns { width, height, pricedAs } or throws.
 */
function resolveCustomSize(product, custom) {
  if (!product.customSize) throw new PricingError('Choose one of the listed sizes.');
  const width = Math.round(Number(custom.w) * 100) / 100;
  const height = Math.round(Number(custom.h) * 100) / 100;
  if (!(width >= 0.5 && height >= 0.5)) throw new PricingError('Enter a width and height of at least 0.5 inches.');
  const [short, long] = [Math.min(width, height), Math.max(width, height)];
  const priced = product.sizes.filter(s => s.w && s.h && sizeHasPrices(s));
  const fits = priced.filter(s => Math.min(s.w, s.h) >= short && Math.max(s.w, s.h) >= long).sort((a, b) => a.w * a.h - b.w * b.h);
  if (!fits.length) {
    const biggest = priced.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    throw new PricingError(`That size is larger than we price online${biggest ? ` (up to ${biggest.label})` : ''}. Contact us for a custom quote.`);
  }
  return { width, height, pricedAs: fits[0] };
}

const DESIGN_METHODS = { upload: 'Customer Upload', premade: 'Premade Design', custom: 'Custom Design by 3T' };
const LOGO_CHOICES = { upload: 'Customer logo', text: 'Text only', design: 'Logo designed by 3T' };
const BRIEF_FIELDS = ['designName', 'theme', 'primaryColors', 'secondaryColors', 'style', 'inspiration', 'instructions', 'brandInfo'];

/** The non-priced parts of a selection (orientation, artwork placement, cut border), cleaned up for storage. */
function sanitizeLayout(sel) {
  const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 1000) / 1000)) : fallback; };
  // Where the customer put the artwork on the print canvas: scale 1 = fitted
  // inside it; x/yPercent = the artwork's center across / down the canvas.
  const placement = (p) => (p && typeof p === 'object')
    ? { scale: num(p.scale, 0.05, 20, 1), xPercent: num(p.xPercent, -100, 200, 50), yPercent: num(p.yPercent, -100, 200, 50), rotation: 0 } : null;
  const artwork = {};
  if (sel.placements && typeof sel.placements === 'object') {
    for (const key of ['front', 'back']) { const p = placement(sel.placements[key]); if (p) artwork[key] = p; }
  }
  const wall = sel.wall && typeof sel.wall === 'object' ? { x: num(sel.wall.x, 0, 1000, 0), y: num(sel.wall.y, 0, 1000, 0) } : null;
  return {
    orientation: ['portrait', 'landscape'].includes(sel.orientation) ? sel.orientation : null,
    border: sel.border == null || sel.border === '' ? null : num(sel.border, 0, 2, 0),
    backArtwork: ['same', 'different'].includes(sel.backArtwork) ? sel.backArtwork : null,
    placements: artwork,
    wall,
  };
}

// What an order's items are called, per product type: "Image 1 - 11×14".
const ITEM_NOUN = { posters: 'Image', stickers: 'Design', mylar: 'Design', yardsigns: 'Sign' };
const MAX_ITEMS = 20;

/**
 * Price one configured item (one product, size, quantity, options, artwork
 * choices). Returns everything about it; calculatePrintQuote() adds the
 * order-level parts (insurance, discount, totals).
 */
function priceItem(product, sel) {
  // ---- size ----
  let size, sizeLabel, width, height, isCustomSize = false;
  if (sel.customSize && typeof sel.customSize === 'object') {
    const custom = resolveCustomSize(product, sel.customSize);
    size = custom.pricedAs; width = custom.width; height = custom.height; isCustomSize = true;
    sizeLabel = `${width}×${height} in (custom)`;
  } else {
    size = product.sizes.find(s => s.id === sel.sizeId);
    if (!size || !sizeHasPrices(size)) throw new PricingError('Choose a size.');
    width = size.w; height = size.h; sizeLabel = size.label;
  }

  // ---- options: one choice per group, defaulting to the group's first ----
  const qty = Math.floor(Number(sel.qty) || 0);
  if (qty < 1) throw new PricingError('Choose a quantity.');
  const chosen = (sel.options && typeof sel.options === 'object') ? sel.options : {};
  const options = product.options.map(g => {
    const wanted = chosen[g.id];
    const choice = wanted == null ? g.choices[0] : g.choices.find(c => c.id === String(wanted));
    if (!choice) throw new PricingError(`One of the selected options (${g.name}) is no longer available.`);
    // a table group's price is the price table itself, never an extra charge
    const each = g.table ? 0 : eachPriceFor(choice.each, qty);
    const flat = g.table ? 0 : choice.flat;
    return { groupId: g.id, group: g.name, choiceId: choice.id, choice: choice.name, swatch: choice.swatch, table: !!g.table, each, flat, total: round2(each * qty + flat) };
  });

  // ---- base price: the table for this combination of table options, at this quantity ----
  const tableOptions = options.filter(o => o.table);
  let table = size.packs;
  if (tableOptions.length) {
    const key = tableOptions.map(o => o.choiceId).join('|');
    const found = (size.tables || []).find(t => t.key === key);
    table = found ? found.packs : [];
    if (!table.length) throw new PricingError(`${tableOptions.map(o => o.choice).join(', ')} is not available for this product yet.`);
  }
  const listPrice = priceForQty(product, table, qty);

  // ---- add-ons: flat per order, or per piece ----
  const addonIds = [...new Set(Array.isArray(sel.addonIds) ? sel.addonIds.map(String) : [])];
  const addons = addonIds.map(id => {
    const addon = product.addons.find(a => a.id === id);
    if (!addon) throw new PricingError('One of the selected options is no longer available.');
    if (addon.minQty && qty < addon.minQty) throw new PricingError(`${addon.name} is only available with ${addon.minQty} or more.`);
    return addon;
  });

  // ---- design method and fees ----
  let design = null;
  const designFees = [];
  if (product.design.enabled) {
    const d = (sel.design && typeof sel.design === 'object') ? sel.design : {};
    const method = Object.keys(DESIGN_METHODS).includes(d.method) ? d.method : 'upload';
    if (method === 'premade' && !product.design.premade) throw new PricingError('Premade designs are not available for this product.');
    if (method === 'custom' && !product.design.custom) throw new PricingError('Custom design is not available for this product.');
    const logo = method === 'upload' ? null : (Object.keys(LOGO_CHOICES).includes(d.logo) ? d.logo : 'upload');
    const template = method === 'premade' ? product.design.templates.find(t => t.id === String(d.templateId)) || null : null;
    const brief = {};
    if (method !== 'upload' && d.brief && typeof d.brief === 'object') {
      for (const key of BRIEF_FIELDS) { const v = text(d.brief[key], 1500); if (v) brief[key] = v; }
    }
    if (method === 'custom' && product.design.customFee > 0) designFees.push({ name: 'Design fee', amount: product.design.customFee });
    if (logo === 'design' && product.design.logoFee > 0) designFees.push({ name: 'Logo design', amount: product.design.logoFee });
    design = {
      method, methodLabel: DESIGN_METHODS[method], logo, logoLabel: logo ? LOGO_CHOICES[logo] : null,
      templateId: template ? template.id : null, templateName: template ? template.name : null,
      templateCategory: template ? template.category : null,
      brief, fees: designFees, revisions: method === 'custom' ? product.design.revisions : null,
    };
  }

  // Every upgrade is its own order line: per-piece options, design fees, flat add-ons.
  const lines = [
    ...options.filter(o => o.total > 0).map(o => ({
      kind: 'option', name: `${o.group}: ${o.choice}`, each: o.each > 0 ? o.each : o.total, qty: o.each > 0 ? qty : 1, total: o.total, perPiece: o.each > 0,
    })),
    ...designFees.map(f => ({ kind: 'design', name: f.name, each: f.amount, qty: 1, total: f.amount, perPiece: false })),
    ...addons.map(a => ({ kind: 'addon', name: a.name, each: a.price, qty: a.perPiece ? qty : 1, total: round2(a.price * (a.perPiece ? qty : 1)), perPiece: !!a.perPiece })),
  ];

  const layout = sanitizeLayout(sel);
  // The selection as understood and stored: enough to price this item again.
  const selection = {
    productId: product.id, qty,
    ...(isCustomSize ? { customSize: { w: width, h: height } } : { sizeId: size.id }),
    options: Object.fromEntries(options.map(o => [o.groupId, o.choiceId])),
    addonIds: addons.map(a => a.id),
    design: design ? { method: design.method, logo: design.logo, templateId: design.templateId, brief: design.brief } : null,
    ...layout,
    includeMisprints: !!sel.includeMisprints,
  };
  // The print canvas the artwork is placed on. A listed size can have a
  // printable area smaller than the product itself (a mylar label on a bag).
  const canvas = {
    width: !isCustomSize && size.printW ? size.printW : width,
    height: !isCustomSize && size.printH ? size.printH : height,
    unit: 'in', background: '#FFFFFF',
  };
  return {
    product, qty, listPrice, lines, selection,
    itemName: product.sizes.length > 1 || isCustomSize ? `${product.name}, ${sizeLabel}` : product.name,
    shortSize: product.sizes.length > 1 || isCustomSize ? sizeLabel.replace(/ in\b/, '') : product.name,
    // this item as structured values, for the quote page, emails and the admin production view
    detail: {
      productId: product.id, productName: product.name,
      sizeLabel, width, height, customSize: isCustomSize, pricedAsSize: isCustomSize ? size.label : null,
      qty, unit: product.unit, packPrice: listPrice, unitPrice: Math.round((listPrice / qty) * 10000) / 10000,
      options: options.map(o => ({ groupId: o.groupId, group: o.group, choiceId: o.choiceId, choice: o.choice, swatch: o.swatch, total: o.total })),
      addons: addons.map(a => ({ name: a.name, price: round2(a.price * (a.perPiece ? qty : 1)), each: a.perPiece ? a.price : null })),
      design, canvas,
      ...layout,
      includeMisprints: !!sel.includeMisprints,
      lineTotal: round2(listPrice + lines.reduce((s, l) => s + l.total, 0)),
    },
  };
}

/**
 * Price a print order. Mirrors calculateQuote()'s return shape.
 *
 * @param {object} input
 *   printSelection: one item —
 *     { family, productId, qty, sizeId | customSize: { w, h },
 *       options: { groupId: choiceId },        // unset groups take their first choice
 *       addonIds: [], design: { method, logo, templateId, brief: {...} },
 *       includeMisprints,                      // a preference: include usable misprints (not priced)
 *       orientation, border, backArtwork, placements, wall,   // not priced, stored
 *       insurance: true,                       // order insurance, where the product offers it
 *       artworkConfirmed }
 *   or several items of one product type in one order (each with its own
 *   size, quantity, artwork and options) —
 *     { family, items: [ { productId, qty, sizeId, ... }, ... ], insurance, artworkConfirmed }
 *   floorOverride / overrideUnitPrice: owner-entered price per piece
 *   discountCode, discountAlreadyApplied: as for apparel
 * @param {object} [pricingTables] - a quote's frozen snapshot (the products as
 *   they were priced when quoted); omit to price against the live catalog.
 */
function calculatePrintQuote(input, pricingTables) {
  const sel = input.printSelection || {};
  const frozen = !!(pricingTables && pricingTables.printProduct);
  let family;
  if (frozen) {
    family = pricingTables.printFamily;
  } else {
    family = getCatalog().families.find(f => f.key === sel.family);
    if (!family) throw new PricingError('Unknown product type.');
    if (!family.active) throw new PricingError(`${family.name} are not available to order online right now.`);
  }
  const productFor = (itemSel) => {
    let product;
    if (frozen) {
      product = (pricingTables.printProducts && pricingTables.printProducts[itemSel.productId]) || pricingTables.printProduct;
      // a quote frozen before option groups / design methods existed
      if (!product.options) product.options = [];
      if (!product.design) product.design = NO_DESIGN;
    } else {
      product = family.products.find(p => p.id === itemSel.productId && p.active);
      if (!product) throw new PricingError('That product is no longer available.');
    }
    return product;
  };

  const multi = Array.isArray(sel.items) && sel.items.length > 0;
  if (multi && sel.items.length > MAX_ITEMS) throw new PricingError(`An order can have up to ${MAX_ITEMS} items. Contact us for larger orders.`);
  const noun = ITEM_NOUN[family.key] || 'Item';
  const items = (multi ? sel.items : [sel]).map((itemSel, i) => {
    try {
      const item = priceItem(productFor(itemSel || {}), itemSel || {});
      item.label = `${noun} ${i + 1} - ${item.shortSize}`;
      return item;
    } catch (err) {
      // say which item the problem is with
      if (multi && err instanceof PricingError) throw new PricingError(`${noun} ${i + 1}: ${err.message}`);
      throw err;
    }
  });
  const totalQty = items.reduce((s, it) => s + it.qty, 0);
  const listTotal = round2(items.reduce((s, it) => s + it.listPrice, 0));

  // A listed quantity has one list price, so there is no discount room
  // between a "standard" and a "floor" price: anything under list is an
  // owner override (a price per piece, applied to every item).
  const standardUnit = Math.round((listTotal / totalQty) * 10000) / 10000;
  const floorUnit = standardUnit;
  let finalBaseUnit = standardUnit;
  let baseLineTotal = listTotal;
  let belowFloor = false;
  if (input.floorOverride && input.overrideUnitPrice != null) {
    finalBaseUnit = Math.max(0, Number(input.overrideUnitPrice));
    baseLineTotal = round2(finalBaseUnit * totalQty);
    belowFloor = finalBaseUnit < floorUnit - 0.0001;
  }

  const addonLines = items.flatMap(it => it.lines.map(l => (multi ? { ...l, name: `${it.label}: ${l.name}` } : l)));
  // Order insurance: a percent of everything above (the products, their
  // options, design fees and add-ons), only when the customer keeps it ticked.
  const insurancePct = Math.max(0, ...items.map(it => Number(it.product.insurancePct) || 0));
  const insured = insurancePct > 0 && sel.insurance === true;
  if (insured) {
    const amount = round2((baseLineTotal + addonLines.reduce((s, l) => s + l.total, 0)) * insurancePct / 100);
    addonLines.push({ kind: 'insurance', name: `Order Insurance (${insurancePct}%)`, each: amount, qty: 1, total: amount, perPiece: false });
  }
  const sumKind = (kind) => round2(addonLines.filter(l => l.kind === kind).reduce((s, l) => s + l.total, 0));
  const addonLinesTotal = round2(addonLines.reduce((s, l) => s + l.total, 0));
  const subtotal = round2(baseLineTotal + addonLinesTotal);

  const { discount, discountError } = resolveDiscount(input, subtotal);
  const discountAmount = discount ? discount.amount : 0;
  const total = round2(Math.max(0, subtotal - discountAmount));

  // Cost per piece is optional (Print Products > Cost each). Left at 0, the
  // margin figures below simply show the whole total as profit.
  const directCostTotal = round2(items.reduce((s, it) => s + (Number(it.product.costEach) || 0) * it.qty, 0));
  const directCostUnit = round2(directCostTotal / totalQty);
  const grossProfitTotal = round2(total - directCostTotal);
  const grossMarginPct = total > 0 ? round2((grossProfitTotal / total) * 100) : 0;
  const minimumTargetMarginPct = getSettingNum('minimum_target_margin_pct', 20);

  const orderLevel = {
    insurance: insured, insurancePct: insured ? insurancePct : 0,
    // what the order is made of, for the review screen and emails
    breakdown: { products: baseLineTotal, options: sumKind('option'), design: sumKind('design'), addons: sumKind('addon'), insurance: sumKind('insurance') },
    artworkConfirmed: !!sel.artworkConfirmed,
  };
  const first = items[0];
  return {
    garment: { id: familyGarmentId(family), name: multi ? `${family.name} (${items.length} items)` : first.itemName, isOther: false },
    productType: family.key,
    // this product type's own rush fee, when it has one (else the store-wide rate applies)
    rushRule: family.rushPct > 0 || family.rushMin > 0 ? { pct: family.rushPct || 0, min: family.rushMin || 0 } : null,
    // The selection as understood and stored: enough to price this order again.
    printSelection: multi
      ? { family: family.key, items: items.map(it => it.selection), insurance: insured, artworkConfirmed: !!sel.artworkConfirmed }
      : { family: family.key, ...first.selection, insurance: insured, artworkConfirmed: !!sel.artworkConfirmed },
    // The order as structured values, for the quote page, emails and the admin production view.
    printOrder: multi
      ? {
        familyKey: family.key, familyName: family.name, multi: true,
        productName: family.name, sizeLabel: `${items.length} items`, qty: totalQty, unit: 'piece',
        packPrice: listTotal, unitPrice: standardUnit,
        options: [], addons: [], design: null, canvas: null, placements: {},
        items: items.map(it => ({ label: it.label, ...it.detail })),
        ...orderLevel,
      }
      : { familyKey: family.key, familyName: family.name, label: first.label, ...first.detail, ...orderLevel },
    totalQty,
    lines: items.map(it => ({ colorName: multi ? it.label : it.product.name, colorHex: null, sizeLabel: it.detail.sizeLabel, quantity: it.qty, unitSurcharge: 0 })),
    quantityTier: null,
    isEstimatedPrice: false,
    standardUnit, floorUnit, maxDiscount: 0,
    adjustment: 0, finalBaseUnit, belowFloor,
    printLocations: [], addonLines, addonLinesTotal,
    surchargedLines: [], sizeSurchargeTotal: 0,
    designSizeLines: [], designSizeSurchargeTotal: 0,
    baseLineTotal, subtotal,
    discount, discountError, discountAmount,
    total,
    internal: {
      blankCost: directCostUnit, directCostUnit, directCostTotal,
      grossProfitTotal, grossMarginPct,
      marginStatus: marginStatus(grossMarginPct),
      minimumTargetMarginPct,
      belowMinimumMargin: directCostTotal > 0 && total > 0 && grossMarginPct < minimumTargetMarginPct,
    },
    pricingTablesVersion: (pricingTables && pricingTables.version) || new Date().toISOString(),
    pricingTablesSnapshot: frozen ? pricingTables : {
      version: new Date().toISOString(),
      printFamily: { key: family.key, name: family.name, rushPct: family.rushPct || 0, rushMin: family.rushMin || 0 },
      printProduct: JSON.parse(JSON.stringify(first.product)),
      printProducts: Object.fromEntries(items.map(it => [it.product.id, JSON.parse(JSON.stringify(it.product))])),
    },
  };
}

module.exports = { calculatePrintQuote, getCatalog, saveCatalog, publicCatalog, sanitizeCatalog, tableCombinations, priceForQty, DEFAULT_CATALOG, FAMILY_KEYS };
