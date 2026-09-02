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
