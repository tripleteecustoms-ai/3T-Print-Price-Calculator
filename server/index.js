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

  // Webhooks are verified against the exact bytes that were sent, so those are kept alongside the parsed body.
  app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/')) req.rawBody = buf; } }));
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

  // The bare site root is the "What are you ordering?" start page, where a
  // customer picks a product type and enters that type's own order flow.
  // The apparel builder itself stays at /index.html (emailed "edit my order"
  // links, iframe embeds and the test suite all point there), so this has
  // to be registered before express.static, which would otherwise answer
  // "/" with index.html.
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'start.html'));
  });

  // Customer account pages. /admin is the only way into the admin, and it has its own login.
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
  app.get('/account', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'account.html')));
  app.get('/admin/login', (req, res) => res.redirect(302, '/admin/login.html'));
  // The link in the "verify your email" message.
  app.get('/verify-email', (req, res) => {
    const account = require('./services/customerAccounts').verify(String(req.query.token || ''));
    if (account && req.session) req.session.customerAccountId = account.id; // the link proves the address, so it also signs them in
    res.redirect(302, account ? '/account?verified=1' : '/login?verify=expired');
  });

  // the unsubscribe link at the bottom of marketing emails
  app.get('/unsubscribe', (req, res) => require('./services/emailSequences').unsubscribeHandler(req, res));

  // static: public site (customer builder, quote page, admin SPA) + uploaded artwork
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/uploads', express.static(require('./services/storageService').UPLOAD_DIR));

  app.use('/api', customerRoutes);
  app.use('/api/webhooks', require('./routes/webhooks')); // Shopify and Square order/payment events
  app.use('/api/account', require('./routes/account'));   // optional customer logins
  app.use('/api/admin', require('./routes/adminWorkflow')); // artwork queue, email viewer, order/customer files
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

  // S&S Activewear daily price/stock sync. Checked hourly; maybeAutoSync()
  // only actually syncs once per ~day, and only when credentials are set,
  // auto-sync is on, and at least one garment is linked.
  const ss = require('./services/ssActivewear');
  const runAutoSync = () => ss.maybeAutoSync().catch(err => console.error('[S&S] daily sync failed:', err.message));
  setTimeout(runAutoSync, 60 * 1000).unref();
  setInterval(runAutoSync, 60 * 60 * 1000).unref();

  // Shopify payments: every 10 minutes, record any Shopify checkouts that
  // were paid since (the quote page and admin also check on every view).
  const paymentService = require('./services/paymentService');
  const runPaymentSweep = () => paymentService.syncRecentShopifyPayments()
    .then(n => { if (n) console.log(`[payments] recorded ${n} Shopify payment(s)`); })
    .catch(err => console.error('[payments] sweep failed:', err.message));
  setTimeout(runPaymentSweep, 30 * 1000).unref();
  setInterval(runPaymentSweep, 10 * 60 * 1000).unref();

  // Automated follow-up emails (Settings > Sequences): checked every 15
  // minutes. Does nothing until the owner switches sequences on.
  const sequences = require('./services/emailSequences');
  const runSequences = () => sequences.run()
    .then(n => { if (n) console.log(`[sequences] sent ${n} email(s)`); })
    .catch(err => console.error('[sequences] run failed:', err.message));
  setTimeout(runSequences, 2 * 60 * 1000).unref();
  setInterval(runSequences, 15 * 60 * 1000).unref();
}

main().catch((err) => {
  console.error('Failed to start the server:', err);
  process.exit(1);
});
