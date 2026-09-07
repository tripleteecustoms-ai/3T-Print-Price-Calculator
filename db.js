// server/db.js
// SQLite database initialization with sql.js (WASM)
// Includes Phase 2A upsell flow tables

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
let SQL = null;

async function initDb() {
  if (db) return db;

  SQL = await initSqlJs();

  const dbPath = path.join(__dirname, '../data/3tprint.sqlite');

  let buffer;
  try {
    buffer = fs.readFileSync(dbPath);
  } catch (e) {
    console.log('No existing database, creating new one...');
    buffer = null;
  }

  if (buffer) {
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
    initTables();
  }

  return db;
}

function initTables() {
  // Existing tables (not shown for brevity - use your current schema)
  // This shows only the NEW tables for Phase 2A

  // Upsell Sessions - tracks active upsell flows
  db.run(`
    CREATE TABLE IF NOT EXISTS upsell_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      quote_id INTEGER NOT NULL,
      selected_addons TEXT DEFAULT '[]',
      subtotal REAL NOT NULL,
      addon_total REAL DEFAULT 0,
      final_total REAL NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (quote_id) REFERENCES quotes(id)
    )
  `);

  // Index for fast lookups
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_upsell_session_id ON upsell_sessions(session_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_upsell_quote_id ON upsell_sessions(quote_id)
  `);

  // Orders Addons - permanent record of purchased addons
  db.run(`
    CREATE TABLE IF NOT EXISTS orders_addons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER NOT NULL,
      addon_name TEXT NOT NULL,
      addon_price REAL NOT NULL,
      percentage_of_subtotal REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (quote_id) REFERENCES quotes(id)
    )
  `);

  // Index for analytics queries
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_orders_addons_quote ON orders_addons(quote_id)
  `);

  // Add shipping_address column to quotes table if it doesn't exist
  // (For Phase 2B Shopify integration)
  try {
    db.run(`
      ALTER TABLE quotes ADD COLUMN shipping_address TEXT
    `);
  } catch (e) {
    // Column likely already exists - this is fine
  }

  // Customer Profiles (Phase 3: CRM System)
  db.run(`
    CREATE TABLE IF NOT EXISTS customer_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      company_name TEXT,
      contact_name TEXT,
      status TEXT DEFAULT 'lead',
      internal_notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER REFERENCES admins(id)
    )
  `);

  // Indexes for customer_profiles
  db.run('CREATE INDEX IF NOT EXISTS idx_customer_email ON customer_profiles(email)');
  db.run('CREATE INDEX IF NOT EXISTS idx_customer_status ON customer_profiles(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_customer_code ON customer_profiles(customer_code)');

  // Customer Status Types (for dropdown/badge UI)
  db.run(`
    CREATE TABLE IF NOT EXISTS customer_status_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status_key TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      color_hex TEXT DEFAULT '#9CA3AF',
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default status types if not exists
  const statusCheckStmt = db.prepare('SELECT COUNT(*) as cnt FROM customer_status_types');
  const statusCheckResult = statusCheckStmt.get();
  if (statusCheckResult.cnt === 0) {
    const defaultStatuses = [
      ['lead', 'Lead', '#6366F1', 'New prospect or inquiry'],
      ['active', 'Active', '#10B981', 'Actively ordering customer'],
      ['vip', 'VIP', '#F59E0B', 'High-value recurring customer'],
      ['inactive', 'Inactive', '#EF4444', 'No recent orders (60+ days)'],
      ['blocked', 'Blocked', '#6B7280', 'Do not contact / cancelled'],
    ];
    const insertStatusStmt = db.prepare(`
      INSERT INTO customer_status_types (status_key, display_name, color_hex, description)
      VALUES (?, ?, ?, ?)
    `);
    for (const [key, name, color, desc] of defaultStatuses) {
      try {
        insertStatusStmt.run(key, name, color, desc);
      } catch (e) {
        // Status may already exist
      }
    }
  }

  // Customer Payment Methods
  db.run(`
    CREATE TABLE IF NOT EXISTS customer_payment_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_ref TEXT NOT NULL,
      is_default BOOLEAN DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_customer_payments ON customer_payment_methods(customer_id)');

  // Link quotes to customer profiles
  db.run(`
    CREATE TABLE IF NOT EXISTS quote_customer_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER UNIQUE NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_quote_customer ON quote_customer_links(quote_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_customer_quotes ON quote_customer_links(customer_id)');

  // Customer Order History / Notes (for internal tracking)
  db.run(`
    CREATE TABLE IF NOT EXISTS customer_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
      note_text TEXT NOT NULL,
      note_type TEXT DEFAULT 'internal',
      created_by INTEGER REFERENCES admins(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_customer_notes ON customer_notes(customer_id)');

  // Add branding columns to settings table for logo and theme colors (Phase D)
  try {
    db.run('ALTER TABLE settings ADD COLUMN logo_url TEXT');
  } catch (e) {
    // Column already exists
  }

  try {
    db.run('ALTER TABLE settings ADD COLUMN theme_primary_color TEXT DEFAULT "#000000"');
  } catch (e) {
    // Column already exists
  }

  try {
    db.run('ALTER TABLE settings ADD COLUMN theme_accent_color TEXT DEFAULT "#C4FF00"');
  } catch (e) {
    // Column already exists
  }

  saveDb();
}

function prepare(sql) {
  if (!db) {
    throw new Error('Database not initialized');
  }

  return {
    run: function(...params) {
      try {
        db.run(sql, params);
        saveDb();
        return { changes: 1 };
      } catch (e) {
        console.error('DB Error:', e);
        throw e;
      }
    },
    get: function(...params) {
      try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return null;
      } catch (e) {
        console.error('DB Error:', e);
        throw e;
      }
    },
    all: function(...params) {
      try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      } catch (e) {
        console.error('DB Error:', e);
        throw e;
      }
    }
  };
}

function saveDb() {
  if (!db) return;

  const data = db.export();
  const buffer = Buffer.from(data);

  const dbPath = path.join(__dirname, '../data/3tprint.sqlite');
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  fs.writeFileSync(dbPath, buffer);
}

module.exports = {
  initDb,
  prepare,
  run: (sql) => {
    if (!db) throw new Error('Database not initialized');
    try {
      db.run(sql);
      saveDb();
    } catch (e) {
      console.error('DB Error:', e);
      throw e;
    }
  }
};
