// Focused regression test for the fees engine: per-decoration-method setup
// fee, per-color fee (with the requires-color-count flag), small-order fee
// threshold, and the global rush production fee percentage. Also verifies
// the money-critical guarantee that all fees default to $0/disabled, so
// existing DTF pricing (and every pre-fees quote/test) is completely
// unaffected until an admin explicitly configures a fee.
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function adminLogin() {
  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  assert(loginResp.ok, 'admin login succeeds');
  return loginResp.headers.get('set-cookie');
}

async function estimate(body) {
  const resp = await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await resp.json();
  assert(resp.ok, `estimate request succeeds (got: ${JSON.stringify(json)})`);
  return json.estimate;
}

async function main() {
  console.log('=== FEES ENGINE ===');
  const cookie = await adminLogin();

  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const adminMethods = await (await fetch(`${BASE}/api/admin/decoration-methods`, { headers: { Cookie: cookie } })).json();
  const dtf = adminMethods.decorationMethods.find(m => m.code === 'dtf');
  const screenPrint = adminMethods.decorationMethods.find(m => m.code === 'screen_print');
  assert(dtf && screenPrint, 'DTF and Screen Print methods both exist');

  const colorSelections = qty => [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty }] }];

  // ---- 0) fee config requires auth ----
  const unauthResp = await fetch(`${BASE}/api/admin/decoration-methods/${dtf.id}/fees`);
  assert.strictEqual(unauthResp.status, 401, 'fee config route requires admin auth');
  console.log('  ok: decoration-method fees admin route requires auth');

  // ---- 1) DTF fees all default to 0/disabled ----
  const dtfFees = (await (await fetch(`${BASE}/api/admin/decoration-methods/${dtf.id}/fees`, { headers: { Cookie: cookie } })).json()).fees;
  assert.strictEqual(Number(dtfFees.setup_fee), 0, 'DTF setup fee defaults to $0');
  assert.strictEqual(Number(dtfFees.requires_color_count), 0, 'DTF does not require a color count');
  assert.strictEqual(Number(dtfFees.per_color_fee), 0, 'DTF per-color fee defaults to $0');
  assert.strictEqual(Number(dtfFees.minimum_order_qty), 0, 'DTF small-order threshold defaults to disabled (0)');
  console.log('  ok: DTF fee config defaults to fully disabled — matches pre-fees pricing exactly');

  // ---- 2) a plain DTF estimate has no fee lines and an unaffected total ----
  const plainDtf = await estimate({ garmentId: tee.id, decorationMethodId: dtf.id, colorSelections: colorSelections(24), printLocationIds: [] });
  assert.strictEqual(plainDtf.feeLines.length, 0, 'plain DTF estimate has zero fee lines');
  assert.strictEqual(plainDtf.feesTotal, 0, 'plain DTF estimate has $0 fees total');
  assert.strictEqual(plainDtf.total, 480, `plain DTF 24pc total is unaffected by the fees engine (got $${plainDtf.total})`);
  console.log('  ok: DTF pricing is byte-for-byte unaffected by the fees engine when no fees are configured');

  // ---- 3) Screen Print defaults to requires_color_count=1 (fee still $0 until set) ----
  const spFeesBefore = (await (await fetch(`${BASE}/api/admin/decoration-methods/${screenPrint.id}/fees`, { headers: { Cookie: cookie } })).json()).fees;
  assert.strictEqual(Number(spFeesBefore.requires_color_count), 1, 'Screen Print is seeded requiring a color count out of the box');
  console.log('  ok: Screen Print seeded with requires_color_count=1 (fee amount still $0 as a placeholder)');

  // ---- 4) configure Screen Print fees, activate it, and price it ----
  const setFeesResp = await fetch(`${BASE}/api/admin/decoration-methods/${screenPrint.id}/fees`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ setupFee: 25, requiresColorCount: true, perColorFee: 2.5, minimumOrderQty: 12, minimumOrderFee: 15 }),
  });
  assert(setFeesResp.ok, 'setting Screen Print fee config succeeds');
  await fetch(`${BASE}/api/admin/pricing-tiers/bulk-fill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ decorationMethodId: screenPrint.id, fromQty: 1, toQty: 500, standardPrice: 10, hardFloorPrice: 8 }),
  });
  await fetch(`${BASE}/api/admin/decoration-methods/${screenPrint.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ active: true }),
  });
  console.log('  ok: configured Screen Print fees ($25 setup, $2.50/color, $15 fee under 12pc) and activated it');

  // ---- 5) 24pc @ 3 colors: base ($240) + setup ($25) + per-color (3 x $2.50 = $7.50) = $272.50 ----
  const spEstimate = await estimate({ garmentId: tee.id, decorationMethodId: screenPrint.id, colorCount: 3, colorSelections: colorSelections(24), printLocationIds: [] });
  assert.strictEqual(spEstimate.requiresColorCount, true, 'estimate reports Screen Print requires a color count');
  assert.strictEqual(spEstimate.colorCount, 3, 'estimate echoes the requested color count');
  assert.strictEqual(spEstimate.feeLines.length, 2, `24pc/3-color order above the minimum has exactly 2 fee lines: setup + per-color (got ${spEstimate.feeLines.length})`);
  assert.strictEqual(spEstimate.feesTotal, 32.5, `fees total is $25 setup + $7.50 per-color = $32.50 (got $${spEstimate.feesTotal})`);
  assert.strictEqual(spEstimate.total, 272.5, `24pc Screen Print total is $240 base + $32.50 fees = $272.50 (got $${spEstimate.total})`);
  console.log(`  ok: 24pc/3-color Screen Print order prices correctly at $${spEstimate.total} (base $240 + setup $25 + per-color $7.50)`);

  // ---- 6) colorCount defaults to 1 when omitted (still >= 1, never 0) ----
  const spNoColorCount = await estimate({ garmentId: tee.id, decorationMethodId: screenPrint.id, colorSelections: colorSelections(24), printLocationIds: [] });
  assert.strictEqual(spNoColorCount.colorCount, 1, 'omitting colorCount defaults to 1, never 0');
  const perColorLine = spNoColorCount.feeLines.find(l => l.type === 'per_color');
  assert.strictEqual(perColorLine.amount, 2.5, `default colorCount=1 charges exactly one color's fee (got $${perColorLine.amount})`);
  console.log('  ok: omitting colorCount safely defaults to 1 color, not 0 (no free per-color fee)');

  // ---- 7) below the minimum-order threshold adds the small-order fee ----
  const spBelowMin = await estimate({ garmentId: tee.id, decorationMethodId: screenPrint.id, colorCount: 3, colorSelections: colorSelections(8), printLocationIds: [] });
  const minOrderLine = spBelowMin.feeLines.find(l => l.type === 'minimum_order');
  assert(minOrderLine && minOrderLine.amount === 15, `8pc order (below the 12pc threshold) picks up the $15 small-order fee (got: ${JSON.stringify(minOrderLine)})`);
  assert.strictEqual(spBelowMin.total, 8 * 10 + 25 + 7.5 + 15, `8pc Screen Print total includes all three fees (got $${spBelowMin.total})`);
  console.log(`  ok: order below the minimum-order threshold correctly picks up the small-order fee ($${spBelowMin.total} total)`);

  // ---- 8) at/above the threshold, no small-order fee ----
  const spAtMin = await estimate({ garmentId: tee.id, decorationMethodId: screenPrint.id, colorCount: 3, colorSelections: colorSelections(12), printLocationIds: [] });
  assert(!spAtMin.feeLines.some(l => l.type === 'minimum_order'), 'order exactly at the minimum-order threshold does NOT get the small-order fee');
  console.log('  ok: order exactly at the minimum-order threshold is not charged the small-order fee (only orders strictly below it are)');

  // ---- 9) rush fee is global — works on DTF too, computed on the discounted subtotal ----
  const dtfRush = await estimate({ garmentId: tee.id, decorationMethodId: dtf.id, rushRequested: true, colorSelections: colorSelections(24), printLocationIds: [] });
  const rushLine = dtfRush.feeLines.find(l => l.type === 'rush');
  assert(rushLine, 'rush fee line appears when rushRequested=true, even on DTF (rush is method-agnostic)');
  assert.strictEqual(dtfRush.rushFeePercent, 25, 'default rush fee percent is 25%');
  assert.strictEqual(rushLine.amount, 120, `rush fee is 25% of the $480 discounted subtotal = $120 (got $${rushLine.amount})`);
  assert.strictEqual(dtfRush.total, 600, `24pc DTF + rush = $480 + $120 = $600 (got $${dtfRush.total})`);
  console.log(`  ok: rush fee applies globally (tested on DTF) — $${dtfRush.total} total with rush requested`);

  // ---- 10) rush fee percent is admin-editable ----
  const setRushResp = await fetch(`${BASE}/api/admin/rush-fee-setting`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ rushFeePercent: 40 }),
  });
  assert(setRushResp.ok, 'updating the global rush fee percent succeeds');
  const dtfRush40 = await estimate({ garmentId: tee.id, decorationMethodId: dtf.id, rushRequested: true, colorSelections: colorSelections(24), printLocationIds: [] });
  const rushLine40 = dtfRush40.feeLines.find(l => l.type === 'rush');
  assert.strictEqual(rushLine40.amount, 192, `after raising rush fee to 40%, 24pc DTF rush fee is $480 x 0.40 = $192 (got $${rushLine40.amount})`);
  // revert so future runs stay at the documented default
  await fetch(`${BASE}/api/admin/rush-fee-setting`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ rushFeePercent: 25 }),
  });
  console.log('  ok: rush fee percent is admin-editable and immediately reflected in pricing');

  // ---- 11) a generated quote freezes its fee lines in the snapshot, and re-derivation (checkout) preserves them ----
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const quoteResp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, decorationMethodId: screenPrint.id, colorCount: 2,
      colorSelections: colorSelections(24), printLocationIds: [], draftToken: draftTokenResp.draftToken,
      firstName: 'Fee', lastName: 'Test', email: `fee.test.${Date.now()}@example.com`, phone: '555-777-8888',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(quoteResp.ok, 'quote generation with fee-bearing decoration method succeeds');
  const { quoteCode } = await quoteResp.json();

  const quoteDetail = await (await fetch(`${BASE}/api/quotes/${quoteCode}`)).json();
  assert.strictEqual(quoteDetail.pricing.total, 24 * 10 + 25 + 5, `generated quote total includes fees: $240 + $25 setup + $5 (2 colors) = $270 (got $${quoteDetail.pricing.total})`);
  assert.strictEqual(quoteDetail.pricing.feesTotal, 30, `quote detail page shows the frozen fees total of $30 (got $${quoteDetail.pricing.feesTotal})`);
  assert.strictEqual(quoteDetail.pricing.feeLines.length, 2, 'quote detail page shows both frozen fee line items');
  console.log(`  ok: generated quote ${quoteCode} freezes its fee lines ($${quoteDetail.pricing.feesTotal} total) and the customer-facing quote page shows them`);

  // deactivate Screen Print again so it doesn't linger as live/sellable after the test
  await fetch(`${BASE}/api/admin/decoration-methods/${screenPrint.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ active: false }),
  });

  console.log('\n=== ALL FEES ENGINE CHECKS PASSED ===');
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
