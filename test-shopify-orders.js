// test-shopify-orders.js
// Orders placed straight on the Shopify store come into the admin
// (server/services/shopifyOrders.js): imported once, tagged Shopify, with
// Shopify's own totals; calculator checkouts and unpaid orders are skipped;
// and finishing one marks it fulfilled in Shopify. Shopify itself is faked.
// Run on its own: node test-shopify-orders.js

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3t-shopify-orders-'));
const source = path.join(__dirname, 'data', '3tprint.sqlite');
if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tmp, '3tprint.sqlite'));
process.env.DATA_DIR = tmp;

// A store order as Shopify's REST API and webhooks send it.
function storeOrder(over = {}) {
  return {
    id: 5550001, admin_graphql_api_id: 'gid://shopify/Order/5550001', name: '#1001', order_number: 1001,
    email: 'Store.Buyer@Example.com', financial_status: 'paid', fulfillment_status: null, cancelled_at: null,
    created_at: '2026-10-28T15:00:00Z', processed_at: '2026-10-28T15:00:05Z', note: 'Please hurry',
    subtotal_price: '45.00', total_tax: '3.60', total_price: '56.59', total_outstanding: '0.00',
    order_status_url: 'https://shop.example.com/orders/abc/authenticate?key=1',
    customer: { id: 77, first_name: 'Store', last_name: 'Buyer', email: 'store.buyer@example.com', phone: '4785550199' },
    shipping_address: { first_name: 'Store', last_name: 'Buyer', address1: '1 Peach St', city: 'Macon', province_code: 'GA', zip: '31201' },
    shipping_lines: [{ title: 'Standard', code: 'standard', price: '7.99' }],
    line_items: [
      { title: 'DTF Transfer', variant_title: '11 x 11 in', sku: 'DTF-11', quantity: 3, price: '10.00', requires_shipping: true,
        properties: [{ name: 'Upload', value: 'https://files.example.com/art.png' }, { name: '_hidden', value: '' }] },
      { title: 'Gang Sheet', variant_title: '22 x 24 in', sku: 'GANG-24', quantity: 1, price: '15.00', requires_shipping: true, properties: [] },
    ],
    note_attributes: [],
    ...over,
  };
}

