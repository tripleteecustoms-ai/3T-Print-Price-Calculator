// Focused check for the admin "Send Reminder" action:
//  1. It's rejectable on quotes that don't exist (404) and already-paid
//     orders (400) — reminders only make sense for unpaid orders.
//  2. On a valid unpaid order it sends an itemized reminder email (logged
//     in emails_sent) and records a quote_event, and it's REPEATABLE — not
//     a one-shot status change like the other order-status emails.
//  3. It requires admin auth.
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function main() {
  console.log('=== SEND REMINDER ===');

  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  const cookie = loginResp.headers.get('set-cookie');
  assert(cookie, 'admin login succeeds');

  // ---- 1a) unauthenticated request is rejected ----
  const unauthResp = await fetch(`${BASE}/api/admin/quotes/3T-NOPE-0000/send-reminder`, { method: 'POST' });
  assert.strictEqual(unauthResp.status, 401, 'send-reminder requires admin auth');
  console.log('  ok: requires admin auth');

  // ---- 1b) nonexistent quote 404s ----
  const missingResp = await fetch(`${BASE}/api/admin/quotes/3T-NOPE-0000/send-reminder`, { method: 'POST', headers: { Cookie: cookie } });
  assert.strictEqual(missingResp.status, 404, 'nonexistent quote code returns 404');
  console.log('  ok: nonexistent quote code is handled cleanly (404)');

  // ---- create a real unpaid quote to test against ----
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const createResp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 6 }] }],
      printLocationIds: [], draftToken: draftTokenResp.draftToken,
      firstName: 'Remind', lastName: 'Me', email: 'remind.me@example.com', phone: '555-777-8888',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(createResp.ok, 'test quote creation succeeds');
  const { quoteCode } = await createResp.json();

  // ---- 2) valid unpaid order: reminder sends, and is repeatable ----
  const r1 = await fetch(`${BASE}/api/admin/quotes/${quoteCode}/send-reminder`, { method: 'POST', headers: { Cookie: cookie } });
  assert(r1.ok, 'first reminder send succeeds');
  const r2 = await fetch(`${BASE}/api/admin/quotes/${quoteCode}/send-reminder`, { method: 'POST', headers: { Cookie: cookie } });
  assert(r2.ok, 'second reminder send on the same order also succeeds (repeatable, not a one-shot status change)');
  console.log('  ok: reminder can be sent more than once on the same unpaid order');

  const detail = await (await fetch(`${BASE}/api/admin/quotes/${quoteCode}`, { headers: { Cookie: cookie } })).json();
  const reminderEvents = detail.events.filter(e => e.event_type === 'reminder_sent');
  assert.strictEqual(reminderEvents.length, 2, `two reminder_sent events were recorded (got ${reminderEvents.length})`);
  assert.strictEqual(detail.quote.status, 'quote_generated', "sending a reminder does NOT change the order's status");
  console.log('  ok: each reminder is logged as its own event, and sending one never changes order status');

  // ---- 3) reject on an already-paid order ----
  const confirmResp = await fetch(`${BASE}/api/mock-payment/${quoteCode}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert(confirmResp.ok, 'mock payment confirmation succeeds (test setup)');
  const paidReminderResp = await fetch(`${BASE}/api/admin/quotes/${quoteCode}/send-reminder`, { method: 'POST', headers: { Cookie: cookie } });
  assert.strictEqual(paidReminderResp.status, 400, 'reminders are rejected once the order is paid');
  console.log('  ok: reminders are rejected on already-paid orders');

  console.log('\n=== SEND REMINDER CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
