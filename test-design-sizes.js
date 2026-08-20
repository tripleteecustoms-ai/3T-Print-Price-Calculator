// Focused check for the "design dimensions" pricing feature:
//   Under Artwork, the customer picks a design size per print location —
//   Standard (no charge), Large Graphic (+$1.50/shirt), Oversized (+$2.50/shirt).
// This must be enforced server-side (pricingEngine.js), persisted per print
// location on the quote (quote_print_locations.design_size), survive
// checkout/recalculate re-derivation from the DB, and be admin-editable via
// settings (design_size_large_surcharge / design_size_oversized_surcharge).
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function main() {
  console.log('=== DESIGN DIMENSIONS PRICING ===');

  const db = require('./server/db');
  await db.ready;

  // ---- 0) migration actually added the columns (schema sanity check) ----
  const cols = db.prepare("PRAGMA table_info(quote_print_locations)").all().map(c => c.name);
  assert(cols.includes('design_size'), 'quote_print_locations has a design_size column');
  assert(cols.includes('design_size_surcharge_each'), 'quote_print_locations has a design_size_surcharge_each column');
  console.log('  ok: schema migration added the design-size columns');

  // ---- 1) business-info exposes the current surcharge amounts ----
  const info = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.strictEqual(info.designSizeSurcharges.large, 1.5, 'default large surcharge is $1.50');
  assert.strictEqual(info.designSizeSurcharges.oversized, 2.5, 'default oversized surcharge is $2.50');
  console.log('  ok: /business-info exposes the design-size surcharge amounts');

  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const { printLocations } = await (await fetch(`${BASE}/api/print-locations?qty=12`)).json();
  const front = printLocations.find(l => l.code === 'front');
  const back = printLocations.find(l => l.code === 'back');

  // ---- 2) estimate: standard size on Front adds nothing extra ----
  const estStandard = await (await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 12 }] }],
      printLocationIds: [{ id: front.id, designSize: 'standard' }],
    }),
  })).json();
  assert.strictEqual(estStandard.estimate.designSizeSurchargeTotal, 0, 'standard design size adds no surcharge');
  console.log('  ok: Standard design size adds $0');

  // ---- 3) estimate: Large Graphic on Front adds $1.50 × qty ----
  const estLarge = await (await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 12 }] }],
      printLocationIds: [{ id: front.id, designSize: 'large' }],
    }),
  })).json();
  assert.strictEqual(estLarge.estimate.designSizeSurchargeTotal, 18, 'Large Graphic on Front adds $1.50 × 12 = $18.00');
  assert.strictEqual(estLarge.estimate.total, estStandard.estimate.total + 18, 'total reflects the Large Graphic surcharge');
  console.log('  ok: Large Graphic (+$1.50/shirt) surcharge calculated correctly');

  // ---- 4) estimate: Oversized on Front + Back (multi-location) stacks correctly ----
  const estStacked = await (await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 12 }] }],
      printLocationIds: [{ id: front.id, designSize: 'oversized' }, { id: back.id, designSize: 'large' }],
    }),
  })).json();
  // Front oversized: 2.50*12=30, Back large: 1.50*12=18 -> 48 total design surcharge
  assert.strictEqual(estStacked.estimate.designSizeSurchargeTotal, 48, `Front Oversized + Back Large stack to $48 (got ${estStacked.estimate.designSizeSurchargeTotal})`);
  console.log('  ok: design-size surcharges stack correctly across multiple print locations');

  // ---- 5) invalid design size is rejected server-side ----
  const badResp = await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 12 }] }],
      printLocationIds: [{ id: front.id, designSize: 'giant' }],
    }),
  });
  assert.strictEqual(badResp.status, 400, 'an unrecognized design size value is rejected (400)');
  console.log('  ok: unrecognized design size values are rejected server-side');

  // ---- 6) a client can never just claim a surcharge amount — only IDs/sizes are trusted ----
  // (implicit in the above: the client sends designSize strings, never dollar amounts)

  // ---- 7) full quote creation persists design_size + surcharge per location, and survives checkout recompute ----
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const createResp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 12 }] }],
      printLocationIds: [{ id: front.id, designSize: 'large' }],
      draftToken: draftTokenResp.draftToken,
      firstName: 'Design', lastName: 'Sizer', email: 'design.sizer@example.com', phone: '555-222-3333',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(createResp.ok, 'quote creation with a Large Graphic design size succeeds');
  const { quoteCode } = await createResp.json();

  // Read back through the live HTTP API (not a direct DB read) — this test
  // script and the running server are separate processes with their own
  // in-memory sql.js instances, so only the server's own view of the data
  // (via its API) is guaranteed to reflect writes made through its API.
  const quoteDetail = await (await fetch(`${BASE}/api/quotes/${quoteCode}`)).json();
  const storedLoc = quoteDetail.printLocations[0];
  assert.strictEqual(storedLoc.design_size, 'large', 'the quote_print_locations row persists design_size="large"');
  assert.strictEqual(storedLoc.design_size_surcharge_each, 1.5, 'the quote_print_locations row persists the $1.50 per-shirt surcharge');
  assert.strictEqual(quoteDetail.pricing.total, estLarge.estimate.total, 'stored quote total matches the earlier Large-Graphic estimate for the same config');
  console.log('  ok: quote creation persists design_size and its surcharge per print location');

  // Confirm checkout-time recalculation (re-derives printLocationIds from the DB
  // row, not from anything the client resubmits) still includes the surcharge.
  const checkoutResp = await fetch(`${BASE}/api/quotes/${quoteCode}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true }),
  });
  assert(checkoutResp.ok, 'checkout succeeds');
  const afterCheckout = await (await fetch(`${BASE}/api/quotes/${quoteCode}`)).json();
  assert.strictEqual(afterCheckout.pricing.total, estLarge.estimate.total, 'checkout-time recalculation still includes the Large Graphic surcharge (re-derived from the stored design_size, not client input)');
  console.log('  ok: design-size surcharge survives server-side checkout recalculation');

  console.log('\n=== DESIGN DIMENSIONS PRICING CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
