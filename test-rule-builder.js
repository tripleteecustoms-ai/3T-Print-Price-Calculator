// Focused test for Task #26: the admin Rule Builder — a guided overview of
// every decoration method's pricing/fees in plain English, jump-to-editor
// buttons, and a price tester that calls the real public /api/estimate
// pricing code path (so "what would this cost?" can never drift from what a
// customer actually gets charged).
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function main() {
  console.log('=== ADMIN RULE BUILDER ===');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });

  await page.goto(`${BASE}/admin/login.html`);
  await page.fill('#username', 'admin');
  await page.fill('#password', '3tprint-admin-2026');
  await page.click('#loginBtn');
  await page.waitForSelector('.admin-nav-item[data-panel="dashboard"]');

  await page.click('[data-panel="rulebuilder"]');
  await page.waitForSelector('#ruleBuilderMethodCards [data-rb-method-id]');

  // ---- 1) every decoration method gets a summary card with a plain-English price range ----
  const cardCount = await page.locator('#ruleBuilderMethodCards [data-rb-method-id]').count();
  assert(cardCount >= 4, `Rule Builder shows a summary card per decoration method (found ${cardCount})`);
  const dtfCard = page.locator('#ruleBuilderMethodCards [data-rb-method-id]').first();
  const dtfCardText = await dtfCard.textContent();
  assert(/\$20\.00/.test(dtfCardText) || /1pc/.test(dtfCardText), `DTF's card shows real base-price figures (got: ${dtfCardText.slice(0, 200)})`);
  assert(/Active/.test(dtfCardText), 'DTF card is labeled Active');
  console.log(`  ok: Rule Builder shows ${cardCount} decoration-method cards with plain-English pricing summaries`);

  // ---- 2) "Edit Base Pricing" jumps to the Pricing tab, pre-scoped to that method ----
  await dtfCard.locator('.jump-pricing-btn').click();
  await page.waitForSelector('.admin-panel[data-panel="pricing"].active');
  await page.waitForSelector('#pricingTable tr[data-qty="24"]');
  const selectedMethodName = await page.locator('#pricingMethodSelect option:checked').textContent();
  assert.strictEqual(selectedMethodName, 'DTF', `Edit Base Pricing jumps to the Pricing tab pre-scoped to DTF (got "${selectedMethodName}")`);
  console.log('  ok: "Edit Base Pricing" jumps to the Pricing tab with the correct method pre-selected');

  // ---- 3) "Edit Location Pricing" jumps to the Print Locations tab, pre-scoped to that method ----
  await page.click('[data-panel="rulebuilder"]');
  await page.waitForSelector('#ruleBuilderMethodCards [data-rb-method-id]');
  await page.locator('#ruleBuilderMethodCards [data-rb-method-id]').first().locator('.jump-locations-btn').click();
  await page.waitForSelector('.admin-panel[data-panel="locations"].active');
  await page.waitForSelector('#locationsList [data-loc-id]');
  const selectedLocMethodName = await page.locator('#locationsMethodSelect option:checked').textContent();
  assert.strictEqual(selectedLocMethodName, 'DTF', `Edit Location Pricing jumps to the Locations tab pre-scoped to DTF (got "${selectedLocMethodName}")`);
  console.log('  ok: "Edit Location Pricing" jumps to the Print Locations tab with the correct method pre-selected');

  // ---- 4) price tester matches the real /api/estimate calculation ----
  await page.click('[data-panel="rulebuilder"]');
  await page.waitForSelector('#testerMethodSelect');
  await page.selectOption('#testerMethodSelect', { label: 'DTF' });
  await page.fill('#testerQty', '24');
  await page.selectOption('#testerBackAddon', 'no');
  await page.selectOption('#testerRush', 'no');
  await page.click('#runTesterBtn');
  await page.waitForSelector('#testerResult table', { timeout: 8000 });
  const testerText = await page.locator('#testerResult').textContent();
  assert(/\$480\.00/.test(testerText), `price tester for 24pc DTF/no-addon/no-rush shows the correct $480.00 total (got: ${testerText})`);
  console.log('  ok: price tester (24pc, DTF, no addons, no rush) correctly shows $480.00 — matches the real customer-facing calculation');

  // ---- 5) price tester with rush requested shows the rush fee ----
  await page.selectOption('#testerRush', 'yes');
  await page.click('#runTesterBtn');
  await page.waitForSelector('#testerResult table');
  const rushTesterText = await page.locator('#testerResult').textContent();
  assert(/Rush Production Fee/i.test(rushTesterText), 'price tester with rush requested shows the Rush Production Fee line');
  assert(/\$600\.00/.test(rushTesterText), `price tester with rush shows the correct $600.00 total (got: ${rushTesterText})`);
  console.log('  ok: price tester correctly reflects the rush fee when toggled on');

  await browser.close();
  console.log('\n=== ALL RULE BUILDER CHECKS PASSED ===');
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
