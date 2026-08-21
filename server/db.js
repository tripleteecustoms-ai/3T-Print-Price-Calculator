// server/db.js
// SQLite schema + connection for the 3T Print Solutions quoting system.
//
// This runs on sql.js — SQLite compiled to WebAssembly — instead of a native
// module like better-sqlite3. That's a deliberate choice: native modules
// have to be compiled specifically for each computer's exact OS/CPU/Node
// version combination, which is a common source of install failures
// (especially on Windows without developer tools installed). sql.js runs
// identically everywhere with zero compilation, at the cost of being fully
// in-memory — so this file persists the database to disk after every write
// by exporting a fresh snapshot to `data/3tprint.sqlite`. That file is
// still a completely standard SQLite file, openable with any normal SQLite
// tool.
//
// The functions exported below (`prepare`, `exec`, `pragma`, `transaction`)
// intentionally match better-sqlite3's API shape, so nothing elsewhere in
// the app needs to know or care which engine is underneath.

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, '3tprint.sqlite');

let raw = null;         // the underlying sql.js Database instance, once ready
let txDepth = 0;        // >0 while inside a transaction() call
let dirty = false;       // a write happened during a transaction; persist when it closes
let resolveReady;
const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

function persist() {
  const bytes = raw.export();
  fs.writeFileSync(DB_FILE, Buffer.from(bytes));
}
function afterWrite() {
  if (txDepth === 0) { persist(); dirty = false; }
  else dirty = true;
}

