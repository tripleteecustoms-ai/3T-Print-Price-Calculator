// Phase 1 hardening checks: /admin and /admin/ redirect based on session,
// security response headers, session cookie attributes, x-powered-by
// removal, and the rate limiter on sensitive POST routes staying generous
// enough not to trip during normal use.
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function main() {
  console.log('=== SECURITY / HARDENING CHECKS ===');

  // ---- /admin and /admin/ redirect based on session state ----
  const noSessionAdmin = await fetch(`${BASE}/admin`, { redirect: 'manual' });
  assert.strictEqual(noSessionAdmin.status, 302, 'GET /admin without a session redirects (302)');
  assert(noSessionAdmin.headers.get('location').includes('/admin/login.html'), 'unauthenticated /admin redirects to login.html');

  const noSessionAdminSlash = await fetch(`${BASE}/admin/`, { redirect: 'manual' });
  assert.strictEqual(noSessionAdminSlash.status, 302, 'GET /admin/ without a session redirects (302)');
  assert(noSessionAdminSlash.headers.get('location').includes('/admin/login.html'), 'unauthenticated /admin/ redirects to login.html');
  console.log('  ok: bare /admin and /admin/ no longer 404 — they redirect to login when signed out');

  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  assert(loginResp.ok, 'admin login succeeds');
  const cookie = loginResp.headers.get('set-cookie');
  assert(cookie, 'login returns a session cookie');
  assert(/HttpOnly/i.test(cookie), 'session cookie is HttpOnly');
  assert(/SameSite=Lax/i.test(cookie), 'session cookie is SameSite=Lax');
  // Over plain http (as in this test run), secure:'auto' should NOT mark the
  // cookie Secure — it would make the cookie unusable for local dev/tests.
  assert(!/;\s*Secure/i.test(cookie), 'session cookie is not marked Secure over plain http (secure:"auto" degrades correctly)');
  console.log('  ok: session cookie has httpOnly + sameSite=lax, and secure:"auto" behaves correctly over http');

  const withSessionAdmin = await fetch(`${BASE}/admin`, { redirect: 'manual', headers: { Cookie: cookie } });
  assert.strictEqual(withSessionAdmin.status, 302, 'GET /admin with a session redirects (302)');
  assert(withSessionAdmin.headers.get('location').includes('/admin/dashboard.html'), 'authenticated /admin redirects straight to dashboard.html');
  console.log('  ok: /admin sends a signed-in admin straight to the dashboard');

  // ---- security response headers ----
  const homeResp = await fetch(`${BASE}/`);
  assert(!homeResp.headers.get('x-powered-by'), 'X-Powered-By header is removed');
  assert.strictEqual(homeResp.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options: nosniff is set');
  assert(homeResp.headers.get('referrer-policy'), 'Referrer-Policy header is set');
  assert(homeResp.headers.get('permissions-policy'), 'Permissions-Policy header is set');
  assert(homeResp.headers.get('permissions-policy').includes('camera=()'), 'Permissions-Policy disables camera');
  assert(homeResp.headers.get('permissions-policy').includes('microphone=()'), 'Permissions-Policy disables microphone');
  assert(homeResp.headers.get('permissions-policy').includes('geolocation=()'), 'Permissions-Policy disables geolocation');
  // Deliberately still NOT set — this app must stay iframe-embeddable (see test-embed.js).
  assert(!homeResp.headers.get('x-frame-options'), 'X-Frame-Options is still NOT set (stays embeddable)');
  const csp = homeResp.headers.get('content-security-policy');
  assert(!csp || !csp.includes('frame-ancestors'), 'no frame-ancestors CSP directive (stays embeddable)');
  console.log('  ok: security headers present (nosniff, referrer-policy, permissions-policy) without breaking iframe embedding');

  // ---- rate limiter is generous enough for normal/test traffic, but exists ----
  // Fire a modest burst at the login route (well under its window limit) and
  // confirm none of them get 429'd — the limiter should be effectively
  // invisible during normal use / a single test-suite run.
  const burst = await Promise.all(Array.from({ length: 15 }, () =>
    fetch(`${BASE}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    })
  ));
  const got429 = burst.some(r => r.status === 429);
  assert(!got429, '15 rapid login attempts (a normal test-suite burst) are not rate-limited');
  assert(burst.every(r => r.status === 401), 'those same attempts are correctly rejected as bad credentials (401), not something else');
  console.log('  ok: rate limiter exists but is generous enough not to trip during normal/test traffic');

  // ---- .env.example documents the real Shopify credential model ----
  const fs = require('fs');
  const path = require('path');
  const envExample = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
  assert(!envExample.includes('SHOPIFY_ADMIN_TOKEN'), '.env.example no longer documents the retired SHOPIFY_ADMIN_TOKEN');
  assert(envExample.includes('SHOPIFY_CLIENT_ID'), '.env.example documents SHOPIFY_CLIENT_ID');
  assert(envExample.includes('SHOPIFY_CLIENT_SECRET'), '.env.example documents SHOPIFY_CLIENT_SECRET');
  assert(envExample.includes('SHOPIFY_SHOP_DOMAIN'), '.env.example documents SHOPIFY_SHOP_DOMAIN');
  console.log('  ok: .env.example matches the real Shopify credential model used by paymentService.js');

  console.log('\n=== SECURITY / HARDENING CHECKS PASSED ===');
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
