// The cart: different products ordered together and paid for in one checkout.
// Each product stays its own order; shipping is charged once; tax and rush are
// per order; a cart pays in full; one payment marks every order paid once.
// Runs against a server on :4790 with the mock payment provider.
const assert = require('assert');
const crypto = require('crypto');

const BASE = 'http://localhost:4790';
function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const raw = typeof body === 'string';
    const resp = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
    const sc = resp.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await resp.text();
    let json = {}; try { json = JSON.parse(text); } catch (e) {}
    return { status: resp.status, body: json, text };
  };
}
const cents = (n) => Math.round(n * 100);

async function main() {
  console.log('=== CART ===');
  const admin = client(), shopper = client(), stranger = client();
  assert.strictEqual((await admin('POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' })).status, 200);
  const settingsBefore = (await admin('GET', '/api/admin/settings')).body.settings;
  await admin('PUT', '/api/admin/settings', { email_provider: 'mock', payment_provider: 'mock', shopify_client_secret: 'test-shopify-secret' });
  const shippingRate = Number(settingsBefore.shipping_flat_rate ?? 11.99);

  const stamp = Date.now();
  const email = `cart.${stamp}@example.com`;
  const { garments } = (await shopper('GET', '/api/garments')).body;
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt'), hoodie = garments.find(g => g.name === 'Hoodie');
  const front = (await shopper('GET', '/api/print-locations?qty=12')).body.printLocations.find(l => l.included);
  const address = { line1: '1 Main St', city: 'Macon', state: 'GA', zip: '31204' };
  const order = async (garment, qty, extra = {}) => {
    const r = await shopper('POST', '/api/quotes', {
      firstName: 'Cart', lastName: 'Tester', email, phone: '4785550200', termsAccepted: true, artworkPending: true, fulfillmentMethod: 'pickup',
      garmentId: garment.id, colorSelections: [{ colorName: garment.colors[0].name, sizes: [{ label: 'M', qty }] }], printLocationIds: [front.id], ...extra,
    });
    assert.strictEqual(r.status, 200, r.text);
    return r.body.quoteCode;
  };
  const single = async (code) => (await shopper('GET', `/api/quotes/${code}`)).body.checkout;

  // ---- two different products, both shipping, one with rush ----
  const tees = await order(tee, 12, { fulfillmentMethod: 'shipping', shippingAddress: address });
  const hoodies = await order(hoodie, 6, { fulfillmentMethod: 'shipping', shippingAddress: address, rush: true });
  const alone = { tees: await single(tees), hoodies: await single(hoodies) };
  assert.strictEqual(alone.tees.shippingFee, shippingRate);
  assert.strictEqual(alone.hoodies.shippingFee, shippingRate, 'on its own, each shipped order carries shipping');

  let r = await shopper('POST', '/api/cart/add', { orderNumber: tees });
  assert.strictEqual(r.status, 200, r.text);
  const token = r.body.token;
  assert.ok(/^[0-9a-f]{48}$/.test(token), 'the cart has an unguessable token');
  r = await shopper('POST', '/api/cart/add', { cartToken: token, orderNumber: hoodies });
  let cart = r.body;
  assert.deepStrictEqual(cart.items.map(i => i.orderNumber), [tees, hoodies], 'each product is its own order in the cart');
  assert.strictEqual(cart.totals.shipping, shippingRate, 'shipping is charged once for the whole cart');
  assert.strictEqual(cents(cart.totals.tax), cents(alone.tees.taxAmount + alone.hoodies.taxAmount), 'tax is each order\'s own tax');
  assert.strictEqual(cents(cart.totals.rush), cents(alone.hoodies.rushFee), 'rush applies only to the order that asked for it');
  assert.strictEqual(cents(cart.totals.grandTotal), cents(alone.tees.grandTotal + alone.hoodies.grandTotal - shippingRate), 'the cart total is both orders minus the second shipping charge');
  assert.strictEqual(cart.contact.email, email, 'the next order form can reuse the same contact details');
  assert.strictEqual((await shopper('POST', '/api/cart/add', { cartToken: token, orderNumber: hoodies })).body.items.length, 2, 'adding the same order twice does nothing');
  console.log(`  ok: two products in one cart; shipping once ($${shippingRate}); tax and rush per order`);

  // ---- who can add what ----
  const otherEmailOrder = (await stranger('POST', '/api/quotes', { firstName: 'Some', lastName: 'Body', email: `else.${stamp}@example.com`, phone: '4785550201', termsAccepted: true, artworkPending: true, fulfillmentMethod: 'pickup', garmentId: tee.id, colorSelections: [{ colorName: tee.colors[0].name, sizes: [{ label: 'M', qty: 3 }] }], printLocationIds: [front.id] })).body.quoteCode;
  assert.strictEqual((await shopper('POST', '/api/cart/add', { cartToken: token, orderNumber: otherEmailOrder })).status, 400, 'an order under a different email cannot be pulled into the cart');
  assert.strictEqual((await shopper('POST', '/api/cart/add', { cartToken: token, orderNumber: '3T-NOPE' })).status, 404);
  assert.strictEqual((await shopper('GET', '/api/cart/' + 'f'.repeat(48))).status, 404);
  const pickup = await order(tee, 4);
  cart = (await shopper('POST', '/api/cart/add', { cartToken: token, orderNumber: pickup })).body;
  assert.strictEqual(cart.items.length, 3);
  cart = (await shopper('POST', `/api/cart/${token}/remove`, { orderNumber: pickup })).body;
  assert.deepStrictEqual(cart.items.map(i => i.orderNumber), [tees, hoodies], 'an order can be removed');
  assert.strictEqual((await shopper('GET', `/api/quotes/${pickup}`)).status, 200, 'a removed order still exists and can be paid on its own');
  console.log('  ok: only the same customer\'s unpaid orders can be added; removing keeps the order');

  // ---- one checkout for everything ----
  assert.strictEqual((await shopper('POST', `/api/cart/${token}/checkout`, {})).status, 400, 'the order details must be confirmed first');
  r = await shopper('POST', `/api/cart/${token}/checkout`, { termsAccepted: true });
  assert.strictEqual(r.status, 200, r.text);
  const url = new URL(r.body.checkoutUrl, BASE);
  assert.strictEqual(url.searchParams.get('cart'), token);
  assert.strictEqual(cents(Number(url.searchParams.get('amount'))), cents(cart.totals.grandTotal), 'the amount charged is the cart total, worked out by the server');
  const A = (await admin('GET', `/api/admin/quotes/${tees}`)).body, B = (await admin('GET', `/api/admin/quotes/${hoodies}`)).body;
  assert.deepStrictEqual([A.quote.status, B.quote.status], ['checkout_started', 'checkout_started']);
  assert.deepStrictEqual([A.quote.shipping_fee, B.quote.shipping_fee], [shippingRate, 0], 'the first shipped order carries the one shipping charge');
  assert.deepStrictEqual([A.quote.payment_option, B.quote.payment_option], ['full', 'full'], 'a cart is paid in full');
  assert.deepStrictEqual(A.cartMates, [hoodies], 'admin shows which orders were placed together');
  assert.strictEqual(cents(B.checkout.grandTotal), cents(alone.hoodies.grandTotal - shippingRate), 'every screen shows the second order without a second shipping charge');
  assert.strictEqual(cents(A.quote.amount_due_now + B.quote.amount_due_now), cents(cart.totals.grandTotal));

  // ---- one payment marks every order paid, each for its own amount, once ----
  assert.strictEqual((await shopper('POST', `/api/mock-payment/cart/${token}/confirm`)).status, 200);
  await shopper('POST', `/api/mock-payment/cart/${token}/confirm`);
  const A2 = (await admin('GET', `/api/admin/quotes/${tees}`)).body, B2 = (await admin('GET', `/api/admin/quotes/${hoodies}`)).body;
  assert.ok(A2.quote.paid_at && B2.quote.paid_at, 'both orders are paid');
  assert.strictEqual(cents(A2.quote.amount_paid), cents(A.quote.amount_due_now));
  assert.strictEqual(cents(B2.quote.amount_paid), cents(B.quote.amount_due_now));
  assert.strictEqual(cents(A2.quote.amount_paid + B2.quote.amount_paid), cents(cart.totals.grandTotal), 'together they add up to exactly what was charged');
  assert.strictEqual(A2.events.filter(e => e.event_type === 'paid').length, 1, 'a repeated confirmation does not pay twice');
  assert.strictEqual(B2.events.filter(e => e.event_type === 'paid').length, 1);
  const paidMails = (await admin('GET', '/api/admin/emails?q=' + encodeURIComponent(email))).body.emails.filter(e => /thank you for your order/i.test(e.subject));
  assert.strictEqual(paidMails.length, 2, 'one confirmation per order');
  cart = (await shopper('GET', `/api/cart/${token}`)).body;
  assert.strictEqual(cart.status, 'paid');
  assert.strictEqual((await shopper('POST', `/api/cart/${token}/checkout`, { termsAccepted: true })).status, 409, 'a paid cart cannot be charged again');
  const next = await order(tee, 5);
  const fresh = (await shopper('POST', '/api/cart/add', { cartToken: token, orderNumber: next })).body;
  assert.notStrictEqual(fresh.token, token, 'the next order starts a new cart');
  assert.deepStrictEqual(fresh.items.map(i => i.orderNumber), [next]);
  // each order still has its own job ticket
  for (const code of [tees, hoodies]) assert.strictEqual((await admin('GET', `/api/admin/orders/${code}/production`)).body.quoteCode, code);
  console.log('  ok: one checkout; both orders paid for their own amounts, once; each keeps its own job ticket');

  // ---- paying for one order on its own takes it out of the cart ----
  const solo = await order(tee, 7, { fulfillmentMethod: 'shipping', shippingAddress: address });
  const pair = (await shopper('POST', '/api/cart/add', { cartToken: fresh.token, orderNumber: solo })).body;
  assert.strictEqual(pair.items.length, 2);
  assert.strictEqual((await shopper('POST', `/api/quotes/${solo}/checkout`, { termsAccepted: true })).status, 200);
  assert.deepStrictEqual((await shopper('GET', `/api/cart/${fresh.token}`)).body.items.map(i => i.orderNumber), [next], 'checking out one order alone removes it from the cart');
  assert.strictEqual((await admin('GET', `/api/admin/quotes/${solo}`)).body.quote.shipping_fee, shippingRate, 'and it carries its own shipping again');
  console.log('  ok: single-order checkout still works and leaves the cart');

  // ---- a Shopify payment notice for a cart pays every order in it ----
  const c1 = await order(tee, 2), c2 = await order(hoodie, 2);
  let sc = (await shopper('POST', '/api/cart/add', { orderNumber: c1 })).body;
  sc = (await shopper('POST', '/api/cart/add', { cartToken: sc.token, orderNumber: c2 })).body;
  await shopper('POST', `/api/cart/${sc.token}/checkout`, { termsAccepted: true });
  const payload = JSON.stringify({ id: 770000 + (stamp % 9000), name: '#2001', financial_status: 'paid', total_price: sc.totals.grandTotal.toFixed(2), total_outstanding: '0.00', note_attributes: [{ name: 'quote_id', value: c1 }, { name: 'cart', value: 'yes' }] });
  const hook = (id) => stranger('POST', '/api/webhooks/shopify', payload, { 'x-shopify-topic': 'orders/paid', 'x-shopify-event-id': id, 'x-shopify-hmac-sha256': crypto.createHmac('sha256', 'test-shopify-secret').update(payload).digest('base64') });
  assert.strictEqual((await hook(crypto.randomUUID())).body.result, 'paid');
  await hook(crypto.randomUUID());
  const S1 = (await admin('GET', `/api/admin/quotes/${c1}`)).body, S2 = (await admin('GET', `/api/admin/quotes/${c2}`)).body;
  assert.ok(S1.quote.paid_at && S2.quote.paid_at, 'the notice for the first order pays the whole cart');
  assert.strictEqual(cents(S1.quote.amount_paid + S2.quote.amount_paid), cents(sc.totals.grandTotal), 'no order is credited with the whole cart amount');
  assert.strictEqual(S2.quote.payment_provider, 'shopify');
  assert.strictEqual(S1.events.filter(e => e.event_type === 'paid').length + S2.events.filter(e => e.event_type === 'paid').length, 2, 'a second notice records nothing more');
  console.log('  ok: a Shopify payment for a cart pays each order its own amount, once');

  await admin('PUT', '/api/admin/settings', { shopify_client_secret: settingsBefore.shopify_client_secret || '', email_provider: settingsBefore.email_provider || 'mock', payment_provider: settingsBefore.payment_provider || 'mock' });
  console.log('ALL CART CHECKS PASSED');
}
main().then(() => process.exit(0)).catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
