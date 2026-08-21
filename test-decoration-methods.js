// Focused regression test for decoration methods (print methods): the
// entity itself (CRUD, unique codes, soft-delete), per-method pricing
// scoping across pricing_tiers and print_location_pricing (1-500), the
// bulk-fill admin convenience routes, the qty-500 cap (and 501 blocking),
// the inactive-method exploit-prevention guard, and the legacy no-method
// fallback that keeps pre-existing quotes/snapshots calculating correctly.
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

async function main() {
  console.log('=== DECORATION METHODS (PRINT METHODS) ===');
  const cookie = await adminLogin();

  // ---- 0) admin auth required ----
  const unauthResp = await fetch(`${BASE}/api/admin/decoration-methods`);
  assert.strictEqual(unauthResp.status, 401, 'listing decoration methods requires admin auth');
  console.log('  ok: decoration-methods admin routes require auth');

  // ---- 1) public list only shows active methods ----
  const publicList = await (await fetch(`${BASE}/api/decoration-methods`)).json();
  assert(publicList.decorationMethods.length >= 1, 'public list returns at least DTF');
  assert(publicList.decorationMethods.every(m => m.name), 'public methods have names');
  const dtf = publicList.decorationMethods.find(m => m.code === 'dtf');
  assert(dtf, 'DTF is present and active in the public list');
  console.log(`  ok: public decoration-methods list shows ${publicList.decorationMethods.length} active method(s), including DTF`);

  // ---- 2) admin list shows inactive placeholder methods too ----
  const adminList = await (await fetch(`${BASE}/api/admin/decoration-methods`, { headers: { Cookie: cookie } })).json();
  const inactiveSeeded = adminList.decorationMethods.filter(m => !m.active);
  assert(inactiveSeeded.length >= 3, `admin list includes seeded inactive placeholder methods (found ${inactiveSeeded.length})`);
  assert(adminList.decorationMethods.length > publicList.decorationMethods.length, 'admin list is a superset of the public (active-only) list');
  console.log(`  ok: admin list shows ${adminList.decorationMethods.length} total methods (${inactiveSeeded.length} inactive placeholders hidden from customers)`);

  // ---- 3) inactive method is rejected even when requested directly (exploit guard) ----
  const screenPrint = adminList.decorationMethods.find(m => m.code === 'screen_print');
  assert(screenPrint && !screenPrint.active, 'Screen Print exists and is inactive by default');
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const exploitResp = await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, decorationMethodId: screenPrint.id,
      colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 24 }] }],
      printLocationIds: [],
    }),
  });
  const exploitBody = await exploitResp.json();
  assert(!exploitResp.ok && /isn't available|not available/i.test(exploitBody.error || ''), `inactive method directly requested is rejected, not silently priced at $0 (got: ${JSON.stringify(exploitBody)})`);
  console.log('  ok: requesting an inactive decoration method directly is rejected (no $0 exploit)');

  // ---- 4) create a new decoration method ----
  const uniqueName = `Test Method ${Date.now()}`;
  const createResp = await fetch(`${BASE}/api/admin/decoration-methods`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: uniqueName }),
  });
  assert(createResp.ok, 'creating a new decoration method succeeds');
  const { id: newMethodId } = await createResp.json();
  console.log(`  ok: created new decoration method "${uniqueName}" (id ${newMethodId})`);

  // ---- 5) duplicate code is rejected ----
  const dupResp = await fetch(`${BASE}/api/admin/decoration-methods`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: uniqueName }),
  });
  assert.strictEqual(dupResp.status, 409, 'creating a decoration method with a duplicate code is rejected');
  console.log('  ok: duplicate decoration method code is rejected (409)');

  // ---- 6) new method is seeded with full 1-500 $0 placeholder pricing ----
  const newMethodTiers = await (await fetch(`${BASE}/api/admin/pricing-tiers?decorationMethodId=${newMethodId}`, { headers: { Cookie: cookie } })).json();
  assert.strictEqual(newMethodTiers.tiers.length, 500, `new method seeded with all 500 pricing-tier rows (got ${newMethodTiers.tiers.length})`);
  assert(newMethodTiers.tiers.every(t => Number(t.standard_price) === 0 && Number(t.hard_floor_price) === 0), 'new method pricing tiers all start at $0 placeholder');
  console.log('  ok: new decoration method seeded with 500 $0 placeholder pricing-tier rows');

  const printLocationsResp = await (await fetch(`${BASE}/api/admin/print-locations?decorationMethodId=${newMethodId}`, { headers: { Cookie: cookie } })).json();
  const frontLoc = printLocationsResp.printLocations.find(l => l.code === 'front' || l.name === 'Front');
  assert(frontLoc, 'Front print location exists');
  assert.strictEqual(frontLoc.pricing.length, 500, `new method seeded with 500 print-location-pricing rows for Front (got ${frontLoc.pricing.length})`);
  console.log('  ok: new decoration method seeded with 500 $0 placeholder print-location-pricing rows per location');

  // ---- 7) new (inactive) method is NOT in the public list ----
  const publicListAfterCreate = await (await fetch(`${BASE}/api/decoration-methods`)).json();
  assert(!publicListAfterCreate.decorationMethods.some(m => m.id === newMethodId), 'newly created (inactive) method does not appear in the public list');
  console.log('  ok: newly created method stays hidden from customers until activated');

  // ---- 8) pricing-tiers requires decorationMethodId ----
  const noMethodResp = await fetch(`${BASE}/api/admin/pricing-tiers`, { headers: { Cookie: cookie } });
  assert.strictEqual(noMethodResp.status, 400, 'GET pricing-tiers without decorationMethodId is rejected');
  console.log('  ok: admin pricing-tiers route requires decorationMethodId');

  // ---- 9) bulk-fill pricing-tiers for the new method ----
  const bulkFillResp = await fetch(`${BASE}/api/admin/pricing-tiers/bulk-fill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ decorationMethodId: newMethodId, fromQty: 1, toQty: 500, standardPrice: 15, hardFloorPrice: 12 }),
  });
  const bulkFillBody = await bulkFillResp.json();
  assert(bulkFillResp.ok && bulkFillBody.rowsUpdated === 500, `bulk-fill pricing-tiers updates all 500 rows (got ${bulkFillBody.rowsUpdated})`);
  const tiersAfterBulk = await (await fetch(`${BASE}/api/admin/pricing-tiers?decorationMethodId=${newMethodId}`, { headers: { Cookie: cookie } })).json();
  assert(tiersAfterBulk.tiers.every(t => Number(t.standard_price) === 15 && Number(t.hard_floor_price) === 12), 'bulk-filled pricing tiers all show the new exact price');
  const qty500Row = tiersAfterBulk.tiers.find(t => t.quantity === 500);
  const qty1Row = tiersAfterBulk.tiers.find(t => t.quantity === 1);
  assert(qty500Row && qty1Row, 'both qty=1 and qty=500 rows exist after bulk-fill');
  console.log('  ok: bulk-fill pricing-tiers route sets exact per-unit price across the full 1-500 range in one call');

  // ---- 10) bulk-fill print-location pricing for the new method ----
  const bulkFillLocResp = await fetch(`${BASE}/api/admin/print-locations/${frontLoc.id}/pricing/bulk-fill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ decorationMethodId: newMethodId, fromQty: 1, toQty: 500, addonPrice: 3.5 }),
  });
  const bulkFillLocBody = await bulkFillLocResp.json();
  assert(bulkFillLocResp.ok && bulkFillLocBody.rowsUpdated === 500, `bulk-fill print-location pricing updates all 500 rows (got ${bulkFillLocBody.rowsUpdated})`);
  console.log('  ok: bulk-fill print-location pricing route sets exact addon price across the full 1-500 range in one call');

  // ---- 11) activate the new method, then it appears publicly and prices correctly ----
  const activateResp = await fetch(`${BASE}/api/admin/decoration-methods/${newMethodId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ active: true }),
  });
  assert(activateResp.ok, 'activating the new decoration method succeeds');
  const publicListAfterActivate = await (await fetch(`${BASE}/api/decoration-methods`)).json();
  assert(publicListAfterActivate.decorationMethods.some(m => m.id === newMethodId), 'activated method now appears in the public list');
  console.log('  ok: activated method becomes visible/orderable to customers');

  const activatedEstimate = await (await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, decorationMethodId: newMethodId,
      colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 24 }] }],
      printLocationIds: [],
    }),
  })).json();
  assert.strictEqual(activatedEstimate.estimate.total, 15 * 24, `activated method prices correctly at the bulk-filled $15/unit (got $${activatedEstimate.estimate.total})`);
  assert.strictEqual(activatedEstimate.estimate.garment.id, tee.id, 'estimate still returns correct garment');
  console.log(`  ok: newly activated + priced method quotes correctly ($${activatedEstimate.estimate.total} for 24 @ $15)`);

  // deactivate again so it doesn't linger as a live sellable method after the test
  await fetch(`${BASE}/api/admin/decoration-methods/${newMethodId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ active: false }),
  });

  // ---- 12) qty cap: 500 allowed, 501 requires a bulk quote ----
  const qty500Resp = await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, decorationMethodId: dtf.id,
      colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 500 }] }],
      printLocationIds: [],
    }),
  });
  const qty500Body = await qty500Resp.json();
  assert(qty500Resp.ok && qty500Body.estimate, `qty=500 is priced normally (got: ${JSON.stringify(qty500Body)})`);
  console.log(`  ok: qty=500 (the new max) prices normally — $${qty500Body.estimate.total}`);

  const qty501Resp = await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, decorationMethodId: dtf.id,
      colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 501 }] }],
      printLocationIds: [],
    }),
  });
  const qty501Body = await qty501Resp.json();
  assert(qty501Body.bulkQuoteRequired, `qty=501 (over the cap) is blocked and flagged as needing a bulk quote (got: ${JSON.stringify(qty501Body)})`);
  console.log('  ok: qty=501 (over the new 500 cap) is still correctly blocked as a bulk-quote case');

  // ---- 13) legacy fallback: omitting decorationMethodId defaults to the lowest-sort-order active method ----
  const legacyResp = await (await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, // no decorationMethodId at all — simulates a pre-feature client/snapshot
      colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 24 }] }],
      printLocationIds: [],
    }),
  })).json();
  assert.strictEqual(legacyResp.estimate.decorationMethod.code, 'dtf', 'omitting decorationMethodId falls back to DTF (the lowest-sort-order active method)');
  console.log('  ok: legacy requests with no decorationMethodId still resolve correctly (fallback to DTF)');

  // ---- 14) a real quote freezes its decoration method in the snapshot ----
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const quoteResp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, decorationMethodId: dtf.id,
      colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 24 }] }],
      printLocationIds: [], draftToken: draftTokenResp.draftToken,
      firstName: 'Method', lastName: 'Test', email: `method.test.${Date.now()}@example.com`, phone: '555-222-1111',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(quoteResp.ok, 'quote generation with decorationMethodId succeeds');
  const { quoteCode } = await quoteResp.json();
  const quoteDetail = await (await fetch(`${BASE}/api/admin/quotes/${quoteCode}`, { headers: { Cookie: cookie } })).json();
  assert.strictEqual(quoteDetail.quote.decoration_method_name, 'DTF', 'quote row freezes decoration_method_name at generation time');
  assert.strictEqual(quoteDetail.pricing?.decorationMethod?.code, 'dtf', 'quote pricing snapshot freezes the decoration method used at generation time');
  console.log(`  ok: generated quote ${quoteCode} freezes decoration method "dtf" in both the quote row and pricing snapshot`);

  console.log('\n=== ALL DECORATION METHOD CHECKS PASSED ===');
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
