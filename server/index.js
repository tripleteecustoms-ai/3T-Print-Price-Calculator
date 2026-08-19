// server/index.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db');

async function main() {
  await db.ready; // sql.js initializes asynchronously (WASM load); wait for it before touching the DB

  const runSeed = require('./seed');
  runSeed(); // idempotent — safe on every boot

  const customerRoutes = require('./routes/customer');
  const adminRoutes = require('./routes/admin');

  const app = express();
  const PORT = process.env.PORT || 4790;

  app.use(express.json({ limit: '2mb' }));
  app.use(session({
    secret: process.env.SESSION_SECRET || '3t-print-solutions-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
  }));

  // static: public site (customer builder, quote page, admin SPA) + uploaded artwork
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/uploads', express.static(path.join(__dirname, '..', 'data', 'uploads')));

  app.use('/api', customerRoutes);
  app.use('/api/admin', adminRoutes);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  app.listen(PORT, () => {
    console.log(`3T Print Solutions quoting system running on http://localhost:${PORT}`);
    console.log(`  Customer builder:  http://localhost:${PORT}/`);
    console.log(`  Admin dashboard:   http://localhost:${PORT}/admin/`);
  });
}

main().catch((err) => {
  console.error('Failed to start the server:', err);
  process.exit(1);
});
