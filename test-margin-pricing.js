// Phase 2: margin_based pricing mode.
// Selling Price = Total Unit Cost / (1 - Target Gross Margin).
// Spec's exact worked example: $10.00 total cost, 40% margin -> $16.67.
//
// Also covers: switching a garment between fixed_tier <-> margin_based,
// tier-varying freight folding into the per-unit cost, the internal
// "minimum target margin" warning (never blocks the customer, admin-only),
// and that a margin_based garment prices identically whether reached through
// the admin Price Tester or the real customer-facing /api/estimate endpoint
// (same calculateQuote() code path either way).
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function login() {
  const resp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  return resp.headers.get('set-cookie');
}

async function getJSON(url, opts) {
  const resp = await fetch(url, opts);
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, ok: resp.ok, body };
}

async function main() {
  console.log('=== MARGIN-BASED PRICING (dual pricing mode) ===');
  const cookie = await login();
  const authed = (opts = {}) => ({ ...opts, headers: { ...(opts.headers || {}), Cookie: cookie } });

  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tote = garments.find(g => g.name === 'Tote Bag');
  assert(tote, 'Tote Bag garment exists to use for this test');

  // Sanity: garments start in fixed_tier mode by default.
  const adminGarmentsBefore = await getJSON(`${BASE}/api/admin/garments`, authed());
  const toteBefore = adminGarmentsBefore.body.garments.find(g => g.id === tote.id);
  assert.strictEqual(toteBefore.pricing_mode, 'fixed_tier', 'Tote Bag starts in fixed_tier mode (the default)');

  try {
    // ---------------------------------------------------- switch to margin_based
    const switchResp = await getJSON(`${BASE}/api/admin/garments/${tote.id}/pricing-mode`, authed({
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pricingMode: 'margin_based' }),
    }));
    assert(switchResp.ok, 'admin can switch a garment to margin_based pricing mode');
    assert.strictEqual(switchResp.body.pricingMode, 'margin_based', 'switch response confirms margin_based');

    // ---------------------------------------------------- exact spec worked example: $10 cost, 40% margin -> $16.67
    const setCosts = await getJSON(`${BASE}/api/admin/garments/${tote.id}/cost-inputs`, authed({
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        garmentCost: 10, dtfTransferCost: 0, pressingLabor: 0, finishingPackaging: 0,
        spoilagePct: 0, paymentProcessingPct: 0, overhead: 0, targetMarginPct: 40,
      }),
    }));
    assert(setCosts.ok, 'cost inputs save successfully ($10.00 flat cost, 0% spoilage/processing, 40% target margin)');

    const readBack = await getJSON(`${BASE}/api/admin/garments/${tote.id}/cost-inputs`, authed());
    assert.strictEqual(Number(readBack.body.costInputs.garment_cost), 10, 'cost inputs persist and read back correctly (garment_cost=10)');
    assert.strictEqual(Number(readBack.body.costInputs.target_margin_pct), 40, 'cost inputs persist correctly (target_margin_pct=40)');

    const priceTest = await getJSON(`${BASE}/api/admin/garments/${tote.id}/price-test`, authed({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 10 }),
    }));
    assert(priceTest.ok, `Price Tester computes a price for the margin_based garment (status ${priceTest.status}, error: ${priceTest.body.error})`);
    assert.strictEqual(priceTest.body.standardUnit, 16.67, `EXACT spec worked example: $10.00 total cost, 40% margin -> $16.67/ea (got $${priceTest.body.standardUnit})`);
    console.log('  ok: Selling Price = Total Unit Cost / (1 - Target Gross Margin): $10.00 / (1 - 0.40) = $16.67 exactly');

    // Same number must come out of the REAL customer-facing endpoint too —
    // margin_based garments use the exact same calculateQuote() code path.
    const estResp = await getJSON(`${BASE}/api/estimate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        garmentId: tote.id,
        colorSelections: [{ colorName: 'Natural', colorHex: '#F1E7D0', sizes: [{ label: 'One Size', qty: 10 }] }],
        printLocationIds: [1],
      }),
    });
    assert(estResp.ok, 'customer-facing /api/estimate also succeeds for a margin_based garment');
    assert.strictEqual(estResp.body.estimate.standardUnit, 16.67, 'customer-facing estimate matches the admin Price Tester exactly ($16.67/ea) — same pricing engine, no divergence');
    console.log('  ok: margin_based garments price identically through the real customer quote flow and the admin Price Tester');

    // ---------------------------------------------------- tier-varying freight folds into cost
    const tiersResp = await getJSON(`${BASE}/api/quantity-tiers`);
    const tier1 = tiersResp.body.tiers.find(t => t.label === '1');
    const tier1024 = tiersResp.body.tiers.find(t => t.label === '10-24');
    assert(tier1 && tier1024, 'the "1" and "10-24" tiers exist to test freight variation against');

    const freightResp = await getJSON(`${BASE}/api/admin/garments/${tote.id}/tier-freight/${tier1024.id}`, authed({
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ freightPerUnit: 2 }),
    }));
    assert(freightResp.ok, 'admin can set tier-varying incoming-garment freight for a margin_based garment');

    const priceTestWithFreight = await getJSON(`${BASE}/api/admin/garments/${tote.id}/price-test`, authed({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 10 }), // qty=10 -> tier "10-24"
    }));
    // total unit cost is now $12 (10 garment + 2 freight), margin 40% -> 12 / 0.6 = 20.00
    assert.strictEqual(priceTestWithFreight.body.standardUnit, 20, `adding $2/unit tier freight raises the price from $16.67 to $20.00 (10-24 tier), got $${priceTestWithFreight.body.standardUnit}`);
    const priceTestNoFreight = await getJSON(`${BASE}/api/admin/garments/${tote.id}/price-test`, authed({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 1 }), // qty=1 -> tier "1", no freight override set
    }));
    assert.strictEqual(priceTestNoFreight.body.standardUnit, 16.67, `a DIFFERENT tier ("1") with no freight override set is unaffected by the 10-24 tier's freight (still $16.67), got $${priceTestNoFreight.body.standardUnit}`);
    console.log('  ok: incoming-garment freight varies per tier and correctly folds into the per-unit cost before the margin formula is applied');

    // ---------------------------------------------------- internal minimum-margin warning (never blocks the customer)
    // NOTE: belowMinimumMargin compares the ACTUAL selling price against
    // internal direct costs (blank/labor/print — the pre-existing internal
    // cost accounting), not directly against margin_based cost_inputs'
    // targetMarginPct. So to reliably trip it we price this garment far
    // below its real internal direct cost, regardless of what the
    // configured minimum_target_margin_pct Setting currently is.
    const marginSettingResp = await getJSON(`${BASE}/api/admin/settings`, authed());
    const minMargin = Number(marginSettingResp.body.settings.minimum_target_margin_pct ?? 20);
    assert(minMargin > 0, 'a minimum_target_margin_pct Setting exists and is configured (placeholder default, needs Trey\'s real input)');

    await getJSON(`${BASE}/api/admin/garments/${tote.id}/cost-inputs`, authed({
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ garmentCost: 1, dtfTransferCost: 0, pressingLabor: 0, finishingPackaging: 0, spoilagePct: 0, paymentProcessingPct: 0, overhead: 0, targetMarginPct: 1 }),
    }));
    const belowMarginTest = await getJSON(`${BASE}/api/admin/garments/${tote.id}/price-test`, authed({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qty: 1 }),
    }));
    assert(belowMarginTest.ok, 'a below-minimum-margin price still computes successfully — never blocks the internal calculation');
    assert.strictEqual(belowMarginTest.body.internal?.belowMinimumMargin, true, `Price Tester flags belowMinimumMargin=true when the selling price ($${belowMarginTest.body.standardUnit}) sits far below internal direct cost, under the configured minimum (${minMargin}%)`);

    // The customer-facing estimate must NEVER include this internal flag —
    // it's an internal-only warning, not something shown to a customer.
    const custEst = await getJSON(`${BASE}/api/estimate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ garmentId: tote.id, colorSelections: [{ colorName: 'Natural', colorHex: '#F1E7D0', sizes: [{ label: 'One Size', qty: 1 }] }], printLocationIds: [1] }),
    });
    assert(custEst.ok, 'customer-facing estimate for a below-minimum-margin garment still succeeds — margin warnings never block the customer flow');
    assert(!('belowMinimumMargin' in custEst.body.estimate) && !('internal' in custEst.body.estimate),
      'the below-minimum-margin warning is NOT exposed on the customer-facing estimate response (internal-only)');
    console.log('  ok: below-minimum-margin is flagged internally (admin Price Tester) but never blocks or leaks to the customer-facing quote flow');
  } finally {
    // revert so other test files (which assume Tote Bag is fixed_tier) stay clean
    await getJSON(`${BASE}/api/admin/garments/${tote.id}/pricing-mode`, authed({
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pricingMode: 'fixed_tier' }),
    }));
  }
  const adminGarmentsAfter = await getJSON(`${BASE}/api/admin/garments`, authed());
  const toteAfter = adminGarmentsAfter.body.garments.find(g => g.id === tote.id);
  assert.strictEqual(toteAfter.pricing_mode, 'fixed_tier', 'Tote Bag reverted back to fixed_tier mode (cleanup, so other test files are unaffected)');

  console.log('\n=== MARGIN-BASED PRICING CHECKS PASSED ===');
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
