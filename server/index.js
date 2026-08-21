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

  // Trust the first proxy hop (Render sits in front of this app in
  // production) so req.secure / req.ip reflect the real client, not the
  // proxy — required for session cookie's secure:'auto' below to correctly
  // mark the cookie Secure on https while staying usable over local http.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '2mb' }));
  app.use(session({
    secret: process.env.SESSION_SECRET || '3t-print-solutions-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // 'auto' asks express-session to set Secure only when the request is
      // actually HTTPS (via req.secure, which respects trust proxy above) —
      // works correctly on both local http dev and Render's https without
      // needing an env-specific branch here.
      secure: 'auto',
      // 'lax' (not 'strict') — this app is deliberately iframe-embeddable on
      // other sites (see test-embed.js) and a customer following an emailed
      // quote link is a top-level cross-site navigation either way; 'lax'
      // still blocks cross-site POST/XHR forgery, which is what matters here.
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8,
    },
  }));

  // Basic security headers. Deliberately NOT setting X-Frame-Options or a
  // frame-ancestors CSP directive — this app is meant to be embeddable via
  // <iframe> on other sites (see test-embed.js); a restrictive frame policy
  // would break that on purpose.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // /admin and /admin/ have no static index.html on purpose (there's a
  // dashboard.html and a login.html, not a single "the admin page") — send
  // whoever lands here to the right one based on whether they're signed in,
  // instead of a bare 404.
  app.get(['/admin', '/admin/'], (req, res) => {
    if (req.session && req.session.adminId) return res.redirect(302, '/admin/dashboard.html');
    return res.redirect(302, '/admin/login.html');
  });

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
