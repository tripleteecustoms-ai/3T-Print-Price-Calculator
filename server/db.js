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

-- ===================== BASE PRICING MATRIX =====================
CREATE TABLE IF NOT EXISTS pricing_tiers (
  quantity INTEGER PRIMARY KEY,     -- 1-24
  standard_price REAL NOT NULL,
  hard_floor_price REAL NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
  addon_price_each REAL NOT NULL DEFAULT 0
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
  persist();
  resolveReady();
})().catch((err) => {
  console.error('Failed to initialize the database:', err);
  process.exit(1);
});
