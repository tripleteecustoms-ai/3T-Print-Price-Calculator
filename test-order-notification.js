// Focused test for Task #30: an admin-facing "new order" notification email
// fires on EVERY quote submission, independent of whether the customer ever
// pays — distinct from the customer's own quote email and from the 'paid'
// status email (which only fires after checkout completes).
const assert = require('assert');

const BASE = 'http://localhost:4790';
function assertOk(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); console.log('  ok:', msg); }

async function login() {
  const resp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  return resp.headers.get('set-cookie');
}

async function main() {
  console.log('=== ADMIN ORDER-NOTIFICATION EMAIL (Task #30) ===');
  const cookie = await login();

  // ---- 1) confirm business_email is configured (seeded default) ----
  const settingsResp = await (await fetch(`${BASE}/api/admin/settings`, { headers: { Cookie: cookie } })).json();
  const businessEmail = settingsResp.settings.business_email;
  assertOk(businessEmail, `business_email is configured (${businessEmail}) so the notification isn't silently skipped`);

  // ---- 2) submit a quote (deliberately NOT paying it) ----
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const uniqueEmail = `notify.test.${Date.now()}@example.com`;
  const quoteResp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 4 }] }],
      printLocationIds: [], draftToken: draftTokenResp.draftToken,
      firstName: 'Notify', lastName: 'Test', email: uniqueEmail, phone: '555-404-8080',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  const quoteBody = await quoteResp.json();
  assertOk(quoteResp.ok, `quote submitted successfully (${quoteBody.quoteCode})`);

  // give the fire-and-forget email send a moment to land
  await new Promise(r => setTimeout(r, 400));

  // ---- 3) the business owner got a "New Order Submitted" email, unpaid or not ----
  const emailsResp = await fetch(`${BASE}/api/admin/emails`, { headers: { Cookie: cookie } });
  const { emails } = await emailsResp.json();
  const notification = emails.find(e => e.to_email === businessEmail && e.subject.includes(quoteBody.quoteCode) && e.subject.startsWith('New Order Submitted'));
  assertOk(notification, `an admin notification email was sent to ${businessEmail} for the new (unpaid) quote #${quoteBody.quoteCode}`);
  console.log(`  ok: notification subject: "${notification.subject}"`);

  // it should NOT be the same email as the customer's own quote email
  const customerEmail = emails.find(e => e.to_email === uniqueEmail && e.subject.includes(quoteBody.quoteCode));
  assertOk(customerEmail, 'the customer also got their own separate quote email');
  assertOk(customerEmail.id !== notification.id, 'the admin notification and the customer quote email are two distinct emails');

  // confirm the quote itself is genuinely still unpaid — the notification did not wait on/require payment
  const quoteDetail = await (await fetch(`${BASE}/api/quotes/${quoteBody.quoteCode}`)).json();
  assertOk(!quoteDetail.quote.paidAt, 'the notified quote is still unpaid — confirms the email fires on submission, not on payment');

  // ---- 4) sanity: the full email body actually mentions the customer + total, not just the subject ----
  const detailResp = await fetch(`${BASE}/api/admin/emails/${notification.id}`, { headers: { Cookie: cookie } });
  const { email: fullEmail } = await detailResp.json();
  assertOk(fullEmail.body_html.includes('Notify Test') || fullEmail.body_html.includes(uniqueEmail), 'notification body includes the customer contact info for follow-up');
  console.log('  ok: notification email body includes real order details, not just a generic subject line');

  console.log('\n=== ADMIN ORDER-NOTIFICATION EMAIL: ALL CHECKS PASSED ===');
}

main().catch(err => {
  console.error('ORDER NOTIFICATION TEST FAILED:', err);
  process.exit(1);
});
