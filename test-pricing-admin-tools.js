// Phase 2: remaining admin pricing tools —
//   1. Quantity-tier CRUD (add / edit / rearrange / delete), including that
//      a brand-new tier automatically back-fills a $0, flagged-estimated
//      placeholder row for every existing garment and print location (never
//      silently priced at $0 with no warning).
//   2. Global price adjustment (%/$ bump) — fixed_tier garments scale their
//      tier prices, margin_based garments scale their underlying cost
//      instead (so the selling price moves via the margin formula, never
//      double-adjusted) — and the action is logged before/after.
//   3. Print-location tier-addon pricing, including a regression test for
//      the SAME "bulk save clears every Estimated badge" bug found (and
//      fixed) in the garment fixed-tier table — this file proves the
//      identical fix in the print-location matrix editor.
const { chromium } = require('playwright');
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
  console.log('=== ADMIN PRICING TOOLS: tier CRUD, global adjustment, location tier pricing ===');
  const cookie = await login();
  const authed = (opts = {}) => ({ ...opts, headers: { ...(opts.headers || {}), Cookie: cookie } });

  // ================================================================ 1) quantity-tier CRUD
  console.log('\n-- quantity-tier CRUD (add/edit/rearrange/delete) --');
  const tiersBefore = await getJSON(`${BASE}/api/admin/quantity-tiers`, authed());
  const countBefore = tiersBefore.body.tiers.length;
  assert.strictEqual(countBefore, 12, `starts with 12 tiers (found ${countBefore})`);

  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');

  // Placed well outside 1..10,000 so it can't disturb the property invariant
  // tested in test-quantity-tiers.js while it temporarily exists.
  const addResp = await getJSON(`${BASE}/api/admin/quantity-tiers`, authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'TEST-TEMP', minQty: 99999, maxQty: 100000, checkoutBehavior: 'review' }),
  }));
  assert(addResp.ok, 'admin can add a new quantity tier');
  const newTierId = addResp.body.id;
  assert(newTierId, 'new tier creation returns an id');

  const afterAdd = await getJSON(`${BASE}/api/admin/quantity-tiers`, authed());
  assert.strictEqual(afterAdd.body.tiers.length, countBefore + 1, 'tier count increased by 1 after adding');

  // A new tier must back-fill a $0, flagged-estimated placeholder for every
  // existing garment/location — never silently priced $0 with no warning.
  const teeTierPricesAfterAdd = await getJSON(`${BASE}/api/admin/garments/${tee.id}/tier-prices`, authed());
  const newTierRowForTee = teeTierPricesAfterAdd.body.tiers.find(t => t.tierId === newTierId);
  assert(newTierRowForTee, 'the new tier immediately appears in an existing garment\'s tier-price list');
  assert.strictEqual(newTierRowForTee.standardPrice, 0, 'the new tier starts at $0 for an existing garment (no invented price)');
  assert.strictEqual(newTierRowForTee.isEstimatedPrice, true, 'the new tier\'s $0 placeholder is flagged Estimated — never silently treated as a real price');
  console.log('  ok: adding a new tier back-fills a $0, flagged-Estimated placeholder for existing garments (never an invented number)');

  const locsAfterAdd = await getJSON(`${BASE}/api/admin/print-locations`, authed());
  const backLoc = locsAfterAdd.body.printLocations.find(l => l.name === 'Back');
  const newTierRowForLoc = backLoc.tierPricing.find(t => t.tierId === newTierId);
  assert(newTierRowForLoc && newTierRowForLoc.isEstimatedPrice === true && newTierRowForLoc.addonPrice === 0,
    'the new tier also back-fills a $0, flagged-Estimated placeholder for existing print locations');
  console.log('  ok: the same back-fill happens for print-location tier addon pricing');

  // edit
  const editResp = await getJSON(`${BASE}/api/admin/quantity-tiers/${newTierId}`, authed({
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'TEST-TEMP-EDITED', minQty: 99999, maxQty: 100000, checkoutBehavior: 'review', active: true }),
  }));
  assert(editResp.ok, 'admin can edit a tier\'s label/range/checkout behavior');
  const afterEdit = await getJSON(`${BASE}/api/admin/quantity-tiers`, authed());
  const editedTier = afterEdit.body.tiers.find(t => t.id === newTierId);
  assert.strictEqual(editedTier.label, 'TEST-TEMP-EDITED', 'the edited label persists');

  // rearrange: move the new tier to the very front
  const currentOrder = afterEdit.body.tiers.slice().sort((a, b) => a.sort_order - b.sort_order).map(t => t.id);
  const reordered = [newTierId, ...currentOrder.filter(id => id !== newTierId)];
  const reorderResp = await getJSON(`${BASE}/api/admin/quantity-tiers-reorder`, authed({
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: reordered }),
  }));
  assert(reorderResp.ok, 'admin can rearrange tier order');
  const afterReorder = await getJSON(`${BASE}/api/admin/quantity-tiers`, authed());
  const sortedIds = afterReorder.body.tiers.slice().sort((a, b) => a.sort_order - b.sort_order).map(t => t.id);
  assert.strictEqual(sortedIds[0], newTierId, 'the rearranged tier is now first by sort_order');
  console.log('  ok: admin can edit a tier and rearrange the full tier order');

  // delete (cleanup — also proves delete works)
  const delResp = await getJSON(`${BASE}/api/admin/quantity-tiers/${newTierId}`, authed({ method: 'DELETE' }));
  assert(delResp.ok, 'admin can delete a tier');
  const afterDelete = await getJSON(`${BASE}/api/admin/quantity-tiers`, authed());
  assert.strictEqual(afterDelete.body.tiers.length, countBefore, 'tier count is back to the original 12 after delete');
  assert(!afterDelete.body.tiers.some(t => t.id === newTierId), 'the deleted tier no longer appears');
  const teeTierPricesAfterDelete = await getJSON(`${BASE}/api/admin/garments/${tee.id}/tier-prices`, authed());
  assert(!teeTierPricesAfterDelete.body.tiers.some(t => t.tierId === newTierId), 'deleting a tier cascades — the garment no longer carries a price row for it');
  console.log('  ok: admin can delete a tier, and its per-garment/per-location price rows are cleaned up with it');

  // ================================================================ 2) global price adjustment
  console.log('\n-- global price adjustment tool --');
  const teeTierPricesBefore = await getJSON(`${BASE}/api/admin/garments/${tee.id}/tier-prices`, authed());
  const tier1Before = teeTierPricesBefore.body.tiers.find(t => t.label === '1');
  const backTierPricingBefore = (await getJSON(`${BASE}/api/admin/print-locations`, authed())).body.printLocations.find(l => l.name === 'Back');
  const backTier1Before = backTierPricingBefore.tierPricing.find(t => t.label === '1');

  const bumpAmount = 1.23; // a fixed $ amount, exactly reversible (no rounding drift) for the revert step below
  const bumpResp = await getJSON(`${BASE}/api/admin/global-price-adjustment`, authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixed', amount: bumpAmount }),
  }));
  assert(bumpResp.ok, 'a global fixed-$ price bump is accepted');
  assert(bumpResp.body.garmentsAffected > 0, 'the response reports how many garments were affected');

  const teeTierPricesAfterBump = await getJSON(`${BASE}/api/admin/garments/${tee.id}/tier-prices`, authed());
  const tier1AfterBump = teeTierPricesAfterBump.body.tiers.find(t => t.label === '1');
  assert.strictEqual(Math.round((tier1AfterBump.standardPrice - tier1Before.standardPrice) * 100) / 100, bumpAmount,
    `the T-shirt's tier-1 standard price rose by exactly $${bumpAmount} (from $${tier1Before.standardPrice} to $${tier1AfterBump.standardPrice})`);

  // NOTE: the global-price-adjustment tool (server/routes/admin.js) only
  // scales GARMENT pricing (garment_tier_prices / garment_cost_inputs) — it
  // deliberately does not touch print_location_tier_pricing. Confirm that
  // scope boundary explicitly rather than assuming it's blanket "everything":
  const backTierPricingAfterBump = (await getJSON(`${BASE}/api/admin/print-locations`, authed())).body.printLocations.find(l => l.name === 'Back');
  const backTier1AfterBump = backTierPricingAfterBump.tierPricing.find(t => t.label === '1');
  assert.strictEqual(backTier1AfterBump.addonPrice, backTier1Before.addonPrice,
    'print-location addon pricing is UNCHANGED by a global adjustment — the tool\'s scope is garment pricing only, not location addons (by design)');
  console.log(`  ok: a $${bumpAmount} fixed global bump applies to garment fixed-tier prices; print-location addons are out of its scope (by design)`);

  const logResp = await getJSON(`${BASE}/api/admin/action-log`, authed());
  const logEntry = logResp.body.log[0];
  assert.strictEqual(logEntry.action_type, 'global_price_adjustment', 'the adjustment is logged as the most recent admin_action_log entry');
  assert.strictEqual(logEntry.detail.mode, 'fixed', 'the log entry records the mode used');
  assert.strictEqual(logEntry.detail.amount, bumpAmount, 'the log entry records the amount used');
  assert(Array.isArray(logEntry.detail.before) && Array.isArray(logEntry.detail.after) && logEntry.detail.before.length > 0,
    'the log entry captures full before/after snapshots (reusing the existing audit-log pattern)');
  console.log('  ok: the global adjustment is logged with mode, amount, and full before/after snapshots');

  // Fully revert this bump (affects every currently fixed_tier garment, tee
  // included) BEFORE starting the margin_based demo below — doing the
  // bump+revert round trip in one clean, uninterrupted pair (rather than
  // interleaving it with a pricing-mode switch on a different garment) keeps
  // the arithmetic exact and avoids ever touching is_estimated_price flags
  // via any path other than a deliberate per-tier edit.
  const revertResp = await getJSON(`${BASE}/api/admin/global-price-adjustment`, authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixed', amount: -bumpAmount }),
  }));
  assert(revertResp.ok, 'the global bump can be reverted with an equal-and-opposite fixed adjustment');
  const teeTierPricesReverted = await getJSON(`${BASE}/api/admin/garments/${tee.id}/tier-prices`, authed());
  const tier1Reverted = teeTierPricesReverted.body.tiers.find(t => t.label === '1');
  assert.strictEqual(tier1Reverted.standardPrice, tier1Before.standardPrice, `reverting restores the original tier-1 price exactly ($${tier1Before.standardPrice})`);
  console.log('  ok: reverted the test bump — other test files see the original seeded prices again');

  // margin_based garments: cost moves, not the selling price directly. Do
  // this bump+revert as its own clean, uninterrupted pair too (Tote stays
  // margin_based for BOTH calls) so it round-trips exactly and never leaves
  // any OTHER (still fixed_tier) garment permanently bumped.
  const tote = garments.find(g => g.name === 'Tote Bag');
  await getJSON(`${BASE}/api/admin/garments/${tote.id}/pricing-mode`, authed({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pricingMode: 'margin_based' }) }));
  await getJSON(`${BASE}/api/admin/garments/${tote.id}/cost-inputs`, authed({
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ garmentCost: 5, dtfTransferCost: 0, pressingLabor: 0, finishingPackaging: 0, spoilagePct: 0, paymentProcessingPct: 0, overhead: 0, targetMarginPct: 40 }),
  }));
  const bump2 = await getJSON(`${BASE}/api/admin/global-price-adjustment`, authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixed', amount: 2 }),
  }));
  assert(bump2.ok, 'global adjustment also runs cleanly with a margin_based garment present');
  const toteCostsAfter = await getJSON(`${BASE}/api/admin/garments/${tote.id}/cost-inputs`, authed());
  assert.strictEqual(Number(toteCostsAfter.body.costInputs.garment_cost), 7, 'for a margin_based garment, the global adjustment bumps the underlying COST ($5 -> $7), not a stored selling price');
  console.log('  ok: margin_based garments have their cost inputs adjusted (selling price then moves on its own via the margin formula — never double-adjusted)');

  const bump2Revert = await getJSON(`${BASE}/api/admin/global-price-adjustment`, authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixed', amount: -2 }),
  }));
  assert(bump2Revert.ok, 'the margin_based-demo bump can be reverted the same way');
  const teeTierPricesFinal = await getJSON(`${BASE}/api/admin/garments/${tee.id}/tier-prices`, authed());
  assert.strictEqual(teeTierPricesFinal.body.tiers.find(t => t.label === '1').standardPrice, tier1Before.standardPrice,
    'other (still fixed_tier) garments touched by the margin_based-demo bump are ALSO fully reverted — no permanent side effect from this test');
  // cleanup: revert Tote Bag back to fixed_tier (its own tier prices were
  // never touched while it was margin_based, so nothing else to restore for it)
  await getJSON(`${BASE}/api/admin/garments/${tote.id}/pricing-mode`, authed({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pricingMode: 'fixed_tier' }) }));
  console.log('  ok: cleaned up fully — no test-induced permanent pricing changes remain for any garment');

  // ================================================================ 3) print-location tier pricing + the dirty-row regression test
  console.log('\n-- print-location tier pricing (regression: bulk-save no longer clears untouched Estimated badges) --');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const apage = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await apage.goto(BASE + '/admin/login.html');
  await apage.fill('#username', 'admin');
  await apage.fill('#password', '3tprint-admin-2026');
  await apage.click('#loginBtn');
  await apage.waitForURL('**/admin/dashboard.html');
  await apage.click('.admin-nav-item[data-panel="locations"]');
  await apage.waitForSelector('[data-loc-id]');

  const backCard = apage.locator('[data-loc-id]').filter({ has: apage.locator('.l-name[value="Back"]') });
  await backCard.locator('.toggle-matrix-btn').click();
  await backCard.locator('.matrix-editor').waitFor({ state: 'visible' });

  // sanity: tier "10-24" (index 3) is real/Confirmed, tier "25-49" (index 4) is Estimated, before any edit
  const addon1024 = backCard.locator('.addon-input').nth(3);
  const addon2549 = backCard.locator('.addon-input').nth(4);
  assert.strictEqual(await addon1024.getAttribute('title'), 'Confirmed', 'Back location "10-24" addon starts Confirmed (real migrated data)');
  assert.strictEqual(await addon2549.getAttribute('title'), 'Estimated — needs review', 'Back location "25-49" addon starts Estimated (placeholder)');

  // edit ONLY the "10-24" addon, save, and confirm the "25-49" addon (untouched) is STILL Estimated afterward
  await addon1024.fill('5.50');
  await backCard.locator('.save-matrix-btn').click();
  await apage.waitForTimeout(500);
  await apage.click('.admin-nav-item[data-panel="dashboard"]'); // navigate away and back to force a fresh loadLocations()
  await apage.click('.admin-nav-item[data-panel="locations"]');
  await apage.waitForSelector('[data-loc-id]');
  const backCard2 = apage.locator('[data-loc-id]').filter({ has: apage.locator('.l-name[value="Back"]') });
  await backCard2.locator('.toggle-matrix-btn').click();
  await backCard2.locator('.matrix-editor').waitFor({ state: 'visible' });
  const addon1024After = backCard2.locator('.addon-input').nth(3);
  const addon2549After = backCard2.locator('.addon-input').nth(4);
  assert.strictEqual(await addon1024After.inputValue(), '5.5', 'the edited "10-24" addon value persisted ($5.50)');
  assert.strictEqual(await addon1024After.getAttribute('title'), 'Confirmed', 'the edited "10-24" addon is (still) Confirmed');
  assert.strictEqual(await addon2549After.getAttribute('title'), 'Estimated — needs review',
    'the UNTOUCHED "25-49" addon is STILL flagged Estimated after saving a different row — bulk-save bug fixed here too');
  console.log('  ok: saving one edited print-location tier addon leaves other untouched tiers correctly flagged Estimated');

  // revert
  await addon1024After.fill('5.00');
  await backCard2.locator('.save-matrix-btn').click();
  await apage.waitForTimeout(400);
  await browser.close();

  console.log('\n=== PRICING ADMIN TOOLS CHECKS PASSED ===');
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
