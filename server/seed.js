// server/seed.js
// Seeds the database with the initial pricing matrix, the starter garment,
// print locations, an admin login, and default internal-cost settings.
// Safe to re-run: it only inserts rows that don't already exist.

const bcrypt = require('bcryptjs');
const db = require('./db');

const STANDARD = [null,35.00,31.00,28.75,27.50,26.25,25.50,24.75,24.25,23.75,23.25,23.00,22.50,22.25,22.00,21.75,21.50,21.25,21.00,20.75,20.75,20.50,20.25,20.25,20.00];
const FLOOR    = [null,35.00,29.77,27.08,25.33,24.04,23.04,22.22,21.54,20.96,20.45,20.00,19.60,19.23,18.90,18.60,18.32,18.07,17.83,17.60,17.39,17.20,17.01,16.84,16.67];
const BACKADD  = [null,10.00,8.60,7.87,7.39,7.04,6.77,6.54,6.35,6.19,6.05,5.93,5.82,5.72,5.62,5.54,5.46,5.39,5.32,5.26,5.20,5.15,5.10,5.05,5.00];

// Reasonable default matrices for additional locations, derived proportionally
// from the back-print curve. Fully editable by the admin afterward.
function scaledMatrix(scale){
  return BACKADD.map(v => v === null ? null : Math.round(v * scale * 100) / 100);
}
const LEFT_CHEST = scaledMatrix(0.55);
const RIGHT_CHEST = scaledMatrix(0.55);
const SLEEVE = scaledMatrix(0.65);

