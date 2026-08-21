// Phase 2: comprehensive tests for the 12-tier quantity-range pricing model
// (server/pricingEngine.js buildLivePricingTables/calculateQuote,
// server/seed.js migration). Covers, per the Phase 2 spec:
//   1. Every explicit tier-boundary quantity resolves to the correct tier,
//      through the real server-authoritative /api/estimate endpoint.
//   2. qty=10,000 (the cap) succeeds; qty=10,001 is rejected with the EXACT
//      required message.
//   3. A property-style check that every integer 1..10,000 maps to exactly
//      one active tier (validated against the live /api/quantity-tiers
//      config — not a hardcoded copy of it — so it also catches config drift).
//   4. The explicit acceptance criterion: an order with a REAL total >=
//      $8,000 at qty <= 1,000 is NOT flagged for manual review and is NOT
//      blocked at checkout — only quantity routes an order to review, never
//      dollar value. Contrasted against qty=1,001, which IS flagged/blocked
//      regardless of its dollar total.
//   5. The server never trusts a client-submitted total: it isn't even read
//      from the request body, and checkout always recomputes server-side.
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function getJSON(url, opts) {
  const resp = await fetch(url, opts);
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, ok: resp.ok, body };
}

// Split a total quantity across S/M/L/XL (all zero-surcharge sizes on the
// Standard Quality T-Shirt) into large chunks, so a single estimate call can
// reach quantities up into the thousands without relying on one absurdly
// large line item.
function sizesFor(totalQty) {
  const labels = ['S', 'M', 'L', 'XL'];
  const sizes = [];
  let remaining = totalQty;
  let i = 0;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 3000);
    sizes.push({ label: labels[i % labels.length], qty: chunk });
    remaining -= chunk;
    i++;
  }
  return sizes;
}

async function estimate(garmentId, totalQty) {
  return getJSON(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId,
      colorSelections: [{ colorName: 'Black', colorHex: '#111111', sizes: sizesFor(totalQty) }],
      printLocationIds: [1], // Front — included, $0 addon, so total == qty * standardUnit exactly
    }),
  });
}

