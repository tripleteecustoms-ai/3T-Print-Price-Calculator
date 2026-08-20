// Focused check for the customer-builder layout editor (Settings > Layout):
// admin auth on the step-order routes, server-side permutation validation
// (missing/duplicate/unknown-key/wrong-length/non-array all rejected),
// persistence + round-trip via /api/business-info, backward-compatible
// fallback to the default order when no step_order setting exists yet, and
// that quote creation itself is completely unaffected by step order (the
// pricing engine never depended on it).
const assert = require('assert');

const BASE = 'http://localhost:4790';
const DEFAULT_ORDER = ['garment', 'color', 'sizes', 'locations', 'artwork', 'contact'];

async function login() {
  const resp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  return resp.headers.get('set-cookie');
}

async function main() {
  console.log('=== LAYOUT / STEP ORDER ===');
  const cookie = await login();

  // ---- 0) admin auth required ----
  const unauthGet = await fetch(`${BASE}/api/admin/settings/step-order`);
  assert.strictEqual(unauthGet.status, 401, 'GET step-order requires admin auth');
  const unauthPut = await fetch(`${BASE}/api/admin/settings/step-order`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepOrder: DEFAULT_ORDER }),
  });
  assert.strictEqual(unauthPut.status, 401, 'PUT step-order requires admin auth');
  console.log('  ok: step-order routes require admin auth');

  // ---- 1) fresh install defaults to the canonical order ----
  const initial = await (await fetch(`${BASE}/api/admin/settings/step-order`, { headers: { Cookie: cookie } })).json();
  assert.deepStrictEqual(initial.stepOrder, DEFAULT_ORDER, 'fresh install starts with the default step order');
  assert.deepStrictEqual(initial.defaultOrder, DEFAULT_ORDER, 'defaultOrder is exposed for a "Reset" action');
  assert(initial.stepLabels && initial.stepLabels.garment, 'stepLabels are included for the admin UI');
  console.log('  ok: fresh install defaults to garment -> color -> sizes -> locations -> artwork -> contact');

  // ---- 2) server-side validation rejects anything that isn't an exact permutation ----
  const badCases = [
    { stepOrder: ['garment', 'color', 'sizes', 'locations', 'artwork'], why: 'missing a step' },
    { stepOrder: ['garment', 'garment', 'sizes', 'locations', 'artwork', 'contact'], why: 'duplicate step' },
    { stepOrder: ['garment', 'color', 'sizes', 'locations', 'artwork', 'bogus'], why: 'unknown step key' },
    { stepOrder: ['garment', 'color', 'sizes', 'locations', 'artwork', 'contact', 'extra'], why: 'too many entries' },
    { stepOrder: 'garment,color,sizes,locations,artwork,contact', why: 'not an array' },
    { stepOrder: null, why: 'missing entirely' },
  ];
  for (const { stepOrder, why } of badCases) {
    const resp = await fetch(`${BASE}/api/admin/settings/step-order`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ stepOrder }),
    });
    assert.strictEqual(resp.status, 400, `rejects invalid step order (${why})`);
  }
  console.log('  ok: invalid step orders are rejected (missing/duplicate/unknown/extra/non-array/absent)');

  // ---- 3) a valid custom permutation saves and round-trips ----
  const custom = ['contact', 'artwork', 'garment', 'locations', 'color', 'sizes'];
  const saveResp = await fetch(`${BASE}/api/admin/settings/step-order`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ stepOrder: custom }),
  });
  assert(saveResp.ok, 'saving a valid custom order succeeds');
  const reGet = await (await fetch(`${BASE}/api/admin/settings/step-order`, { headers: { Cookie: cookie } })).json();
  assert.deepStrictEqual(reGet.stepOrder, custom, 'custom order persists and round-trips via GET');
  console.log('  ok: a valid custom permutation saves and round-trips correctly');

  // ---- 4) the public /api/business-info reflects the saved custom order ----
  const info = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.deepStrictEqual(info.stepOrder, custom, 'customer-facing business-info reflects the admin-saved order');
  console.log('  ok: /api/business-info exposes the current step order to the customer builder');

  // ---- 5) quote creation is completely unaffected by step order (pricing/validation never depended on it) ----
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const quoteResp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 2 }] }],
      printLocationIds: [], draftToken: draftTokenResp.draftToken,
      firstName: 'Lay', lastName: 'Out', email: `lay.out.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`, phone: '555-777-8888',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(quoteResp.ok, 'quote creation still succeeds with a fully custom (non-default) step order in effect');
  console.log('  ok: quote creation/pricing is unaffected by the customer builder step order (server never used it)');

  // ---- 6) resetting to the default order works and round-trips ----
  const resetResp = await fetch(`${BASE}/api/admin/settings/step-order`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ stepOrder: DEFAULT_ORDER }),
  });
  assert(resetResp.ok, 'resetting to the default order succeeds');
  const afterReset = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.deepStrictEqual(afterReset.stepOrder, DEFAULT_ORDER, 'business-info reflects the reset default order');
  console.log('  ok: resetting to the default order works and is reflected immediately');

  console.log('=== LAYOUT / STEP ORDER: ALL CHECKS PASSED ===');
}

main().catch(err => {
  console.error('LAYOUT TEST FAILED:', err);
  process.exit(1);
});
