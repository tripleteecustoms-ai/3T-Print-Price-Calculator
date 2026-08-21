// Focused test for Task #23: the turnaround-time / rush-fee disclaimer
// (editable policy text, linked from the builder) and the customer-facing
// rush-production checkbox that actually changes the price. Covers both the
// API-level policies CMS (public vs admin-only policies, editing, 404s) and
// a real browser pass through the order builder + quote page to prove the
// rush checkbox affects the live estimate, survives into the generated
// quote, and shows up as a line item on the quote page.
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');

const BASE = 'http://localhost:4790';

async function adminLogin() {
  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  assert(loginResp.ok, 'admin login succeeds');
  return loginResp.headers.get('set-cookie');
}

async function setQty(page, colorBlockIndex, sizeLabel, qty) {
  const block = page.locator('.color-block').nth(colorBlockIndex);
  const stepper = block.locator(`.qty-stepper[data-size="${sizeLabel}"] input`);
  await stepper.fill(String(qty));
  await stepper.dispatchEvent('change');
}

async function main() {
  console.log('=== TURNAROUND RULES + RUSH FEE ===');
  const cookie = await adminLogin();

  // ---- 1) public policies list excludes production_rules ----
  const publicPolicies = await (await fetch(`${BASE}/api/policies`)).json();
  const keys = publicPolicies.policies.map(p => p.key);
  assert(keys.includes('turnaround_rules'), 'public policy list includes turnaround_rules');
  assert(keys.includes('artwork_rules'), 'public policy list includes artwork_rules');
  assert(keys.includes('order_rules'), 'public policy list includes order_rules');
  assert(keys.includes('customer_rules'), 'public policy list includes customer_rules');
  assert(!keys.includes('production_rules'), 'public policy list does NOT include production_rules (internal-only)');
  console.log(`  ok: public policies list shows ${keys.length} customer-facing policies, correctly excludes production_rules`);

  // ---- 2) fetching an admin-only policy directly by key 404s for the public route ----
  const prodResp = await fetch(`${BASE}/api/policies/production_rules`);
  assert.strictEqual(prodResp.status, 404, 'requesting production_rules via the public route 404s');
  console.log('  ok: production_rules cannot be fetched through the public policy route, even by key');

  // ---- 3) turnaround_rules content is fetchable and non-empty ----
  const turnaround = (await (await fetch(`${BASE}/api/policies/turnaround_rules`)).json()).policy;
  assert(turnaround.title && turnaround.body && turnaround.body.length > 20, 'turnaround_rules has real starter content, not empty');
  assert(/rush/i.test(turnaround.body), 'turnaround_rules disclaimer mentions rush production');
  console.log('  ok: turnaround_rules policy has real starter disclaimer text mentioning rush production');

  // ---- 4) admin policy routes require auth ----
  const unauthResp = await fetch(`${BASE}/api/admin/policies`);
  assert.strictEqual(unauthResp.status, 401, 'admin policies route requires auth');
  console.log('  ok: admin policies route requires auth');

  // ---- 5) admin can edit a policy and the public route reflects it immediately ----
  const editResp = await fetch(`${BASE}/api/admin/policies/turnaround_rules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: 'Turnaround Time (edited)', body: 'Edited turnaround text for the test run.' }),
  });
  assert(editResp.ok, 'admin can edit a policy');
  const editedPublic = (await (await fetch(`${BASE}/api/policies/turnaround_rules`)).json()).policy;
  assert.strictEqual(editedPublic.title, 'Turnaround Time (edited)', 'edited policy title is immediately reflected on the public route');
  assert.strictEqual(editedPublic.body, 'Edited turnaround text for the test run.', 'edited policy body is immediately reflected on the public route');
  console.log('  ok: admin edits to a policy are immediately reflected on the public/customer-facing route');

  // ---- 6) global rush fee percent is exposed on /api/business-info ----
  const businessInfo = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.strictEqual(typeof businessInfo.rushFeePercent, 'number', 'business-info exposes the current rush fee percent');
  console.log(`  ok: /api/business-info exposes rushFeePercent (${businessInfo.rushFeePercent}%)`);

  // ==================================================================== BROWSER
  console.log('\n=== BROWSER: policy page + rush checkbox ===');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });

  // ---- policy.html renders the (still-edited) turnaround policy correctly ----
  await page.goto(`${BASE}/policy.html?key=turnaround_rules`);
  await page.waitForSelector('#policyTitle');
  const renderedTitle = await page.locator('#policyTitle').textContent();
  const renderedBody = await page.locator('#policyBody').textContent();
  assert.strictEqual(renderedTitle, 'Turnaround Time (edited)', `policy.html renders the edited title (got "${renderedTitle}")`);
  assert.strictEqual(renderedBody, 'Edited turnaround text for the test run.', `policy.html renders the edited body (got "${renderedBody}")`);
  console.log('  ok: policy.html correctly fetches and renders a policy by key');

  // ---- an unknown/admin-only key shows the not-found message, not a crash ----
  await page.goto(`${BASE}/policy.html?key=production_rules`);
  await page.waitForSelector('#policyError:not(.hidden)', { timeout: 5000 });
  console.log('  ok: policy.html shows a graceful not-found message for production_rules (admin-only), no crash');

  // revert the edited policy now that policy.html has been exercised against it
  await fetch(`${BASE}/api/admin/policies/turnaround_rules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: turnaround.title, body: turnaround.body }),
  });

  // ---- order builder: rush checkbox exists, links to the right policy, and changes the live price ----
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#firstName');
  await page.fill('#firstName', 'Rush');
  await page.fill('#lastName', 'Tester');
  await page.fill('#email', `rush.tester.${Date.now()}@example.com`);
  await page.fill('#phone', '555-999-0000');
  await page.click('#orderPurposeGroup [data-value="Special Event"]').catch(() => {});
  await page.click('.builder-step[data-step="contact"] [data-nav="next"]');
  await page.waitForSelector('#garmentGrid .option-card');
  await page.click('#garmentGrid .option-card');
  await page.waitForSelector('#colorGrid .color-swatch');
  await page.locator('#colorGrid .color-swatch').nth(0).click();
  await page.click('#colorNextBtn');
  await page.waitForSelector('.color-block');
  await setQty(page, 0, 'M', 24);
  await page.click('#sizesNextBtn');
  await page.click('#locationsNextBtn'); // front only (default selected)
  await page.waitForTimeout(400);

  await page.waitForSelector('#rushRequestedCheckbox');
  const policyLinkHref = await page.locator('.rush-option a').getAttribute('href');
  assert.strictEqual(policyLinkHref, '/policy.html?key=turnaround_rules', `rush option links to the turnaround_rules policy page (got "${policyLinkHref}")`);
  console.log('  ok: rush option is visible on the builder with a link to the turnaround/rush policy page');

  const totalBeforeRush = await page.locator('.summary-total .r').textContent();
  await page.check('#rushRequestedCheckbox');
  await page.waitForTimeout(500);
  const totalAfterRush = await page.locator('.summary-total .r').textContent();
  assert.notStrictEqual(totalBeforeRush, totalAfterRush, `checking Rush Production changes the live estimate total (before: ${totalBeforeRush}, after: ${totalAfterRush})`);
  const summaryText = await page.locator('#summaryBody').textContent();
  assert(/Rush Production Fee/i.test(summaryText), 'summary panel shows a "Rush Production Fee" line item once checked');
  console.log(`  ok: checking Rush Production live-updates the estimate (${totalBeforeRush} -> ${totalAfterRush}) and shows a fee line`);

  // ---- generate a real quote with rush checked; the quote page shows the fee line ----
  await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');
  await page.waitForSelector('#confirmationSummary .color-block');
  await page.click('#getPriceBtn');
  await page.waitForURL(/quote\.html/, { timeout: 10000 });
  await page.waitForSelector('.receipt-total', { timeout: 8000 });
  const receiptText = await page.locator('body').textContent();
  assert(/Rush Production Fee/i.test(receiptText), 'generated quote page shows the Rush Production Fee line item');
  console.log('  ok: a quote generated with Rush Production checked shows the fee on the customer-facing quote page');

  await browser.close();
  console.log('\n=== ALL TURNAROUND/RUSH CHECKS PASSED ===');
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
