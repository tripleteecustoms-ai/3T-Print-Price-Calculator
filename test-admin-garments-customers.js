// Garment delete/archive + arrange order, customer profiles, and the
// quote page's live payment status. Runs against a server on :4790.
const assert = require('assert');

const BASE = 'http://localhost:4790';
let cookie = '';
async function call(method, p, body) {
  const resp = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = resp.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

async function main() {
  console.log('=== GARMENTS (delete, arrange) + CUSTOMER PROFILE + PAYMENT STATUS ===');
  assert.strictEqual((await call('POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' })).status, 200);

  // ---- delete: unused garment is removed for good ----
  const unused = (await call('POST', '/api/admin/garments', { name: 'Delete Me Test' })).body.id;
  let del = await call('DELETE', `/api/admin/garments/${unused}/permanent`);
  assert.strictEqual(del.body.deleted, true);
  assert.ok(!(await call('GET', '/api/admin/garments')).body.garments.some(g => g.id === unused), 'gone from admin');
  console.log('  ok: an unused garment is deleted for good');

  // ---- delete: garment used by a quote is archived, quote still opens ----
  const used = (await call('POST', '/api/admin/garments', { name: 'Archive Me Test' })).body.id;
  await call('POST', `/api/admin/garments/${used}/sizes`, { label: 'L', surcharge: 0 });
  const q = await call('POST', '/api/quotes', {
    firstName: 'Profile', lastName: 'Tester', email: `profile.${Date.now()}@example.com`, phone: '4785552222', termsAccepted: true, fulfillmentMethod: 'pickup',
    garmentId: used, colorSelections: [{ colorName: 'Black', sizes: [{ label: 'L', qty: 12 }] }], printLocationIds: [1],
  });
  assert.strictEqual(q.status, 200, JSON.stringify(q.body));
  del = await call('DELETE', `/api/admin/garments/${used}/permanent`);
  assert.strictEqual(del.body.archived, true); assert.strictEqual(del.body.quoteCount, 1);
  assert.ok(!(await call('GET', '/api/admin/garments')).body.garments.some(g => g.id === used), 'hidden from admin');
  assert.ok(!(await call('GET', '/api/garments')).body.garments.some(g => g.id === used), 'hidden from customers');
  assert.strictEqual((await call('GET', `/api/admin/quotes/${q.body.quoteCode}`)).status, 200, 'the old quote still opens');
  console.log('  ok: a garment used by a quote is archived instead (hidden everywhere, old quote still opens)');

  // ---- deleted starter garments stay deleted across restarts (seed skip list) ----
  const settings = (await call('GET', '/api/admin/settings')).body.settings;
  assert.ok(JSON.parse(settings.deleted_garment_names).includes('Delete Me Test'), 'deleted name is remembered for the seed');
  console.log('  ok: deleted garment names are remembered so the starter list does not bring them back');

  // ---- arrange ----
  const before = (await call('GET', '/api/admin/garments')).body.garments.map(g => g.id);
  const reversed = [...before].reverse();
  assert.strictEqual((await call('PUT', '/api/admin/garments-reorder', { order: reversed })).status, 200);
  assert.deepStrictEqual((await call('GET', '/api/admin/garments')).body.garments.map(g => g.id), reversed, 'admin shows the new order');
  const publicOrder = (await call('GET', '/api/garments')).body.garments.map(g => g.id);
  assert.deepStrictEqual(publicOrder, reversed.filter(id => publicOrder.includes(id)), 'customers see the new order');
  await call('PUT', '/api/admin/garments-reorder', { order: before });
  assert.strictEqual((await call('PUT', '/api/admin/garments-reorder', { order: [] })).status, 400);
  console.log('  ok: arranging garments saves the order for admin and customers');

  // ---- customer profile ----
  const detail = (await call('GET', `/api/admin/quotes/${q.body.quoteCode}`)).body;
  const custId = detail.customer.id;
  let prof = (await call('GET', `/api/admin/customers/${custId}`)).body;
  assert.strictEqual(prof.customer.firstName, 'Profile');
  assert.strictEqual(prof.status.key, 'lead', 'quoted but never ordered = lead');
  assert.strictEqual(prof.stats.quoteCount, 1); assert.strictEqual(prof.stats.orderCount, 0); assert.strictEqual(prof.stats.lastOrderAt, null);
  assert.strictEqual(prof.quotes[0].quoteCode, q.body.quoteCode);
  // pay it (mock) -> active customer with a last order
  await call('POST', `/api/quotes/${q.body.quoteCode}/checkout`, { termsAccepted: true });
  await call('POST', `/api/mock-payment/${q.body.quoteCode}/confirm`, {});
  prof = (await call('GET', `/api/admin/customers/${custId}`)).body;
  assert.strictEqual(prof.status.key, 'active');
  assert.strictEqual(prof.stats.orderCount, 1);
  assert.ok(prof.stats.lastOrderAt, 'last order date set');
  assert.ok(prof.stats.lifetimeValue > 0 && prof.stats.lifetimeValue === prof.stats.averageOrder);
  assert.strictEqual(prof.stats.conversionPct, 100);
  assert.strictEqual(prof.stats.favoriteGarment, 'Archive Me Test');
  const list = (await call('GET', '/api/admin/customers')).body.customers.find(c => c.id === custId);
  assert.ok(list.last_order_at, 'customers list shows last order');
  assert.strictEqual((await call('GET', '/api/admin/customers/99999999')).status, 404);
  console.log('  ok: customer profile shows status (lead -> active), orders, last order, lifetime value, average, conversion, favorite garment');

  // ---- live payment status + no double checkout ----
  const ps = (await call('GET', `/api/quotes/${q.body.quoteCode}/payment-status`)).body;
  assert.strictEqual(ps.paid, true);
  const again = await call('POST', `/api/quotes/${q.body.quoteCode}/checkout`, { termsAccepted: true });
  assert.strictEqual(again.status, 409); assert.strictEqual(again.body.error, 'ALREADY_PAID');
  console.log('  ok: payment-status reports paid; a paid order cannot start a second checkout');

  console.log('\n=== GARMENT / CUSTOMER / PAYMENT STATUS CHECKS PASSED ===');
}

main().catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
