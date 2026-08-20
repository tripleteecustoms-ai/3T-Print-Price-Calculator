// Focused check for the "Mockups" admin tab + customer approval flow:
//  1. Admin can list eligible orders and upload a mockup image for one,
//     which emails the customer an approval link (Approve / Request Changes).
//  2. The no-login customer approval page (reached via the emailed token)
//     can fetch the mockup, approve it, or request changes with a note.
//  3. Responding notifies the business owner, is idempotent to re-view
//     (status is remembered), and an invalid/unknown token is handled
//     cleanly rather than crashing.
//  4. The whole thing requires admin auth on the admin side, and needs no
//     login at all on the customer side (the token is the credential).
const assert = require('assert');

const BASE = 'http://localhost:4790';

function tinyPngBlob() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  return new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' });
}

async function main() {
  console.log('=== MOCKUPS ADMIN TAB + CUSTOMER APPROVAL ===');

  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  const cookie = loginResp.headers.get('set-cookie');
  assert(cookie, 'admin login succeeds');

  // ---- 0) auth is required on the admin side ----
  const unauthList = await fetch(`${BASE}/api/admin/mockups`);
  assert.strictEqual(unauthList.status, 401, 'listing mockups requires admin auth');
  const unauthOrders = await fetch(`${BASE}/api/admin/mockups/orders`);
  assert.strictEqual(unauthOrders.status, 401, 'listing eligible orders requires admin auth');
  console.log('  ok: admin mockup endpoints require auth');

  // ---- setup: create a real quote to attach a mockup to ----
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const createResp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'L', qty: 8 }] }],
      printLocationIds: [], draftToken: draftTokenResp.draftToken,
      firstName: 'Mocky', lastName: 'Upperson', email: 'mocky.upperson@example.com', phone: '555-666-7777',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(createResp.ok, 'test quote creation succeeds');
  const { quoteCode } = await createResp.json();

  // ---- 1) the new order shows up as eligible for a mockup ----
  const ordersResp = await (await fetch(`${BASE}/api/admin/mockups/orders`, { headers: { Cookie: cookie } })).json();
  assert(ordersResp.orders.some(o => o.quoteCode === quoteCode), 'the newly created order appears in the eligible-orders list');
  console.log('  ok: eligible orders list includes new quotes');

  // ---- 2) uploading a mockup for an unknown quote code 404s ----
  const fdBad = new FormData();
  fdBad.append('image', tinyPngBlob(), 'mock.png');
  const badUploadResp = await fetch(`${BASE}/api/admin/quotes/3T-NOPE-0000/mockups`, { method: 'POST', headers: { Cookie: cookie }, body: fdBad });
  assert.strictEqual(badUploadResp.status, 404, 'uploading a mockup for a nonexistent quote 404s');
  console.log('  ok: nonexistent quote code is handled cleanly (404)');

  // ---- 3) uploading disallowed file type is rejected ----
  const fdBadType = new FormData();
  fdBadType.append('image', new Blob([Buffer.from('nope')], { type: 'text/plain' }), 'notes.txt');
  const badTypeResp = await fetch(`${BASE}/api/admin/quotes/${quoteCode}/mockups`, { method: 'POST', headers: { Cookie: cookie }, body: fdBadType });
  assert.strictEqual(badTypeResp.status, 400, 'disallowed file types are rejected');
  console.log('  ok: disallowed file types are rejected');

  // ---- 4) valid upload succeeds and emails the customer ----
  const fd = new FormData();
  fd.append('image', tinyPngBlob(), 'design-mockup.png');
  const uploadResp = await fetch(`${BASE}/api/admin/quotes/${quoteCode}/mockups`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
  assert(uploadResp.ok, 'valid mockup upload succeeds');
  const uploadBody = await uploadResp.json();
  assert(!uploadBody.emailError, `mockup approval email sent without error (got: ${uploadBody.emailError})`);
  console.log('  ok: mockup upload succeeds and emails the customer an approval link');

  const listResp = await (await fetch(`${BASE}/api/admin/mockups`, { headers: { Cookie: cookie } })).json();
  const mockupRow = listResp.mockups.find(m => m.quote_code === quoteCode);
  assert(mockupRow, 'the uploaded mockup shows up in the admin mockups list');
  assert.strictEqual(mockupRow.status, 'pending_customer', 'a freshly uploaded mockup starts pending_customer');
  const approvalToken = mockupRow.approval_token;
  console.log('  ok: uploaded mockup appears in the admin list as pending_customer');

  // ---- 5) an invalid token is handled cleanly, not a crash ----
  const badTokenResp = await fetch(`${BASE}/api/mockups/not-a-real-token`);
  assert.strictEqual(badTokenResp.status, 404, 'an unknown approval token returns 404, not a crash');
  console.log('  ok: unknown approval tokens are handled cleanly');

  // ---- 6) the customer-facing (no-login) page can fetch the mockup by token ----
  const customerView = await (await fetch(`${BASE}/api/mockups/${approvalToken}`)).json();
  assert.strictEqual(customerView.quote.code, quoteCode, 'customer-facing mockup lookup returns the right quote');
  assert.strictEqual(customerView.mockup.status, 'pending_customer', 'customer sees the pending status before responding');
  console.log('  ok: no-login token lookup returns the mockup + quote summary');

  // ---- 7) requesting changes with a note ----
  const changesResp = await fetch(`${BASE}/api/mockups/${approvalToken}/request-changes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'Please make the logo bigger.' }),
  });
  assert(changesResp.ok, 'requesting changes succeeds');
  const afterChanges = await (await fetch(`${BASE}/api/mockups/${approvalToken}`)).json();
  assert.strictEqual(afterChanges.mockup.status, 'changes_requested', 'status updates to changes_requested');
  assert.strictEqual(afterChanges.mockup.customerNote, 'Please make the logo bigger.', 'the customer note is persisted and returned');
  console.log('  ok: requesting changes persists the customer note and updates status');

  const adminDetail = await (await fetch(`${BASE}/api/admin/quotes/${quoteCode}`, { headers: { Cookie: cookie } })).json();
  const changeEvent = adminDetail.events.find(e => e.event_type === 'mockup_changes_requested');
  assert(changeEvent, 'a mockup_changes_requested event is logged on the quote for the admin to see');
  console.log('  ok: the change request is logged in the quote history for the admin');

  // ---- 8) approving a second mockup (fresh upload) works and marks approved ----
  const fd2 = new FormData();
  fd2.append('image', tinyPngBlob(), 'design-mockup-v2.png');
  const upload2Resp = await fetch(`${BASE}/api/admin/quotes/${quoteCode}/mockups`, { method: 'POST', headers: { Cookie: cookie }, body: fd2 });
  assert(upload2Resp.ok, 'second mockup upload (revision) succeeds');
  const list2 = await (await fetch(`${BASE}/api/admin/mockups`, { headers: { Cookie: cookie } })).json();
  const mockup2 = list2.mockups.filter(m => m.quote_code === quoteCode).find(m => m.status === 'pending_customer');
  assert(mockup2, 'the revised mockup is a fresh pending_customer row (original one keeps its changes_requested status)');

  const approveResp = await fetch(`${BASE}/api/mockups/${mockup2.approval_token}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert(approveResp.ok, 'approving the revised mockup succeeds');
  const afterApprove = await (await fetch(`${BASE}/api/mockups/${mockup2.approval_token}`)).json();
  assert.strictEqual(afterApprove.mockup.status, 'approved', 'status updates to approved');
  console.log('  ok: a revised mockup can be approved independently of the earlier one');

  // ---- 9) re-approving (idempotent view) doesn't error, still reports approved ----
  const reApproveResp = await fetch(`${BASE}/api/mockups/${mockup2.approval_token}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert(reApproveResp.ok, 'calling approve again does not error (safe to click twice / reload the page)');
  console.log('  ok: approving twice is safe (idempotent)');

  console.log('\n=== MOCKUPS CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
