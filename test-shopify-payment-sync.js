// Shopify payment sync (paymentService.syncShopifyPayment): a quote that
// went to Shopify checkout is marked paid once Shopify reports its draft
// order's order as paid. Standalone: runs against a throwaway copy of the
// database (DATA_DIR) with a fake fetch(), no server or real Shopify needed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), '3t-payment-sync-'));

async function main() {
  console.log('=== SHOPIFY PAYMENT SYNC ===');
  const db = require('./server/db');
  await db.ready;
  require('./server/seed')();
  const upsert = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  upsert.run('shopify_shop_domain', 'test-shop.myshopify.com');
  upsert.run('shopify_client_id', 'id');
  upsert.run('shopify_client_secret', 'secret');
  upsert.run('email_provider', 'mock');

  const pay = require('./server/services/paymentService');
  pay._setPaymentCheckIntervalMsForTests(0);

  // Fake Shopify: each draft order id maps to what its order looks like now.
  const shopify = {};
  let graphqlCalls = 0;
  let failNext = false;
  global.fetch = async (url, opts) => {
    if (url.includes('/admin/oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 86399 }) };
    if (url.includes('graphql.json')) {
      graphqlCalls++;
      if (failNext) { failNext = false; throw new Error('network down'); }
      const { variables } = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: { draftOrder: { id: variables.id, status: shopify[variables.id] ? 'COMPLETED' : 'INVOICE_SENT', order: shopify[variables.id] || null } } }) };
    }
    throw new Error('unexpected fetch ' + url);
  };

  const garment = db.prepare('SELECT id FROM garments LIMIT 1').get();
  const cust = db.prepare(`INSERT INTO customers (first_name,last_name,email,phone) VALUES ('Pay','Sync','paysync@example.com','4785550000')`).run().lastInsertRowid;
  function makeQuote(code, draftId, extra = {}) {
    const snap = JSON.stringify({ garment: { id: garment.id, name: 'Tee' }, totalQty: 24, total: 588 });
    db.prepare(`INSERT INTO quotes (quote_code, customer_id, status, garment_id, pricing_snapshot, subtotal, total, expires_at, shopify_draft_order_id,
      payment_provider, checkout_started_at, payment_option, grand_total, amount_due_now, balance_due)
      VALUES (?,?,?,?,?,588,588,?,?,'shopify',?,?,?,?,?)`)
      .run(code, cust, 'checkout_started', garment.id, snap, new Date(Date.now() + 7 * 864e5).toISOString(), draftId, new Date().toISOString(),
        extra.payment_option || 'full', extra.grand_total || 635.04, extra.amount_due_now || 635.04, extra.balance_due || 0);
    return db.prepare('SELECT * FROM quotes WHERE quote_code=?').get(code);
  }
  const emailsFor = (id) => db.prepare("SELECT COUNT(*) n FROM emails_sent WHERE quote_id=?").get(id).n;

  // ---- not paid yet: nothing changes ----
  let q = makeQuote('3T-SYNC-FULL', 'gid://shopify/DraftOrder/100');
  assert.strictEqual(await pay.syncShopifyPayment(q), null);
  assert.strictEqual(db.prepare('SELECT paid_at FROM quotes WHERE id=?').get(q.id).paid_at, null);
  console.log('  ok: an unpaid Shopify checkout stays unpaid');

  // ---- paid in Shopify: recorded once, one email ----
  shopify['gid://shopify/DraftOrder/100'] = { id: 'gid://shopify/Order/555', name: '#1055', displayFinancialStatus: 'PAID', processedAt: '2026-09-24T20:00:00Z', totalReceivedSet: { shopMoney: { amount: '635.04' } } };
  const before = emailsFor(q.id);
  const updated = await pay.syncShopifyPayment(q);
  assert.ok(updated, 'payment detected');
  assert.strictEqual(updated.status, 'paid');
  assert.strictEqual(updated.amount_paid, 635.04);
  assert.strictEqual(updated.paid_at, '2026-09-24T20:00:00Z');
  assert.strictEqual(updated.shopify_order_id, 'gid://shopify/Order/555');
  assert.strictEqual(updated.payment_reference, '#1055');
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(emailsFor(q.id), before + 1, 'one "payment received" email');
  const calls = graphqlCalls;
  assert.strictEqual(await pay.syncShopifyPayment(updated), null, 'already-paid quote is not checked again');
  assert.strictEqual(graphqlCalls, calls, 'no Shopify call for a paid quote');
  assert.strictEqual(await pay.syncShopifyPayment(q), null, 'a stale copy cannot record the payment twice');
  assert.strictEqual(emailsFor(q.id), before + 1, 'still exactly one email');
  console.log('  ok: once Shopify says PAID, the quote is marked paid with the Shopify order #, amount and time, and emailed once');

  // ---- deposit ----
  const dq = makeQuote('3T-SYNC-DEP', 'gid://shopify/DraftOrder/200', { payment_option: 'deposit', grand_total: 2025, amount_due_now: 1012.5, balance_due: 1012.5 });
  shopify['gid://shopify/DraftOrder/200'] = { id: 'gid://shopify/Order/556', name: '#1056', displayFinancialStatus: 'PAID', processedAt: null, totalReceivedSet: { shopMoney: { amount: '1012.50' } } };
  const d = await pay.syncShopifyPayment(dq);
  assert.strictEqual(d.status, 'deposit_paid'); assert.strictEqual(d.amount_paid, 1012.5); assert.ok(d.paid_at);
  console.log('  ok: a paid deposit checkout becomes "deposit paid" with the deposit amount');

  // ---- Shopify errors never break the page; throttle ----
  const eq = makeQuote('3T-SYNC-ERR', 'gid://shopify/DraftOrder/300');
  failNext = true;
  assert.strictEqual(await pay.syncShopifyPayment(eq), null, 'a Shopify outage returns null instead of throwing');
  pay._setPaymentCheckIntervalMsForTests(60000);
  const c2 = graphqlCalls;
  await pay.syncShopifyPayment(eq); await pay.syncShopifyPayment(eq);
  assert.ok(graphqlCalls - c2 <= 1, 'repeated checks within the window are throttled');
  pay._setPaymentCheckIntervalMsForTests(0);
  console.log('  ok: Shopify errors are swallowed (page still loads); rapid re-checks are throttled');

  // ---- background sweep ----
  shopify['gid://shopify/DraftOrder/300'] = { id: 'gid://shopify/Order/557', name: '#1057', displayFinancialStatus: 'PARTIALLY_PAID', totalReceivedSet: { shopMoney: { amount: '300.00' } } };
  const n = await pay.syncRecentShopifyPayments();
  assert.strictEqual(n, 1, 'sweep records the one newly paid checkout');
  assert.strictEqual(db.prepare('SELECT amount_paid FROM quotes WHERE id=?').get(eq.id).amount_paid, 300);
  console.log('  ok: the 10-minute background sweep picks up payments nobody looked at');

  // ---- non-Shopify quotes are ignored ----
  assert.strictEqual(await pay.syncShopifyPayment({ id: 999, paid_at: null, shopify_draft_order_id: null }), null);
  console.log('  ok: quotes that never went to Shopify are skipped');

  console.log('\n=== SHOPIFY PAYMENT SYNC CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('PAYMENT SYNC TEST FAILED:', err); process.exit(1); });