function run(){
  const tx = db.transaction(() => {

    // ---- settings ----
    const defaultSettings = {
      blank_cost: '3.50',
      front_transfer_cost: '2.75',
      labor_cost: '2.50',
      back_transfer_cost: '2.75',
      quote_expiration_days: '7',
      design_size_large_surcharge: '1.50',
      design_size_oversized_surcharge: '2.50',
      payment_provider: 'mock',       // 'shopify' | 'mock' | 'square'
      shopify_shop_domain: '',
      shopify_client_id: '',
      shopify_client_secret: '',
      email_provider: 'mock',       // 'mock' | 'gmail'
      gmail_address: '',
      gmail_app_password: '',
      business_name: '3T Print Solutions',
      business_email: 'orders@3tprintsolutions.com',
      terms_url: '/terms.html',
      step_order: JSON.stringify(['garment', 'color', 'sizes', 'locations', 'artwork', 'contact']),
    };
    const upsertSetting = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
      ON CONFLICT(key) DO NOTHING`);
    for (const [k,v] of Object.entries(defaultSettings)) upsertSetting.run(k,v);

    // ---- admin user ----
    const adminExists = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin');
    if (!adminExists) {
      const hash = bcrypt.hashSync('3tprint-admin-2026', 10);
      db.prepare('INSERT INTO admins (username, password_hash, display_name) VALUES (?,?,?)')
        .run('admin', hash, 'Trey');
    }

    // ---- pricing tiers ----
    const tierExists = db.prepare('SELECT quantity FROM pricing_tiers WHERE quantity = 1').get();
    if (!tierExists) {
      const ins = db.prepare('INSERT INTO pricing_tiers (quantity, standard_price, hard_floor_price) VALUES (?,?,?)');
      for (let q=1; q<=24; q++) ins.run(q, STANDARD[q], FLOOR[q]);
    }

    // ---- print locations ----
    let front = db.prepare("SELECT id FROM print_locations WHERE code='front'").get();
    if (!front) {
      const info = db.prepare(`INSERT INTO print_locations (name, code, included_in_base, internal_cost_per_unit, sort_order)
        VALUES ('Front','front',1,2.75,1)`).run();
      front = { id: info.lastInsertRowid };
      const ins = db.prepare('INSERT INTO print_location_pricing (print_location_id, quantity, addon_price) VALUES (?,?,0)');
      for (let q=1; q<=24; q++) ins.run(front.id, q);
    }
    let back = db.prepare("SELECT id FROM print_locations WHERE code='back'").get();
    if (!back) {
      const info = db.prepare(`INSERT INTO print_locations (name, code, included_in_base, internal_cost_per_unit, sort_order)
        VALUES ('Back','back',0,2.75,2)`).run();
      back = { id: info.lastInsertRowid };
      const ins = db.prepare('INSERT INTO print_location_pricing (print_location_id, quantity, addon_price) VALUES (?,?,?)');
      for (let q=1; q<=24; q++) ins.run(back.id, q, BACKADD[q]);
    }
    const extraLocations = [
      { name:'Left Chest', code:'left_chest', cost:1.50, matrix: LEFT_CHEST, sort:3 },
      { name:'Right Chest', code:'right_chest', cost:1.50, matrix: RIGHT_CHEST, sort:4 },
      { name:'Left Sleeve', code:'left_sleeve', cost:1.75, matrix: SLEEVE, sort:5 },
      { name:'Right Sleeve', code:'right_sleeve', cost:1.75, matrix: SLEEVE, sort:6 },
      { name:'Upper Back', code:'upper_back', cost:1.75, matrix: LEFT_CHEST, sort:7 },
    ];
    for (const loc of extraLocations) {
      let existing = db.prepare('SELECT id FROM print_locations WHERE code=?').get(loc.code);
      if (!existing) {
        const info = db.prepare(`INSERT INTO print_locations (name, code, included_in_base, internal_cost_per_unit, sort_order)
          VALUES (?,?,0,?,?)`).run(loc.name, loc.code, loc.cost, loc.sort);
        existing = { id: info.lastInsertRowid };
        const ins = db.prepare('INSERT INTO print_location_pricing (print_location_id, quantity, addon_price) VALUES (?,?,?)');
        for (let q=1; q<=24; q++) ins.run(existing.id, q, loc.matrix[q]);
      }
    }

    // ---- starter garment catalog ----
    // Each garment is checked/created independently by name, so re-running
    // seed() (which happens on every server boot) safely adds any new
    // garments below without touching ones that already exist in the DB —
    // including on a database that was already seeded before this list grew.
    const CORE_COLORS = [
      ['Black', '#111111'], ['White', '#FFFFFF'], ['Royal Blue', '#1E3A8A'],
      ['Red', '#B91C1C'], ['Navy', '#1F2937'], ['Sport Gray', '#9CA3AF'],
      ['Soft Pink', '#F4B8C6'], ['Safety Orange', '#FF6A13'],
      ['Safety Yellow', '#EEFF00'], ['Safety Green', '#C1F11D'],
    ];
    // These 4 are also the ones that need to be back-filled onto garments
    // that were already seeded before this list grew (see migration pass
    // below) — kept as their own list so that pass doesn't need to diff
    // the whole CORE_COLORS array.
    const NEW_CORE_COLORS = [
      ['Soft Pink', '#F4B8C6'], ['Safety Orange', '#FF6A13'],
      ['Safety Yellow', '#EEFF00'], ['Safety Green', '#C1F11D'],
    ];
    const APPAREL_SIZES = [
      ['S', 0], ['M', 0], ['L', 0], ['XL', 0],
      ['2XL', 2.00], ['3XL', 3.00], ['4XL', 4.00], ['5XL', 5.00],
    ];
    const ONE_SIZE = [['One Size', 0]];

    const GARMENTS = [
      {
        name: 'Standard Quality T-Shirt', brand: 'Gildan', style: '5000', adj: 0, internalCost: 0,
        desc: 'Our everyday 100% cotton tee. A reliable, soft, true-to-size blank for logos, events, and team orders.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Premium Soft T-Shirt', brand: 'Bella+Canvas', style: '3001', adj: 3.00, internalCost: 4.00,
        desc: 'Ultra-soft ringspun cotton with a more tailored, retail fit.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Heavyweight T-Shirt', brand: 'Comfort Colors', style: '1717', adj: 4.50, internalCost: 4.75,
        desc: 'Garment-dyed heavyweight cotton built to last wash after wash.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Long Sleeve Shirt', brand: 'Gildan', style: '2400', adj: 5.00, internalCost: 4.25,
        desc: 'Long sleeve cotton tee for cooler days and layered looks.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Performance Activewear Shirt', brand: 'Sport-Tek', style: 'ST350', adj: 6.00, internalCost: 4.00,
        desc: 'Moisture-wicking polyester tee built for workouts, practices, and team sports.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Polo Shirt', brand: 'Port Authority', style: 'K500', adj: 7.50, internalCost: 4.50,
        desc: 'Classic pique polo for a clean, professional look.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Hoodie', brand: 'Gildan', style: '18500', adj: 12.00, internalCost: 6.50,
        desc: 'Classic pullover hoodie with a front pocket and drawstring hood.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Heavyweight Hoodie', brand: 'Independent Trading Co.', style: 'IND4000', adj: 16.00, internalCost: 9.00,
        desc: 'Heavyweight fleece hoodie with a boxier, streetwear fit.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Sweatshirt', brand: 'Gildan', style: '18000', adj: 9.00, internalCost: 5.50,
        desc: 'Classic crewneck sweatshirt — a warm, no-frills staple.',
        colors: CORE_COLORS, sizes: APPAREL_SIZES,
      },
      {
        name: 'Hat / Cap', brand: 'Yupoong', style: '6089M', adj: -8.00, internalCost: 3.00,
        desc: 'Structured 6-panel trucker-style cap with an adjustable snapback.',
        colors: [['Black', '#111111'], ['White', '#FFFFFF'], ['Navy', '#1F2937'], ['Red', '#B91C1C']],
        sizes: ONE_SIZE,
      },
      {
        name: 'Tote Bag', brand: 'Q-Tees', style: 'Q1000', adj: -10.00, internalCost: 2.50,
        desc: 'Durable canvas tote — great for events, giveaways, and merch tables.',
        colors: [['Natural', '#F1E7D0'], ['Black', '#111111']],
        sizes: ONE_SIZE,
      },
    ];

    GARMENTS.forEach((g, idx) => {
      const existing = db.prepare('SELECT id FROM garments WHERE name = ?').get(g.name);
      if (existing) return;
      const info = db.prepare(`INSERT INTO garments
        (name, brand, style_number, description, image_url, internal_cost, customer_price_adjustment, active, sort_order)
        VALUES (?,?,?,?,?,?,?,1,?)`).run(g.name, g.brand, g.style, g.desc, '', g.internalCost, g.adj, idx + 1);
      const garmentId = info.lastInsertRowid;

      const insColor = db.prepare('INSERT INTO garment_colors (garment_id,name,hex,sort_order) VALUES (?,?,?,?)');
      g.colors.forEach(([name, hex], i) => insColor.run(garmentId, name, hex, i));

      const insSize = db.prepare('INSERT INTO garment_sizes (garment_id,label,surcharge,sort_order) VALUES (?,?,?,?)');
      g.sizes.forEach(([label, surcharge], i) => insSize.run(garmentId, label, surcharge, i));
    });

    // ---- back-fill new core colors onto garments seeded before they existed ----
    // GARMENTS.forEach above only inserts brand-new garments, so on a database
    // that was already seeded (i.e. everyone's live site) the apparel garments
    // still only have the original 6 colors. This pass adds any of the newer
    // CORE_COLORS that are missing, by name, to every garment that uses the
    // shared core palette (same array reference as CORE_COLORS) — safe to
    // re-run on every boot since it only inserts colors that don't exist yet.
    const coreColorGarmentNames = GARMENTS.filter(g => g.colors === CORE_COLORS).map(g => g.name);
    const insMissingColor = db.prepare('INSERT INTO garment_colors (garment_id,name,hex,sort_order) VALUES (?,?,?,?)');
    for (const name of coreColorGarmentNames) {
      const garment = db.prepare('SELECT id FROM garments WHERE name = ?').get(name);
      if (!garment) continue;
      const existingColorNames = new Set(
        db.prepare('SELECT name FROM garment_colors WHERE garment_id = ?').all(garment.id).map(c => c.name)
      );
      let nextSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM garment_colors WHERE garment_id = ?').get(garment.id).m + 1;
      for (const [colorName, hex] of NEW_CORE_COLORS) {
        if (existingColorNames.has(colorName)) continue;
        insMissingColor.run(garment.id, colorName, hex, nextSort++);
      }
    }
  });

  tx();
  console.log('Seed complete.');
  console.log('Admin login -> username: admin / password: 3tprint-admin-2026 (change in Settings)');
}

if (require.main === module) {
  // `npm run seed` invokes this file directly — the DB engine initializes
  // asynchronously (WASM load), so wait for it before seeding.
  db.ready.then(run);
} else {
  module.exports = run;
}