async function main() {
  console.log('=== QUANTITY TIERS (Phase 2: 12-tier 1-10,000 model) ===');

  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  assert(tee, 'Standard Quality T-Shirt garment exists for testing against');

  const tiersResp = await getJSON(`${BASE}/api/quantity-tiers`);
  assert(tiersResp.ok, 'GET /api/quantity-tiers succeeds (public)');
  // Public endpoint already returns only active tiers, camelCase fields.
  const tiers = tiersResp.body.tiers.slice().sort((a, b) => a.minQty - b.minQty);
  assert.strictEqual(tiers.length, 12, `exactly 12 active tiers configured (found ${tiers.length})`);

  // ---------------------------------------------------------- 1) boundaries
  console.log('\n-- exact boundary quantities --');
  const boundaries = [1, 2, 5, 6, 9, 10, 24, 25, 49, 50, 99, 100, 249, 250, 499, 500, 999, 1000, 1001, 2499, 2500, 4999, 5000, 10000];
  const seenUnitPriceByTierId = {};
  for (const qty of boundaries) {
    const { ok, status, body } = await estimate(tee.id, qty);
    assert(ok, `qty=${qty} is accepted (status ${status}, error: ${body.error})`);
    const est = body.estimate;
    assert.strictEqual(est.totalQty, qty, `qty=${qty} round-trips as totalQty=${qty}`);
    const matchingTier = tiers.find(t => qty >= t.minQty && qty <= t.maxQty);
    assert(matchingTier, `qty=${qty} matches a configured tier range in /api/quantity-tiers`);
    assert.strictEqual(est.quantityTier.id, matchingTier.id, `qty=${qty} resolves to tier "${matchingTier.label}" (id ${matchingTier.id}), got tier id ${est.quantityTier.id} ("${est.quantityTier.label}")`);
    assert.strictEqual(est.quantityTier.checkoutBehavior, matchingTier.checkoutBehavior, `qty=${qty} tier checkoutBehavior matches config ("${matchingTier.checkoutBehavior}")`);
    // flat per-tier pricing: every qty in the same tier must produce the
    // SAME unit price (this is the whole point of Phase 2 replacing the old
    // per-exact-quantity graduated curve).
    if (seenUnitPriceByTierId[matchingTier.id] !== undefined) {
      assert.strictEqual(est.standardUnit, seenUnitPriceByTierId[matchingTier.id],
        `qty=${qty} (tier "${matchingTier.label}") has the SAME flat unit price ($${est.standardUnit}) as other quantities already tested in this tier`);
    } else {
      seenUnitPriceByTierId[matchingTier.id] = est.standardUnit;
    }
    console.log(`  ok: qty=${String(qty).padStart(5)} -> tier "${matchingTier.label}" (${matchingTier.checkoutBehavior}), $${est.standardUnit}/ea, total $${est.total}`);
  }

  // Two adjacent quantities straddling every tier boundary must land in
  // DIFFERENT tiers (proves no off-by-one in min/max handling), except where
  // the boundary itself is the 1..10,000 edges already covered above.
  console.log('\n-- adjacent-quantity boundary edges resolve to different tiers --');
  for (const t of tiers) {
    if (t.minQty > 1) {
      const below = await estimate(tee.id, t.minQty - 1);
      const at = await estimate(tee.id, t.minQty);
      assert.notStrictEqual(below.body.estimate.quantityTier.id, at.body.estimate.quantityTier.id,
        `qty=${t.minQty - 1} and qty=${t.minQty} land in different tiers (tier "${t.label}" starts exactly at ${t.minQty})`);
    }
  }
  console.log('  ok: every tier boundary is a clean cut — no off-by-one overlap');

  // ---------------------------------------------------------- 2) the 10,000 cap
  console.log('\n-- 10,000-piece cap --');
  const at10000 = await estimate(tee.id, 10000);
  assert(at10000.ok, 'qty=10,000 (the cap, inclusive) is accepted');
  const over = await estimate(tee.id, 10001);
  assert.strictEqual(over.status, 400, 'qty=10,001 is rejected (400)');
  assert.strictEqual(over.body.error, 'For orders above 10,000 pieces, contact 3T Print Solutions for a custom production proposal.',
    `qty=10,001 rejection message matches the EXACT required text (got: "${over.body.error}")`);
  console.log('  ok: qty=10,000 accepted, qty=10,001 rejected with the exact required message');

  // also enforced on real quote creation (POST /api/quotes), not just /estimate
  const overQuote = await getJSON(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: 'Black', colorHex: '#111', sizes: sizesFor(10001) }],
      printLocationIds: [1], firstName: 'Too', lastName: 'Many', email: `too.many.${Date.now()}@example.com`, phone: '555-100-0100',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert.strictEqual(overQuote.status, 400, 'POST /api/quotes also rejects qty=10,001 (400)');
  assert.strictEqual(overQuote.body.error, 'For orders above 10,000 pieces, contact 3T Print Solutions for a custom production proposal.',
    'POST /api/quotes gives the exact same required rejection message');
  console.log('  ok: quote creation (not just the live estimate) also enforces the 10,000-piece cap with the exact message');

  // ---------------------------------------------------------- 3) property check: every integer 1..10,000 maps to exactly one tier
  console.log('\n-- property check: every integer 1..10,000 maps to exactly ONE tier --');
  let gaps = 0, overlaps = 0;
  for (let n = 1; n <= 10000; n++) {
    const matches = tiers.filter(t => n >= t.minQty && n <= t.maxQty);
    if (matches.length === 0) gaps++;
    else if (matches.length > 1) overlaps++;
  }
  assert.strictEqual(gaps, 0, `no integer in 1..10,000 is left uncovered by a tier (found ${gaps} gap(s))`);
  assert.strictEqual(overlaps, 0, `no integer in 1..10,000 is covered by more than one tier (found ${overlaps} overlap(s))`);
  console.log('  ok: all 10,000 integer quantities map to exactly one tier, no gaps, no overlaps');

  // ---------------------------------------------------------- 4) $8,000+ at <=1,000 qty is NOT blocked/flagged; qty is the only trigger
  console.log('\n-- acceptance criterion: dollar value never blocks checkout, only quantity does --');
  const highValueQty = 1000; // upper edge of tier "500-1,000" — still checkoutBehavior: immediate
  const { body: highValueEst } = await estimate(tee.id, highValueQty);
  assert(highValueEst.estimate.total >= 8000, `sanity check: qty=${highValueQty} produces a REAL total >= $8,000 (got $${highValueEst.estimate.total}) — otherwise this test wouldn't be proving anything`);
  assert.strictEqual(highValueEst.estimate.quantityTier.checkoutBehavior, 'immediate', 'qty=1,000 is still an "immediate" checkout tier, despite the $8,000+ total');

  async function submitAndCheckout(qty, label) {
    const email = `qty-${qty}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`;
    const quoteResp = await getJSON(`${BASE}/api/quotes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        garmentId: tee.id, colorSelections: [{ colorName: 'Black', colorHex: '#111', sizes: sizesFor(qty) }],
        printLocationIds: [1], firstName: label, lastName: 'Tester', email, phone: '555-800-0800',
        fulfillmentMethod: 'pickup', termsAccepted: true,
      }),
    });
    assert(quoteResp.ok, `qty=${qty} quote is created successfully (status ${quoteResp.status})`);
    const { quoteCode, needsManualReview, reviewReasons } = quoteResp.body;
    const detail = await getJSON(`${BASE}/api/quotes/${quoteCode}`);
    const checkoutResp = await getJSON(`${BASE}/api/quotes/${quoteCode}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true }),
    });
    return { quoteCode, needsManualReview, reviewReasons, total: detail.body.pricing.total, checkoutResp };
  }

  const highValueOrder = await submitAndCheckout(highValueQty, 'HighValue');
  assert(highValueOrder.total >= 8000, `the ${highValueQty}pc order's server-recorded total is >= $8,000 ($${highValueOrder.total})`);
  assert.strictEqual(highValueOrder.needsManualReview, false, `an $${highValueOrder.total} order at qty=${highValueQty} (<=1,000) is NOT flagged needsManualReview — dollar value alone never triggers review`);
  assert(!highValueOrder.reviewReasons.includes('qty_over_1000'), 'qty=1,000 order does not carry the qty_over_1000 review reason');
  assert(highValueOrder.checkoutResp.ok, `an $${highValueOrder.total} order at qty=${highValueQty} reaches checkout successfully — NOT blocked by its dollar value`);
  console.log(`  ok: $${highValueOrder.total} order at qty=${highValueQty} is NOT flagged for review and checkout succeeds — dollar value never blocks`);

  const overQty = 1001; // one piece over the threshold — same garment, same per-unit ballpark price
  const overOrder = await submitAndCheckout(overQty, 'OverQty');
  assert.strictEqual(overOrder.needsManualReview, true, `qty=${overQty} IS flagged needsManualReview (only 1 more piece than the qty=1,000 order that was NOT flagged)`);
  assert(overOrder.reviewReasons.includes('qty_over_1000'), 'qty=1,001 order carries the qty_over_1000 review reason');
  assert.strictEqual(overOrder.checkoutResp.status, 400, 'qty=1,001 order is blocked from normal checkout (routed to production review instead)');
  assert.strictEqual(overOrder.checkoutResp.body.error, 'This order is in production and inventory review. You will receive a confirmed invoice within one business day — no payment is needed here.',
    'qty=1,001 checkout-blocked message is the expected production-review copy');
  console.log(`  ok: qty=${overQty} order IS flagged for review and blocked from normal checkout — proving QUANTITY (not dollar value) is what triggers review`);

  // ---------------------------------------------------------- 5) server never trusts a client-submitted total
  console.log('\n-- server-side price integrity: client total is never trusted --');
  const realQty = 250;
  const { body: realEst } = await estimate(tee.id, realQty);
  const realTotal = realEst.estimate.total;
  const bogusEmail = `bogus-total.${Date.now()}@example.com`;
  const bogusResp = await getJSON(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: 'Black', colorHex: '#111', sizes: sizesFor(realQty) }],
      printLocationIds: [1], firstName: 'Bogus', lastName: 'Total', email: bogusEmail, phone: '555-000-9999',
      fulfillmentMethod: 'pickup', termsAccepted: true,
      // a real attacker's payload: try to make the server believe the order costs $1
      total: 1, subtotal: 1, amount: 1, price: 1, clientTotal: 1,
    }),
  });
  assert(bogusResp.ok, 'quote creation with a bogus client-submitted total still succeeds (the field is simply ignored, not rejected)');
  const bogusDetail = await getJSON(`${BASE}/api/quotes/${bogusResp.body.quoteCode}`);
  assert.strictEqual(bogusDetail.body.pricing.total, realTotal,
    `server ignored the client's bogus total:1 and recorded the REAL recalculated total ($${realTotal}) instead (got $${bogusDetail.body.pricing.total})`);
  console.log(`  ok: client-submitted bogus total:1/subtotal:1/amount:1 fields are all ignored — server always recalculates ($${realTotal})`);

  console.log('\n=== ALL QUANTITY-TIER CHECKS PASSED ===');
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