function bindParamsFor(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

function prepare(sql) {
  return {
    get(...params) {
      const stmt = raw.prepare(sql);
      try {
        stmt.bind(bindParamsFor(params));
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally { stmt.free(); }
    },
    all(...params) {
      const stmt = raw.prepare(sql);
      const rows = [];
      try {
        stmt.bind(bindParamsFor(params));
        while (stmt.step()) rows.push(stmt.getAsObject());
      } finally { stmt.free(); }
      return rows;
    },
    run(...params) {
      const stmt = raw.prepare(sql);
      try {
        stmt.bind(bindParamsFor(params));
        stmt.step();
      } finally { stmt.free(); }
      const changes = raw.getRowsModified();
      let lastInsertRowid;
      const idRows = raw.exec('SELECT last_insert_rowid() AS id');
      lastInsertRowid = idRows[0] ? idRows[0].values[0][0] : undefined;
      afterWrite();
      return { changes, lastInsertRowid };
    },
  };
}

function transaction(fn) {
  return (...args) => {
    txDepth++;
    let result;
    try {
      raw.run('BEGIN');
      result = fn(...args);
      raw.run('COMMIT');
    } catch (err) {
      try { raw.run('ROLLBACK'); } catch (e) { /* nothing to roll back */ }
      txDepth--;
      throw err;
    }
    txDepth--;
    if (txDepth === 0 && dirty) { persist(); dirty = false; }
    return result;
  };
}

function exec(sql) { raw.run(sql); afterWrite(); }
function pragma(str) {
  if (/journal_mode/i.test(str)) return; // no on-disk journal in an in-memory engine
  raw.run('PRAGMA ' + str + ';');
}

const db = { prepare, transaction, exec, pragma, ready: readyPromise };

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== GARMENTS =====================
CREATE TABLE IF NOT EXISTS garments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  style_number TEXT,
  description TEXT,
  image_url TEXT,
  internal_cost REAL NOT NULL DEFAULT 0,         -- overrides global blank cost when > 0
  customer_price_adjustment REAL NOT NULL DEFAULT 0, -- +/- applied to base unit price
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  pricing_mode TEXT NOT NULL DEFAULT 'fixed_tier',  -- 'fixed_tier' | 'margin_based'
  supplier TEXT,
  supplier_sku TEXT,
  backup_supplier TEXT,
  backup_style_number TEXT,
  last_cost_update TEXT,
  inventory_status TEXT NOT NULL DEFAULT 'unknown', -- free-text/enum-ish field; real inventory checking is Phase 4
  weight_oz REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS garment_colors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  garment_id INTEGER NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hex TEXT NOT NULL DEFAULT '#000000',
  image_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS garment_sizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  garment_id INTEGER NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  label TEXT NOT NULL,          -- S, M, L, XL, 2XL, 3XL, 4XL, 5XL
  surcharge REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ===================== PRINT LOCATIONS =====================
CREATE TABLE IF NOT EXISTS print_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,               -- "Front", "Back", "Left Sleeve", ...
  code TEXT UNIQUE NOT NULL,        -- "front", "back", "left_sleeve"
  included_in_base INTEGER NOT NULL DEFAULT 0, -- 1 = Front (no addon, always "included")
  internal_cost_per_unit REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- one row per (print_location, quantity 1-24) customer-facing addon price
CREATE TABLE IF NOT EXISTS print_location_pricing (
  print_location_id INTEGER NOT NULL REFERENCES print_locations(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL,
  addon_price REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (print_location_id, quantity)
);

-- ===================== BASE PRICING MATRIX (Phase 1 — 1-24, deprecated) =====
-- Superseded by quantity_tiers + garment_tier_prices below (Phase 2). Left in
-- place, unread by the pricing engine, only so any historical data an admin
-- edited under Phase 1 isn't silently destroyed.
CREATE TABLE IF NOT EXISTS pricing_tiers (
  quantity INTEGER PRIMARY KEY,     -- 1-24
  standard_price REAL NOT NULL,
  hard_floor_price REAL NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== QUANTITY TIERS (Phase 2) =====================
-- The 12-tier range model that replaces the old 1-24 exact-quantity matrix.
-- Admin-editable: ranges, checkout behavior, add/remove/rearrange (sort_order).
CREATE TABLE IF NOT EXISTS quantity_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_order INTEGER NOT NULL,
  label TEXT NOT NULL,                                   -- "1", "2-5", "1,001-2,499"...
  min_qty INTEGER NOT NULL,
  max_qty INTEGER NOT NULL,
  checkout_behavior TEXT NOT NULL DEFAULT 'immediate',    -- 'immediate' | 'review'
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quantity_tiers_sort ON quantity_tiers(sort_order);

-- fixed_tier pricing_mode: one row per (garment, tier) — the admin-set base
-- selling price for that tier, standard + hard-floor (mirrors the old
-- pricing_tiers standard/floor pair, just scoped per garment per tier instead
-- of one global row per exact quantity). is_estimated_price marks rows that
-- were populated by the Phase 2 placeholder discount-curve migration rather
-- than from real historical per-unit pricing or a deliberate admin edit —
-- cleared automatically ONLY when an admin actually edits the row.
CREATE TABLE IF NOT EXISTS garment_tier_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  garment_id INTEGER NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES quantity_tiers(id) ON DELETE CASCADE,
  standard_price REAL NOT NULL,
  hard_floor_price REAL NOT NULL,
  is_estimated_price INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(garment_id, tier_id)
);

-- margin_based pricing_mode: cost inputs treated as tier-invariant (per-unit
-- labor/transfer/packaging costs don't meaningfully change with order size at
-- these volumes). Selling price = Total Unit Cost / (1 - Target Gross Margin).
CREATE TABLE IF NOT EXISTS garment_cost_inputs (
  garment_id INTEGER PRIMARY KEY REFERENCES garments(id) ON DELETE CASCADE,
  garment_cost REAL NOT NULL DEFAULT 0,
  dtf_transfer_cost REAL NOT NULL DEFAULT 0,
  pressing_labor REAL NOT NULL DEFAULT 0,
  finishing_packaging REAL NOT NULL DEFAULT 0,
  spoilage_pct REAL NOT NULL DEFAULT 0,
  payment_processing_pct REAL NOT NULL DEFAULT 0,
  overhead REAL NOT NULL DEFAULT 0,
  target_margin_pct REAL NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- margin_based pricing_mode: the one cost component that plausibly DOES vary
-- by quantity — incoming garment freight per unit, which typically drops as
-- purchase volume from the supplier goes up. Kept per (garment, tier) rather
-- than flat.
CREATE TABLE IF NOT EXISTS garment_tier_freight (
  garment_id INTEGER NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES quantity_tiers(id) ON DELETE CASCADE,
  freight_per_unit REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (garment_id, tier_id)
);

-- Print-location addon pricing, tier-based (replaces print_location_pricing's
-- 1-24 exact-quantity matrix for the same reason garment base pricing moved
-- to tiers — an order of 5,000 shirts with a Back print still needs an addon
-- price, and the old table only ever covered 1-24).
CREATE TABLE IF NOT EXISTS print_location_tier_pricing (
  print_location_id INTEGER NOT NULL REFERENCES print_locations(id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES quantity_tiers(id) ON DELETE CASCADE,
  addon_price REAL NOT NULL DEFAULT 0,
  is_estimated_price INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (print_location_id, tier_id)
);

-- ===================== CUSTOMERS =====================
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  business_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ===================== QUOTES =====================
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_code TEXT UNIQUE NOT NULL,         -- 3T-260819-1042
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'draft',
  garment_id INTEGER NOT NULL REFERENCES garments(id),
  fulfillment_method TEXT NOT NULL DEFAULT 'pickup', -- pickup | shipping
  event_name TEXT,  -- "order purpose" tags, comma-separated (Special Event, Branded Merch, Promotional, Retail, Something Else)
  needed_by_date TEXT,
  notes TEXT,
  design_notes TEXT,
  discretionary_adjustment REAL NOT NULL DEFAULT 0,  -- owner override, per-shirt $
  discretionary_adjustment_note TEXT,
  discount_code TEXT,                      -- applied discount code, uppercase, or NULL
  discount_amount REAL NOT NULL DEFAULT 0, -- frozen dollar amount taken off at the time it was applied
  floor_override INTEGER NOT NULL DEFAULT 0,          -- 1 if owner overrode below floor
  override_unit_price REAL,                           -- explicit owner-entered base unit price when floor_override=1
  pricing_snapshot TEXT NOT NULL,          -- JSON: full calculation + matrix version at time of quote
  subtotal REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  viewed_at TEXT,
  checkout_started_at TEXT,
  paid_at TEXT,
  shopify_draft_order_id TEXT,
  shopify_order_id TEXT,
  payment_provider TEXT,
  payment_reference TEXT,
  amount_paid REAL,
  terms_accepted_at TEXT,
  artwork_status TEXT NOT NULL DEFAULT 'pending_review',
  needs_manual_review INTEGER NOT NULL DEFAULT 0,   -- Phase 2: flagged for admin attention, never blocks checkout by itself
  review_reasons TEXT,                              -- JSON array, e.g. ["qty_over_1000","tight_deadline"]
  shipping_address TEXT,                             -- JSON: {line1,line2,city,state,zip}, set when fulfillment_method='shipping'
  original_calculated_price REAL,                   -- server-calculated total at quote creation, before any owner override
  final_approved_price REAL,                        -- current total after the most recent owner override (defaults to original)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- one row per (color x size) selection on a quote
CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  color_name TEXT NOT NULL,
  color_hex TEXT,
  size_label TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_surcharge REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quote_print_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  print_location_id INTEGER NOT NULL REFERENCES print_locations(id),
  location_name TEXT NOT NULL,
  addon_price_each REAL NOT NULL DEFAULT 0,
  design_size TEXT NOT NULL DEFAULT 'standard',            -- standard | large | oversized
  design_size_surcharge_each REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS artwork_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE CASCADE, -- null until the quote is finalized
  draft_token TEXT,                                          -- links pre-quote uploads to the in-progress order
  print_location_id INTEGER REFERENCES print_locations(id),
  location_name TEXT,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_review',
  uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_artwork_draft_token ON artwork_files(draft_token);

CREATE TABLE IF NOT EXISTS quote_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,   -- generated | viewed | checkout_started | paid | review_requested | edited | status_change | override
  detail TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Lightweight first-party analytics: page/step visits (funnel), UTM traffic
-- sources, tied to an anonymous visitor_id (no PII — customer/order trend
-- analytics come from the customers/quotes tables instead).
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,   -- page_view | step_view | quote_generated | checkout_started
  step TEXT,                  -- for step_view: garment | color | sizes | locations | artwork | contact
  path TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  referrer TEXT,
  quote_code TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analytics_visitor ON analytics_events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);

-- Admin-managed discount codes. quotes.discount_code below is a plain text
-- snapshot (not a foreign key) — deleting a code here never breaks a quote
-- that already used it, matching how pricing_snapshot freezes everything
-- else about a quote at generation time.
CREATE TABLE IF NOT EXISTS discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,          -- stored uppercase; customers enter case-insensitively
  type TEXT NOT NULL,                 -- 'percent' | 'flat'
  value REAL NOT NULL,                -- percent: 0-100, flat: dollars
  usage_limit INTEGER,                -- NULL = unlimited
  times_used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,                    -- NULL = never
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes(code);

-- Owner-uploaded mockup images sent to a customer for approval before
-- production. One row per uploaded mockup (an order can have several across
-- revisions) — approval_token is the secret used in the no-login customer
-- approval link emailed out.
CREATE TABLE IF NOT EXISTS mockups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_customer', -- pending_customer | approved | changes_requested
  customer_note TEXT,
  approval_token TEXT UNIQUE NOT NULL,
  uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mockups_quote ON mockups(quote_id);
CREATE INDEX IF NOT EXISTS idx_mockups_token ON mockups(approval_token);

-- DEPRECATED (Phase 1 interim). Was the structured "bulk order" lead capture
-- for orders over the old 24-piece calculator cap. Superseded by Phase 2's
-- 1,001-10,000 tier system: large orders now go through the full quotes
-- pipeline (quotes.needs_manual_review + quote_items/quote_print_locations/
-- artwork_files) instead of this flat 6-field table, since every field the
-- rebuild doc's structured intake calls for already has a normalized home
-- there. Table + its admin/API routes are left in place, unread by anything
-- new, only so Phase-1-era data isn't destroyed.
CREATE TABLE IF NOT EXISTS bulk_quote_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  garment_name TEXT,
  approx_quantity INTEGER,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bulk_quote_requests_created ON bulk_quote_requests(created_at);

-- Generic admin-action audit log for actions that aren't scoped to one quote
-- (quote_events already covers per-quote history — status changes, price
-- overrides, etc.). Currently used for the Phase 2 global price adjustment
-- tool; a shared enough shape to extend to other bulk admin actions later.
CREATE TABLE IF NOT EXISTS admin_action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES admins(id),
  admin_name TEXT,
  action_type TEXT NOT NULL,
  detail TEXT,                -- JSON: whatever before/after detail makes sense for the action
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS emails_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'mock',
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

module.exports = db;

// ---------------------------------------------------------------- migrations
// CREATE TABLE IF NOT EXISTS (above) only helps brand-new databases — a
// database that was already created before a column existed keeps missing
// it forever unless we explicitly ALTER TABLE. This runs on every boot and
// is safe to re-run: each migration checks PRAGMA table_info() first and
// only adds a column if it's actually missing.
function columnExists(table, column) {
  const rows = raw.exec(`PRAGMA table_info(${table})`);
  if (!rows[0]) return false;
  const nameIdx = rows[0].columns.indexOf('name');
  return rows[0].values.some(v => v[nameIdx] === column);
}
function runMigrations() {
  const addColumnIfMissing = (table, column, ddl) => {
    if (!columnExists(table, column)) {
      exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  addColumnIfMissing('quote_print_locations', 'design_size', "design_size TEXT NOT NULL DEFAULT 'standard'");
  addColumnIfMissing('quote_print_locations', 'design_size_surcharge_each', 'design_size_surcharge_each REAL NOT NULL DEFAULT 0');
  addColumnIfMissing('quotes', 'discount_code', 'discount_code TEXT');
  addColumnIfMissing('quotes', 'discount_amount', 'discount_amount REAL NOT NULL DEFAULT 0');
  // 1 when the customer explicitly chose "I'll send artwork later" instead of
  // uploading a file at quote-generation time — lets admins filter/find these
  // for follow-up (Quotes panel "Artwork Pending" filter in the admin UI).
  addColumnIfMissing('quotes', 'artwork_pending', 'artwork_pending INTEGER NOT NULL DEFAULT 0');

  // ---- Phase 2: quantity tiers / per-garment pricing modes ----
  addColumnIfMissing('garments', 'pricing_mode', "pricing_mode TEXT NOT NULL DEFAULT 'fixed_tier'");
  addColumnIfMissing('garments', 'supplier', 'supplier TEXT');
  addColumnIfMissing('garments', 'supplier_sku', 'supplier_sku TEXT');
  addColumnIfMissing('garments', 'backup_supplier', 'backup_supplier TEXT');
  addColumnIfMissing('garments', 'backup_style_number', 'backup_style_number TEXT');
  addColumnIfMissing('garments', 'last_cost_update', 'last_cost_update TEXT');
  addColumnIfMissing('garments', 'inventory_status', "inventory_status TEXT NOT NULL DEFAULT 'unknown'");
  addColumnIfMissing('garments', 'weight_oz', 'weight_oz REAL');
  addColumnIfMissing('quotes', 'needs_manual_review', 'needs_manual_review INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('quotes', 'review_reasons', 'review_reasons TEXT');
  addColumnIfMissing('quotes', 'shipping_address', 'shipping_address TEXT');
  addColumnIfMissing('quotes', 'original_calculated_price', 'original_calculated_price REAL');
  addColumnIfMissing('quotes', 'final_approved_price', 'final_approved_price REAL');
}

// Kick off the async WASM init last, now that everything it needs (SCHEMA_SQL,
// exec(), persist()) is fully defined above. Route files that `require('./db')`
// get the db object immediately and can register handlers right away; the
// handlers themselves only ever run later (once a request comes in), by
// which point server/index.js has awaited `db.ready` and this has finished.
(async () => {
  const SQL = await initSqlJs();
  raw = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  raw.run('PRAGMA foreign_keys = ON;');
  exec(SCHEMA_SQL);
  runMigrations();
  persist();
  resolveReady();
})().catch((err) => {
  console.error('Failed to initialize the database:', err);
  process.exit(1);
});
