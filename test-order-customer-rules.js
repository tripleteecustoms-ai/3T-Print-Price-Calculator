// Focused test for Task #25: Order Rules, Customer Rules, and Production
// Rules as an editable-policy CMS (the policies infrastructure itself —
// public/admin routes, 404 handling for admin-only policies — is already
// covered generically by test-rush-and-policies.js). This test covers what's
// specific to Task #25: Order Policy and Customer Policy are hyperlinked in
// the customer builder before a customer can place an order, and
// Production Rules stay fully admin-editable despite never being
// customer-facing.
const { chromium } = require('playwright');
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

async function setQty(page, colorBlockIndex, sizeLabel, qty) {
  const block = page.locator('.color-block').nth(colorBlockIndex);
  const stepper = block.locator(`.qty-stepper[data-size="${sizeLabel}"] input`);
  await stepper.fill(String(qty));
  await stepper.dispatchEvent('change');
}

async function main() {
  console.log('=== ORDER / CUSTOMER / PRODUCTION RULES ===');
  const cookie = await adminLogin();

  // ---- 1) order_rules and customer_rules have real starter content ----
  const orderPolicy = (await (await fetch(`${BASE}/api/policies/order_rules`)).json()).policy;
  const customerPolicy = (await (await fetch(`${BASE}/api/policies/customer_rules`)).json()).policy;
  assert(orderPolicy.body.length > 20, 'order_rules has real starter content');
  assert(customerPolicy.body.length > 20, 'customer_rules has real starter content');
  console.log('  ok: order_rules and customer_rules both have real starter policy text');

  // ---- 2) production_rules is admin-editable even though it's not customer-facing ----
  const prodBefore = (await (await fetch(`${BASE}/api/admin/policies`, { headers: { Cookie: cookie } })).json())
    .policies.find(p => p.key === 'production_rules');
  assert(prodBefore && !prodBefore.customer_facing, 'production_rules exists and is marked non-customer-facing');
  const editResp = await fetch(`${BASE}/api/admin/policies/production_rules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: prodBefore.title, body: 'Edited internal production notes for the test run.' }),
  });
  assert(editResp.ok, 'admin can edit production_rules despite it being internal-only');
  const stillNotPublic = await fetch(`${BASE}/api/policies/production_rules`);
  assert.strictEqual(stillNotPublic.status, 404, 'production_rules remains 404 on the public route even after editing');
  // revert
  await fetch(`${BASE}/api/admin/policies/production_rules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: prodBefore.title, body: prodBefore.body }),
  });
  console.log('  ok: production_rules is fully admin-editable but never exposed on the public route, before or after editing');

  // ==================================================================== BROWSER
  console.log('\n=== BROWSER: Order/Customer Policy links on the Confirmation step ===');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });

  await page.goto(`${BASE}/`);
  await page.waitForSelector('#firstName');
  await page.fill('#firstName', 'Rules');
  await page.fill('#lastName', 'Tester');
  await page.fill('#email', 'rules.tester@example.com');
  await page.fill('#phone', '555-333-4444');
  await page.click('.builder-step[data-step="contact"] [data-nav="next"]');
  await page.waitForSelector('#garmentGrid .option-card');
  await page.click('#garmentGrid .option-card');
  await page.waitForSelector('#colorGrid .color-swatch');
  await page.locator('#colorGrid .color-swatch').nth(0).click();
  await page.click('#colorNextBtn');
  await page.waitForSelector('.color-block');
  await setQty(page, 0, 'M', 24);
  await page.click('#sizesNextBtn');
  await page.click('#locationsNextBtn');
  await page.waitForTimeout(300);
  await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');
  await page.waitForTimeout(300);

  await page.waitForSelector('.builder-step[data-step="confirmation"]');
  const orderPolicyLink = page.locator('.builder-step[data-step="confirmation"] a[href="/policy.html?key=order_rules"]');
  const customerPolicyLink = page.locator('.builder-step[data-step="confirmation"] a[href="/policy.html?key=customer_rules"]');
  assert.strictEqual(await orderPolicyLink.count(), 1, 'Confirmation step links to the Order Policy');
  assert.strictEqual(await customerPolicyLink.count(), 1, 'Confirmation step links to the Customer Policy');
  console.log('  ok: the Confirmation step (last step before "Calculate Total") links to both the Order Policy and Customer Policy');

  // the link actually resolves to real content, not a broken/404 page
  // (links open in a new tab via target=_blank, so just verify the href resolves directly)
  const orderPageResp = await fetch(`${BASE}/policy.html?key=order_rules`);
  assert(orderPageResp.ok, 'the linked Order Policy page loads successfully');

  await browser.close();
  console.log('\n=== ALL ORDER/CUSTOMER/PRODUCTION RULES CHECKS PASSED ===');
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
