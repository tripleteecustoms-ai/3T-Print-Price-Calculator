// Sept 2026 price tables: checks the live /api/estimate against Trey's
// shirt table and add-on print table (server/pricingTables.js), through the
// real server-authoritative pricing path. Runs against a server on :4790.
const assert = require('assert');
const {
  SHIRT_PRICES, ADDON_PRICES, shirtPriceForQty, addonPriceForQty, garmentListPrice, buildTierDefs,
} = require('./server/pricingTables');

const BASE = 'http://localhost:4790';

async function getJSON(path, opts) {
  const resp = await fetch(BASE + path, opts);
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

function sizesFor(totalQty) {
  const labels = ['S', 'M', 'L', 'XL'];
  const sizes = [];
  let remaining = totalQty, i = 0;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 3000);
    sizes.push({ label: labels[i++ % labels.length], qty: chunk });
    remaining -= chunk;
  }
  return sizes;
}

async function main() {
  console.log('=== PRICE TABLES (Sept 2026) ===');
  const { body: { garments } } = await getJSON('/api/garments');
  const { body: { printLocations } } = await getJSON('/api/print-locations');
  const loc = Object.fromEntries(printLocations.map(l => [l.code, l.id]));
  const byName = (re) => garments.find(g => re.test(g.name));
  const tee = byName(/Standard Quality/);

  async function estimate(garment, qty, codes) {
    const sizes = garment.sizes.some(s => s.label === 'S') ? sizesFor(qty) : [{ label: garment.sizes[0].label, qty }];
    const r = await getJSON('/api/estimate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ garmentId: garment.id, colorSelections: [{ colorName: 'Black', sizes }], printLocationIds: codes.map(c => loc[c]) }),
    });
    return r;
  }

  // ---- tier layout ----
  const { body: { tiers } } = await getJSON('/api/quantity-tiers');
  const defs = buildTierDefs();
  assert.strictEqual(tiers.length, defs.length, `tier count is ${defs.length} (union of both tables)`);
  assert.strictEqual(tiers[0].minQty, 1);
  assert.strictEqual(tiers[tiers.length - 1].maxQty, 10000);
  for (let i = 1; i < tiers.length; i++) assert.strictEqual(tiers[i].minQty, tiers[i - 1].maxQty + 1, `tiers are contiguous at ${tiers[i].minQty}`);
  console.log(`  ok: ${tiers.length} contiguous tiers covering 1-10,000`);

  // ---- Trey's spot checks ----
  let r = await estimate(tee, 1, ['front']);
  assert.strictEqual(r.body.estimate.subtotal, 35.00, '1 tee front only = $35.00');
  r = await estimate(tee, 24, ['front', 'back']);
  assert.strictEqual(r.body.estimate.finalBaseUnit, 19.50); assert.strictEqual(r.body.estimate.addonLines[0].each, 5.00);
  assert.strictEqual(r.body.estimate.subtotal, 588.00, '24 tees front+back = $588.00');
  r = await estimate(tee, 100, ['front', 'back']);
  assert.strictEqual(r.body.estimate.finalBaseUnit, 14.25); assert.strictEqual(r.body.estimate.addonLines[0].each, 4.50);
  assert.strictEqual(r.body.estimate.subtotal, 1875.00, '100 tees front+back = $1,875.00');
  r = await estimate(tee, 16, ['front', 'left_chest']);
  assert.strictEqual(r.body.estimate.finalBaseUnit, 21.00); assert.strictEqual(r.body.estimate.addonLines[0].each, 3.05);
  console.log('  ok: spot checks ($35.00 | $588.00 | $1,875.00 | $21.00 + $3.05)');

  // ---- every breakpoint (and the qty just below it) in both tables ----
  const qtys = new Set();
  for (const [q] of [...SHIRT_PRICES, ...ADDON_PRICES]) { qtys.add(q); if (q > 1) qtys.add(q - 1); }
  qtys.add(10000);
  for (const q of [...qtys].sort((a, b) => a - b)) {
    r = await estimate(tee, q, ['front', 'back', 'left_chest', 'left_sleeve', 'upper_back']);
    assert.strictEqual(r.status, 200, `qty ${q}: ${JSON.stringify(r.body)}`);
    const e = r.body.estimate;
    assert.strictEqual(e.finalBaseUnit, shirtPriceForQty(q), `qty ${q} shirt price`);
    const each = Object.fromEntries(e.addonLines.map(a => [a.name, a.each]));
    assert.strictEqual(each['Back'], addonPriceForQty('back', q), `qty ${q} back`);
    assert.strictEqual(each['Left Chest'], addonPriceForQty('chest', q), `qty ${q} chest`);
    assert.strictEqual(each['Left Sleeve'], addonPriceForQty('sleeve', q), `qty ${q} sleeve`);
    assert.strictEqual(each['Upper Back'], addonPriceForQty('sleeve', q), `qty ${q} upper back uses the sleeve column`);
  }
  console.log(`  ok: ${qtys.size} breakpoint quantities match the shirt table and all add-on columns exactly`);

  // ---- other garments ----
  const hoodie = byName(/^Hoodie$/);
  assert.strictEqual((await estimate(hoodie, 1, ['front'])).body.estimate.finalBaseUnit, 47.00, 'Hoodie at 1 = $47');
  assert.strictEqual((await estimate(hoodie, 1000, ['front'])).body.estimate.finalBaseUnit, 22.00, 'Hoodie at 1,000 = $22');
  const hat = byName(/Hat/), tote = byName(/Tote/);
  assert.strictEqual((await estimate(hat, 1, ['front'])).body.estimate.finalBaseUnit, 27.00, 'Hat at 1 = $27');
  assert.strictEqual((await estimate(hat, 1000, ['front'])).body.estimate.finalBaseUnit, garmentListPrice(-8, 1000), 'Hat scales by ratio');
  assert.strictEqual((await estimate(tote, 1000, ['front'])).body.estimate.finalBaseUnit, garmentListPrice(-10, 1000), 'Tote scales by ratio');
  assert.ok(garmentListPrice(-10, 1000) > 7, 'Tote never drops near $0');
  console.log(`  ok: Hoodie $47/$22; Hat $27 at 1, $${garmentListPrice(-8, 1000)} at 1,000; Tote $${garmentListPrice(-10, 1000)} at 1,000`);

  // ---- floor, review, cap ----
  const login = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const { body: tp } = await getJSON(`/api/admin/garments/${tee.id}/tier-prices`, { headers: { cookie } });
  for (const t of tp.tiers) {
    assert.strictEqual(t.standardPrice, shirtPriceForQty(t.minQty), `tier ${t.label} list price`);
    assert.strictEqual(t.hardFloorPrice, Math.round(t.standardPrice * 0.85 * 100) / 100, `tier ${t.label} floor = 85% of list`);
    assert.strictEqual(t.isEstimatedPrice, false, `tier ${t.label} is a real price, not a placeholder`);
  }
  assert.strictEqual((await estimate(tee, 999, ['front'])).body.estimate.quantityTier.checkoutBehavior, 'immediate', '999 = instant checkout');
  assert.strictEqual((await estimate(tee, 1000, ['front'])).body.estimate.quantityTier.checkoutBehavior, 'review', '1,000 = review');
  assert.strictEqual((await estimate(tee, 10001, ['front'])).status, 400, '10,001 rejected');
  console.log('  ok: floor is 85% of list; 999 instant checkout; 1,000+ review; 10,001 rejected');

  console.log('\n=== PRICE TABLE CHECKS PASSED ===');
}

main().catch(err => { console.error('PRICE TABLE TEST FAILED:', err); process.exit(1); });
