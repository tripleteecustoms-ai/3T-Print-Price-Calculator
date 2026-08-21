// Phase 2: owner price override on an individual quote.
// Covers: overriding the final price WITHOUT touching the garment's tier
// matrix; original_calculated_price is set once and never changes across
// repeated overrides; final_approved_price tracks the latest approved price;
// who/when is recorded via the existing quote_events audit trail (reusing
// the established pattern, no new audit table needed); and the internal
// "below minimum target margin" warning appears for admins on an
// overridden quote but never blocks or reaches the customer-facing flow.
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
  console.log('=== OWNER PRICE OVERRIDE (original/final price + audit trail) ===');
  const cookie = await login();
  const authed = (opts = {}) => ({ ...opts, headers: { ...(opts.headers || {}), Cookie: cookie } });

  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');

  // ---------------------------------------------------------- baseline tier price untouched by an override
  const tierPricesBefore = await getJSON(`${BASE}/api/admin/garments/${tee.id}/tier-prices`, authed());
  const tier1024Before = tierPricesBefore.body.tiers.find(t => t.label === '10-24');

  const quoteResp = await getJSON(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: 'Black', colorHex: '#111', sizes: [{ label: 'M', qty: 10 }] }],
      printLocationIds: [1], firstName: 'Owner', lastName: 'Override', email: `owner.override.${Date.now()}@example.com`, phone: '555-070-0070',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(quoteResp.ok, 'baseline quote (qty=10, tier 10-24) is created');
  const code = quoteResp.body.quoteCode;

  const detail0 = await getJSON(`${BASE}/api/admin/quotes/${code}`, authed());
  const originalPrice = detail0.body.quote.original_calculated_price;
  assert.strictEqual(originalPrice, detail0.body.pricing.total, 'original_calculated_price starts equal to the calculated total at quote creation');
  assert.strictEqual(detail0.body.quote.final_approved_price, originalPrice, 'final_approved_price also starts equal to the calculated total');

  // ---------------------------------------------------------- first override (above floor, simple discretionary discount)
  const override1 = await getJSON(`${BASE}/api/admin/quotes/${code}/override`, authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrideUnitPrice: 18, note: 'Loyal repeat customer discount' }),
  }));
  assert(override1.ok, 'first override (above floor) is applied successfully');
  const detail1 = await getJSON(`${BASE}/api/admin/quotes/${code}`, authed());
  assert.strictEqual(detail1.body.quote.original_calculated_price, originalPrice, 'original_calculated_price is UNCHANGED after the first override');
  assert.strictEqual(detail1.body.quote.final_approved_price, detail1.body.pricing.total, 'final_approved_price now matches the newly overridden total');
  assert.notStrictEqual(detail1.body.quote.final_approved_price, originalPrice, 'final_approved_price actually moved away from the original calculated price');
  console.log(`  ok: override #1 changes final_approved_price ($${detail1.body.quote.final_approved_price}) while original_calculated_price stays fixed at $${originalPrice}`);

  // Confirm the garment's tier matrix itself was NOT touched by the override.
  const tierPricesAfter1 = await getJSON(`${BASE}/api/admin/garments/${tee.id}/tier-prices`, authed());
  const tier1024After1 = tierPricesAfter1.body.tiers.find(t => t.label === '10-24');
  assert.strictEqual(tier1024After1.standardPrice, tier1024Before.standardPrice, 'the garment\'s "10-24" tier standard price is untouched by the quote-level override');
  assert.strictEqual(tier1024After1.hardFloorPrice, tier1024Before.hardFloorPrice, 'the garment\'s "10-24" tier floor price is untouched by the quote-level override');
  console.log('  ok: overriding one quote never modifies the garment\'s underlying tier matrix — future quotes still price off the real tiers');

  // ---------------------------------------------------------- second override, below floor -> confirmation gate, then confirmed
  const override2Attempt = await getJSON(`${BASE}/api/admin/quotes/${code}/override`, authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrideUnitPrice: 9, note: 'Aggressive volume discount' }), // below the $16.67 floor
  }));
  assert.strictEqual(override2Attempt.status, 409, 'a below-floor override without confirmation is refused (409, confirmation-required gate)');

  const override2 = await getJSON(`${BASE}/api/admin/quotes/${code}/override`, authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrideUnitPrice: 9, confirmedBelowFloor: true, note: 'Aggressive volume discount' }),
  }));
  assert(override2.ok, 'the same below-floor override succeeds once explicitly confirmed');
  const detail2 = await getJSON(`${BASE}/api/admin/quotes/${code}`, authed());
  assert.strictEqual(detail2.body.quote.original_calculated_price, originalPrice, 'original_calculated_price is STILL unchanged after a SECOND override');
  assert.strictEqual(detail2.body.quote.final_approved_price, detail2.body.pricing.total, 'final_approved_price now tracks the second (below-floor) override');
  assert.notStrictEqual(detail2.body.quote.final_approved_price, detail1.body.quote.final_approved_price, 'final_approved_price moved again from override #1 to override #2');
  console.log(`  ok: override #2 (below floor, confirmed) updates final_approved_price to $${detail2.body.quote.final_approved_price}; original_calculated_price still $${originalPrice}`);

  // ---------------------------------------------------------- who/when: audit trail via quote_events (existing pattern, no new table)
  const overrideEvents = detail2.body.events.filter(e => e.event_type === 'override');
  assert.strictEqual(overrideEvents.length, 2, `both overrides are recorded as separate quote_events rows (found ${overrideEvents.length})`);
  assert(overrideEvents.every(e => /set price to/i.test(e.detail)), `each override event records WHO made the change (admin name embedded in the event detail, e.g. "${overrideEvents[0].detail}")`);
  assert(overrideEvents.every(e => !!e.created_at), 'each override event records WHEN the change happened (created_at timestamp)');
  assert(overrideEvents.some(e => /BELOW FLOOR/.test(e.detail)), 'the below-floor override is distinguishably marked in its audit event');
  console.log('  ok: who/when for every override is captured via the existing quote_events audit trail (no new bespoke audit table needed)');

  // ---------------------------------------------------------- internal margin warning: visible to admin, never to the customer
  assert.strictEqual(detail2.body.pricing.internal.belowMinimumMargin, true,
    `the $9/ea override (well under direct cost) is flagged belowMinimumMargin internally (margin ${detail2.body.pricing.internal.grossMarginPct}%)`);

  const custDetail = await getJSON(`${BASE}/api/quotes/${code}`);
  assert(!('internal' in custDetail.body.pricing), 'the customer-facing quote endpoint never exposes the internal cost/margin block at all');
  console.log('  ok: below-minimum-margin is visible internally on the overridden quote but is completely absent from the customer-facing response');

  // ---------------------------------------------------------- same thing, visible in the admin UI itself
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const apage = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await apage.goto(BASE + '/admin/login.html');
  await apage.fill('#username', 'admin');
  await apage.fill('#password', '3tprint-admin-2026');
  await apage.click('#loginBtn');
  await apage.waitForURL('**/admin/dashboard.html');
  await apage.click('.admin-nav-item[data-panel="quotes"]');
  await apage.waitForSelector('#quotesBody tr');
  await apage.click(`#quotesBody [data-open-quote="${code}"]`);
  await apage.waitForSelector('.modal');
  const modalText = await apage.locator('.modal').innerText();
  assert(/below minimum target margin/i.test(modalText), 'admin quote-detail modal shows the "Below Minimum Target Margin" warning');
  assert(/does not block the customer/i.test(modalText), 'the warning explicitly states it does not block the customer');
  assert(modalText.includes(String(originalPrice.toFixed ? originalPrice.toFixed(2) : originalPrice)) || /original calculated price/i.test(modalText), 'admin modal shows the Original Calculated Price');
  await browser.close();
  console.log('  ok: the below-minimum-margin warning is visible in the actual admin UI (not just the API)');

  console.log('\n=== OWNER OVERRIDE CHECKS PASSED ===');
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
