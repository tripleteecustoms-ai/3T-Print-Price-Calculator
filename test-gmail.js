// Standalone unit test for the Gmail SMTP email delivery added to
// server/services/emailService.js. Doesn't need real Gmail credentials or
// network access — it fakes the nodemailer transporter (via the test-only
// _setGmailTransportFactoryForTests hook, mirroring paymentService.js's
// pattern for faking Shopify's fetch calls) so we can verify: the transport
// is built with the configured address/app-password, sendMail is called
// with the right envelope, sent emails are logged, the transporter is
// cached and reused across sends (not rebuilt every time), a credential
// change invalidates the cache, and missing credentials fail clearly
// instead of crashing.
const assert = require('assert');

async function main() {
  const db = require('./server/db');
  await db.ready;

  const upsert = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  upsert.run('email_provider', 'gmail');
  upsert.run('gmail_address', 'trey@example.com');
  upsert.run('gmail_app_password', 'fakeapppassword16c');
  upsert.run('business_name', '3T Print Solutions');

  const emailService = require('./server/services/emailService');

  let transportBuilds = 0;
  let sendMailCalls = 0;
  let lastSendMailArgs = null;
  let lastAuth = null;

  emailService._setGmailTransportFactoryForTests((gmailAddress, gmailAppPassword) => {
    transportBuilds++;
    lastAuth = { user: gmailAddress, pass: gmailAppPassword };
    return {
      sendMail: async (opts) => {
        sendMailCalls++;
        lastSendMailArgs = opts;
        return { messageId: `fake-${sendMailCalls}` };
      },
    };
  });

  console.log('=== GMAIL SMTP DELIVERY ===');

  // 1) First send builds a transporter with the configured credentials.
  await emailService.send({ quoteId: null, to: 'customer@example.com', subject: 'Hello', html: '<p>Hi</p>' });
  assert.strictEqual(transportBuilds, 1, 'first send builds exactly one transporter');
  assert.strictEqual(sendMailCalls, 1, 'first send calls sendMail once');
  assert.strictEqual(lastAuth.user, 'trey@example.com', 'transporter is built with the configured Gmail address');
  assert.strictEqual(lastAuth.pass, 'fakeapppassword16c', 'transporter is built with the configured app password');
  assert.strictEqual(lastSendMailArgs.to, 'customer@example.com', 'sendMail is called with the intended recipient');
  assert.strictEqual(lastSendMailArgs.subject, 'Hello', 'sendMail is called with the intended subject');
  assert(lastSendMailArgs.from.includes('trey@example.com'), 'sendMail "from" includes the connected Gmail address');
  assert(lastSendMailArgs.from.includes('3T Print Solutions'), 'sendMail "from" includes the business name as the display name');
  console.log('  ok: first send builds a transporter from the configured credentials and delivers');

  // 2) Second send with the same credentials reuses the cached transporter.
  await emailService.send({ quoteId: null, to: 'customer2@example.com', subject: 'Hello again', html: '<p>Hi</p>' });
  assert.strictEqual(transportBuilds, 1, 'second send with unchanged credentials reuses the cached transporter (no rebuild)');
  assert.strictEqual(sendMailCalls, 2, 'second send still calls sendMail');
  console.log('  ok: transporter is cached and reused across sends with the same credentials');

  // 3) Changing the Gmail credentials invalidates the cache and rebuilds.
  upsert.run('gmail_app_password', 'a-different-app-password');
  await emailService.send({ quoteId: null, to: 'customer3@example.com', subject: 'Hello once more', html: '<p>Hi</p>' });
  assert.strictEqual(transportBuilds, 2, 'changing the app password rebuilds the transporter');
  assert.strictEqual(lastAuth.pass, 'a-different-app-password', 'the rebuilt transporter uses the new app password');
  console.log('  ok: changing Gmail credentials invalidates the cached transporter');

  // 4) Sent emails are logged to emails_sent with provider="gmail".
  const loggedCount = db.prepare("SELECT COUNT(*) as n FROM emails_sent WHERE provider='gmail'").get().n;
  assert.strictEqual(loggedCount, 3, `all 3 gmail sends were logged to emails_sent (got ${loggedCount})`);
  console.log('  ok: gmail sends are logged in the admin email log');

  // 5) Missing credentials fail clearly instead of crashing.
  upsert.run('gmail_address', '');
  upsert.run('gmail_app_password', '');
  await assert.rejects(
    () => emailService.send({ quoteId: null, to: 'x@example.com', subject: 'x', html: '<p>x</p>' }),
    /Gmail is not connected/,
    'missing Gmail credentials throw a clear, actionable error'
  );
  console.log('  ok: missing Gmail credentials fail with a clear error instead of a confusing crash');

  // cleanup
  emailService._resetGmailTransportForTests();
  upsert.run('email_provider', 'mock');
  upsert.run('gmail_address', '');
  upsert.run('gmail_app_password', '');

  // 6) The admin "Send Test Email" route (best-effort — only if a server is
  // already running on :4790, e.g. as part of the full regression pass).
  const BASE = 'http://localhost:4790';
  let serverUp = false;
  try { serverUp = (await fetch(`${BASE}/health`)).ok; } catch (e) { /* not running — skip this part */ }
  if (serverUp) {
    const loginResp = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
    });
    const cookie = loginResp.headers.get('set-cookie');
    const testEmailResp = await fetch(`${BASE}/api/admin/test-email`, { method: 'POST', headers: { Cookie: cookie } });
    assert(testEmailResp.ok, 'POST /admin/test-email succeeds against the running server (mock provider)');
    const body = await testEmailResp.json();
    assert(body.sentTo, 'test-email response reports who it was sent to');
    console.log(`  ok: /admin/test-email works end-to-end (sent to ${body.sentTo})`);
  } else {
    console.log('  (skipped) /admin/test-email HTTP check — no server running on :4790');
  }

  console.log('\n=== GMAIL SMTP CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