async function main() {
  console.log('=== SHOPIFY STORE ORDERS ===');
  const db = require('./server/db');
  await db.ready;
  require('./server/seed')();
  const set = (key, value) => db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, String(value), new Date().toISOString());
  set('email_provider', 'mock');
  set('shopify_shop_domain', 'test-shop.myshopify.com');
  set('shopify_client_id', 'cid');
  set('shopify_client_secret', 'secret');
  const so = require('./server/services/shopifyOrders');
  const { computeCheckout } = require('./server/checkoutRules');

  // ---- import ----
  const r = so.importOrder(storeOrder());
  assert.ok(r && r.created, 'a paid store order is imported');
  const q = r.quote;
  assert.strictEqual(q.quote_code, 'SH-1001');
  assert.strictEqual(q.status, 'paid');
  assert.strictEqual(q.fulfillment_method, 'shipping');
  assert.strictEqual(q.amount_paid, 56.59);
  const snap = JSON.parse(q.pricing_snapshot);
  assert.strictEqual(snap.totalQty, 4);
  assert.strictEqual(snap.garment.name, 'DTF Transfer (11 x 11 in) + 1 more');
  assert.deepStrictEqual(snap.shopifyOrder.items[0].properties, [{ name: 'Upload', value: 'https://files.example.com/art.png' }], 'upload links kept, empty properties dropped');
  assert.strictEqual(snap.shopifyOrder.adminUrl, 'https://test-shop.myshopify.com/admin/orders/5550001');
  const money = computeCheckout(snap.total, { rushRule: snap.rushRule, fixed: snap.fixedTotals, shipping: true });
  assert.strictEqual(money.grandTotal, 56.59, "Shopify's total is kept, no extra tax added");
  assert.strictEqual(money.taxAmount, 3.6);
  assert.strictEqual(money.shippingFee, 7.99);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(q.customer_id);
  assert.strictEqual(customer.email, 'store.buyer@example.com', 'customer stored by lower-case email');
  console.log('  ok: a paid store order comes in as SH-1001 with its items, upload links and Shopify totals');

  // ---- no duplicates, updates kept in step ----
  const again = so.importOrder(storeOrder({ total_outstanding: '0.00', line_items: storeOrder().line_items.slice(0, 1), subtotal_price: '30.00', total_price: '41.59' }));
  assert.ok(again && !again.created, 'the same order is not imported twice');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM quotes WHERE quote_code LIKE 'SH-%'").get().n, 1);
  assert.strictEqual(JSON.parse(again.quote.pricing_snapshot).fixedTotals.grandTotal, 41.59, 'edits in Shopify update the order here');
  console.log('  ok: the same order never comes in twice; edits in Shopify update it');

  // ---- skipped orders ----
  assert.strictEqual(so.importOrder(storeOrder({ id: 5550002, admin_graphql_api_id: 'gid://shopify/Order/5550002', order_number: 1002, financial_status: 'pending' })), null, 'unpaid orders wait until paid');
  assert.strictEqual(so.importOrder(storeOrder({ id: 5550003, admin_graphql_api_id: 'gid://shopify/Order/5550003', order_number: 1003, note_attributes: [{ name: 'quote_id', value: '3T-12345' }] })), null, 'calculator checkouts are not imported');
  assert.strictEqual(so.importOrder(storeOrder({ id: 5550004, admin_graphql_api_id: 'gid://shopify/Order/5550004', order_number: 1004, note: '3T cart of 2 orders: ...' })), null, 'calculator carts are not imported');
  const pickupOrder = so.importOrder(storeOrder({ id: 5550005, admin_graphql_api_id: 'gid://shopify/Order/5550005', order_number: 1005, shipping_lines: [{ title: 'Local Pickup', code: 'pickup', price: '0.00' }] }));
  assert.strictEqual(pickupOrder.quote.fulfillment_method, 'pickup', 'Shopify local pickup becomes a pickup order');
  const deposit = so.importOrder(storeOrder({ id: 5550006, admin_graphql_api_id: 'gid://shopify/Order/5550006', order_number: 1006, financial_status: 'partially_paid', total_outstanding: '20.00' }));
  assert.strictEqual(deposit.quote.status, 'deposit_paid');
  assert.strictEqual(deposit.quote.balance_due, 20);
  console.log('  ok: unpaid orders and calculator checkouts are skipped; local pickup and partial payments handled');

  // ---- fulfilling in Shopify (Shopify faked) ----
  const calls = [];
  const realFetch = global.fetch;
  let mode = 'ok';
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const json = (status, body) => ({ ok: status < 400, status, statusText: String(status), headers: { get: () => '' }, json: async () => body });
    if (/oauth\/access_token/.test(url)) return json(200, { access_token: 'tok', expires_in: 86399 });
    if (/fulfillment_orders\.json/.test(url)) {
      if (mode === 'forbidden') return json(403, { errors: '[API] This action requires merchant approval for write_merchant_managed_fulfillment_orders scope.' });
      return json(200, { fulfillment_orders: [{ id: 91, status: 'open', supported_actions: ['create_fulfillment'] }, { id: 92, status: 'closed' }] });
    }
    if (/fulfillments\.json/.test(url)) return json(201, { fulfillment: { id: 1 } });
    return json(404, {});
  };
  try {
    const fresh = db.prepare("SELECT * FROM quotes WHERE quote_code = 'SH-1001'").get();
    const done = await so.fulfillInShopify({ ...fresh, tracking_number: '1Z999', tracking_carrier: 'UPS' });
    assert.ok(done.ok, done.message);
    const post = calls.find(c => /fulfillments\.json/.test(c.url));
    assert.deepStrictEqual(post.body.fulfillment.line_items_by_fulfillment_order, [{ fulfillment_order_id: 91 }], 'only the open fulfillment order is fulfilled');
    assert.strictEqual(post.body.fulfillment.notify_customer, false, "Shopify doesn't email the customer");
    assert.strictEqual(post.body.fulfillment.tracking_info.number, '1Z999');
    mode = 'forbidden';
    const denied = await so.fulfillInShopify(fresh);
    assert.ok(!denied.ok && /write_merchant_managed_fulfillment_orders/.test(denied.message), 'a missing permission is explained');
    const noShopify = await so.fulfillInShopify({ ...fresh, shopify_order_id: null });
    assert.ok(noShopify.skipped, 'orders without a Shopify order are left alone');
  } finally {
    global.fetch = realFetch;
  }
  console.log('  ok: finishing an order marks it fulfilled in Shopify (no Shopify email), and a missing permission is explained');

  // ---- alert email ----
  const emailService = require('./server/services/emailService');
  await emailService.sendShopifyOrderAlert(q, customer, snap, 'https://admin.example.com');
  const alert = db.prepare("SELECT * FROM emails_sent WHERE subject LIKE 'NEW SHOPIFY ORDER%' ORDER BY id DESC").get();
  assert.ok(alert && alert.subject.includes('#1001') && alert.body_html.includes('https://files.example.com/art.png'), 'the shop is alerted with the items and upload link');
  console.log('  ok: the shop gets a "NEW SHOPIFY ORDER" alert with the items and upload links');

  console.log('ALL SHOPIFY STORE ORDER CHECKS PASSED');
  process.exit(0);
}

main().catch(err => { console.error('SHOPIFY STORE ORDERS TEST FAILED:', err); process.exit(1); });
