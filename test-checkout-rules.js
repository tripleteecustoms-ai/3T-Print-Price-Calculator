// Step 4 checkout rules (server/checkoutRules.js): sales tax on order +
// rush, optional rush fee, full payment under the deposit threshold and a
// deposit option at/above it, Local Pickup default vs Shipping (address
// required), admin-editable rates, and what the mock/Shopify checkout
// charges. Runs against a server on :4790.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

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

let teeId, loc;
async function makeQuote(qty, codes, extra = {}) {
  const r = await call('POST', '/api/quotes', {
    firstName: 'Check', lastName: 'Out', email: `checkout.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`, phone: '4785551111',
    termsAccepted: true, fulfillmentMethod: 'pickup',
    garmentId: teeId, colorSelections: [{ colorName: 'Black', sizes: [{ label: 'L', qty }] }], printLocationIds: codes.map(c => loc[c]),
    ...extra,
  });
  return r;
}

async function main() {
  console.log('=== CHECKOUT RULES (Step 4) ===');
  teeId = (await call('GET', '/api/garments')).body.garments.find(g => g.name === 'Standard Quality T-Shirt').id;
  loc = Object.fromEntries((await call('GET', '/api/print-locations')).body.printLocations.map(l => [l.code, l.id]));

  // ---- tax, no rush, under the deposit threshold ----
  const small = await makeQuote(24, ['front', 'back']);
  assert.strictEqual(small.status, 200, JSON.stringify(small.body));
  let q = (await call('GET', `/api/quotes/${small.body.quoteCode}`)).body;
  assert.strictEqual(q.quote.fulfillmentMethod, 'pickup', 'Local Pickup is the default');
  assert.strictEqual(q.checkout.orderTotal, 588.00);
  assert.strictEqual(q.checkout.taxAmount, 47.04, '8% of $588.00');
  assert.strictEqual(q.checkout.grandTotal, 635.04);
  assert.strictEqual(q.checkout.depositAvailable, false, 'no deposit option under $1,000');
  console.log('  ok: 24 tees front+back: $588.00 + 8% tax $47.04 = $635.04, pay in full only');

  // ---- rush: 20% of order, and taxed ----
  let opt = await call('POST', `/api/quotes/${small.body.quoteCode}/checkout-options`, { rush: true });
  assert.strictEqual(opt.body.checkout.rushFee, 117.60, '20% of $588.00');
  assert.strictEqual(opt.body.checkout.taxAmount, 56.45, '8% of ($588.00 + $117.60)');
  assert.strictEqual(opt.body.checkout.grandTotal, 762.05);
  opt = await call('POST', `/api/quotes/${small.body.quoteCode}/checkout-options`, { paymentOption: 'deposit' });
  assert.strictEqual(opt.body.checkout.paymentOption, 'full', 'a deposit cannot be chosen under the threshold');
  assert.strictEqual(opt.body.checkout.rush, true, 'rush choice is remembered');
  console.log('  ok: rush adds 20% ($117.60) and tax covers it ($56.45); total $762.05; deposit refused under $1,000');

  // ---- full payment through checkout ----
  let co = await call('POST', `/api/quotes/${small.body.quoteCode}/checkout`, { termsAccepted: true });
  assert.strictEqual(co.status, 200, JSON.stringify(co.body));
  assert.ok(co.body.checkoutUrl.includes('amount=762.05'), 'checkout charges the grand total incl. rush and tax: ' + co.body.checkoutUrl);
  await call('POST', `/api/mock-payment/${small.body.quoteCode}/confirm`, {});
  q = (await call('GET', `/api/quotes/${small.body.quoteCode}`)).body;
  assert.strictEqual(q.quote.status, 'paid'); assert.strictEqual(q.quote.amountPaid, 762.05); assert.strictEqual(q.quote.balanceDue, 0);
  assert.strictEqual((await call('POST', `/api/quotes/${small.body.quoteCode}/checkout-options`, { rush: false })).status, 409, 'options locked once paid');
  console.log('  ok: paying in full charges $762.05 and marks the order paid; options lock after payment');

  // ---- deposit at $1,000+ ----
  const big = await makeQuote(100, ['front', 'back']);
  q = (await call('GET', `/api/quotes/${big.body.quoteCode}`)).body;
  assert.strictEqual(q.checkout.grandTotal, 2025.00, '$1,875.00 + 8% = $2,025.00');
  assert.strictEqual(q.checkout.depositAvailable, true);
  assert.strictEqual(q.checkout.paymentOption, 'full', 'full payment is the default even when a deposit is offered');
  opt = await call('POST', `/api/quotes/${big.body.quoteCode}/checkout-options`, { paymentOption: 'deposit' });
  assert.strictEqual(opt.body.checkout.amountDueNow, 1012.50); assert.strictEqual(opt.body.checkout.balanceDue, 1012.50);
  co = await call('POST', `/api/quotes/${big.body.quoteCode}/checkout`, { termsAccepted: true });
  assert.ok(co.body.checkoutUrl.includes('amount=1012.50'), 'checkout charges only the deposit: ' + co.body.checkoutUrl);
  await call('POST', `/api/mock-payment/${big.body.quoteCode}/confirm`, {});
  q = (await call('GET', `/api/quotes/${big.body.quoteCode}`)).body;
  assert.strictEqual(q.quote.status, 'deposit_paid'); assert.strictEqual(q.quote.amountPaid, 1012.50); assert.strictEqual(q.quote.balanceDue, 1012.50);
  console.log('  ok: 100 tees ($2,025.00 with tax) can pay a 50% deposit: $1,012.50 now, $1,012.50 balance, status "deposit paid"');

  // ---- the threshold is on the grand total ----
  const edge = await makeQuote(49, ['front']); // 49 x $15.75 = $771.75 -> +8% = $833.49
  assert.strictEqual((await call('GET', `/api/quotes/${edge.body.quoteCode}`)).body.checkout.depositAvailable, false, '$833.49 is under the line');
  opt = await call('POST', `/api/quotes/${edge.body.quoteCode}/checkout-options`, { rush: true }); // + $154.35 rush -> tax $74.09 -> $1,000.19
  assert.strictEqual(opt.body.checkout.grandTotal, 1000.19);
  assert.strictEqual(opt.body.checkout.depositAvailable, true, 'adding rush can lift an order over the $1,000 deposit line');
  console.log('  ok: deposit threshold applies to the grand total ($833.49 no; $1,000.19 with rush qualifies)');

  // ---- shipping ----
  const noAddr = await makeQuote(12, ['front'], { fulfillmentMethod: 'shipping', shippingAddress: { line1: '1 Main St' } });
  assert.strictEqual(noAddr.status, 400, 'shipping without a full address is refused');
  const shipped = await makeQuote(12, ['front'], { fulfillmentMethod: 'shipping', shippingAddress: { line1: '1 Main St', city: 'Macon', state: 'GA', zip: '31201' } });
  assert.strictEqual(shipped.status, 200);
  q = (await call('GET', `/api/quotes/${shipped.body.quoteCode}`)).body;
  assert.strictEqual(q.quote.fulfillmentMethod, 'shipping'); assert.strictEqual(q.quote.shippingAddress.city, 'Macon');
  console.log('  ok: Shipping requires a complete address; it is saved on the quote');

  // ---- 1,000+ pieces never check out ----
  const huge = await makeQuote(1000, ['front']);
  assert.strictEqual((await call('POST', `/api/quotes/${huge.body.quoteCode}/checkout`, { termsAccepted: true })).status, 400, '1,000+ pieces go to review');
  console.log('  ok: 1,000+ piece orders are refused at checkout (review instead)');

  // ---- admin: rates are editable; quote detail shows the money ----
  assert.strictEqual((await call('POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' })).status, 200);
  await call('PUT', '/api/admin/settings', { tax_rate_pct: '7', rush_fee_pct: '25', deposit_threshold: '500', deposit_pct: '40' });
  try {
    const fresh = await makeQuote(24, ['front', 'back']);
    opt = await call('POST', `/api/quotes/${fresh.body.quoteCode}/checkout-options`, { rush: true, paymentOption: 'deposit' });
    assert.strictEqual(opt.body.checkout.rushFee, 147.00, '25% of $588');
    assert.strictEqual(opt.body.checkout.taxAmount, 51.45, '7% of $735');
    assert.strictEqual(opt.body.checkout.grandTotal, 786.45);
    assert.strictEqual(opt.body.checkout.paymentOption, 'deposit', '$500 threshold now allows a deposit');
    assert.strictEqual(opt.body.checkout.amountDueNow, 314.58, '40% of $786.45');
    const detail = (await call('GET', `/api/admin/quotes/${fresh.body.quoteCode}`)).body;
    assert.strictEqual(detail.checkout.grandTotal, 786.45, 'admin quote detail shows the checkout totals');
    console.log('  ok: admin can change tax (7%), rush (25%), deposit threshold ($500) and deposit (40%)');
  } finally {
    await call('PUT', '/api/admin/settings', { tax_rate_pct: '8', rush_fee_pct: '20', deposit_threshold: '1000', deposit_pct: '50' });
  }

  // ---- what Shopify is sent (pure function, loaded against a throwaway DB copy) ----
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), '3t-checkout-test-'));
  const { checkoutLineItems } = require('./server/services/paymentService');
  const snap = { garment: { name: 'Standard Quality T-Shirt' }, totalQty: 24, total: 588 };
  const full = checkoutLineItems({ payment_option: 'full', rush_fee: 117.6, tax_amount: 56.45, quote_code: 'X' }, snap);
  assert.deepStrictEqual(full.map(l => l.amount), [588, 117.6, 56.45], 'full payment: order, rush, tax lines');
  assert.deepStrictEqual(full.map(l => l.title.split(':')[0]), ['Standard Quality T-Shirt', 'Rush Fee', 'Sales Tax']);
  const dep = checkoutLineItems({ payment_option: 'deposit', amount_due_now: 1012.5, grand_total: 2025, balance_due: 1012.5, quote_code: 'X', fulfillment_method: 'pickup' }, snap);
  assert.strictEqual(dep.length, 1); assert.strictEqual(dep[0].amount, 1012.5); assert.ok(/balance \$1012\.50 due before pickup/.test(dep[0].title));
  console.log('  ok: Shopify gets itemized order/rush/tax lines, or a single deposit line naming the balance');

  console.log('\n=== CHECKOUT RULE CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('CHECKOUT TEST FAILED:', err); process.exit(1); });
