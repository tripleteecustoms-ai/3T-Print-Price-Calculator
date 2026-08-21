// Focused test for Task #28: the customer builder step-order overhaul.
// Info (contact) is now Step 1, a brand-new Confirmation step ("goes over
// everything") is the new last step, Additional Notes + the policy links +
// "Calculate Total" all moved from Info to Confirmation, and the
// print-method selector (deferred from Task #21) now lives on the Print
// Locations step, only appearing once more than one decoration method is
// active.
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'http://localhost:4790';
const CANONICAL_ORDER = ['contact', 'garment', 'color', 'sizes', 'locations', 'artwork', 'confirmation'];

function assertOk(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); console.log('  ok:', msg); }

async function setQty(page, colorBlockIndex, sizeLabel, qty) {
  const block = page.locator('.color-block').nth(colorBlockIndex);
  const stepper = block.locator(`.qty-stepper[data-size="${sizeLabel}"] input`);
  await stepper.fill(String(qty));
  await stepper.dispatchEvent('change');
}

async function login() {
  const resp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  return resp.headers.get('set-cookie');
}

async function main() {
  console.log('=== STEP REORDER (Task #28) ===');

  // ---- 1) canonical order is Info -> Garment -> Color -> Sizes -> Print -> Artwork -> Confirmation ----
  const info = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.deepStrictEqual(info.stepOrder, CANONICAL_ORDER, `business-info reflects the canonical 7-step order (got ${JSON.stringify(info.stepOrder)})`);
  console.log('  ok: /api/business-info exposes the canonical order with Info first and Confirmation last');

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });

  // ---- 2) Info renders first, with no "Calculate Total" / Additional Notes / policy links on it ----
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#firstName');
  assertOk(await page.locator('.builder-step[data-step="contact"]').isVisible(), 'Info (contact) step is visible immediately on load — it is Step 1');
  assertOk(!(await page.locator('#garmentGrid .option-card').first().isVisible().catch(() => false)), 'Garment step is not visible yet');
  assertOk((await page.locator('.builder-step[data-step="contact"] #getPriceBtn').count()) === 0, '"Calculate Total" no longer lives on the Info step');
  assertOk((await page.locator('.builder-step[data-step="contact"] #additionalNotes').count()) === 0, 'Additional Notes no longer lives on the Info step');
  assertOk((await page.locator('.builder-step[data-step="contact"] a[href="/policy.html?key=order_rules"]').count()) === 0, 'Order Policy link no longer lives on the Info step');
  const eyebrow1 = await page.locator('.builder-step[data-step="contact"] .section-eyebrow').textContent();
  assertOk(eyebrow1.trim() === 'Step 1', `Info step's eyebrow correctly reads "Step 1" (got "${eyebrow1.trim()}")`);

  // ---- 3) fill out Info, continue to Garment, and confirm the step rail agrees ----
  await page.fill('#firstName', 'Order');
  await page.fill('#lastName', 'Tester');
  await page.fill('#email', 'order.tester@example.com');
  await page.fill('#phone', '555-010-2020');
  await page.click('.builder-step[data-step="contact"] [data-nav="next"]');
  await page.waitForSelector('#garmentGrid .option-card');
  assertOk(await page.locator('.builder-step[data-step="garment"]').isVisible(), 'advances to Garment after Info');
  // .step-pill is upper-cased via CSS text-transform; compare case-insensitively
  // since the underlying label text (STEP_LABELS) is what actually matters here.
  const railLabels = (await page.locator('.step-pill').allInnerTexts()).map(s => s.toLowerCase());
  assert.deepStrictEqual(railLabels, ['info', 'garment', 'color', 'sizes', 'print', 'artwork', 'confirm'], `step rail shows the 7 steps in canonical order (got ${JSON.stringify(railLabels)})`);
  console.log('  ok: step rail shows Info -> Garment -> Color -> Sizes -> Print -> Artwork -> Confirm');

  // ---- 4) decoration-method selector is hidden with only DTF active (the seeded default) ----
  await page.click('#garmentGrid .option-card');
  await page.waitForSelector('#colorGrid .color-swatch');
  await page.locator('#colorGrid .color-swatch').nth(0).click();
  await page.click('#colorNextBtn');
  await page.waitForSelector('.color-block');
  await setQty(page, 0, 'M', 6);
  await page.waitForTimeout(300);
  await page.click('#sizesNextBtn');
  await page.waitForSelector('#locationGrid .option-card');
  await page.waitForTimeout(300);
  assertOk((await page.locator('#decorationMethodSelector .radio-pill').count()) === 0, 'print-method selector stays hidden when only one decoration method (DTF) is active');

  await browser.close();

  // ---- 5) activate a second decoration method and confirm the selector now appears ----
  const cookie = await login();
  const adminList = await (await fetch(`${BASE}/api/admin/decoration-methods`, { headers: { Cookie: cookie } })).json();
  const screenPrint = adminList.decorationMethods.find(m => m.code === 'screen_print');
  assert(screenPrint, 'Screen Print exists in the seeded (inactive) decoration methods');
  await fetch(`${BASE}/api/admin/decoration-methods/${screenPrint.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ active: true }),
  });

  try {
    const browser2 = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    const page2 = await browser2.newPage();
    page2.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });

    await page2.goto(`${BASE}/`);
    await page2.waitForSelector('#firstName');
    await page2.fill('#firstName', 'Method');
    await page2.fill('#lastName', 'Picker');
    await page2.fill('#email', 'method.picker@example.com');
    await page2.fill('#phone', '555-030-4040');
    await page2.click('.builder-step[data-step="contact"] [data-nav="next"]');
    await page2.waitForSelector('#garmentGrid .option-card');
    await page2.click('#garmentGrid .option-card');
    await page2.waitForSelector('#colorGrid .color-swatch');
    await page2.locator('#colorGrid .color-swatch').nth(0).click();
    await page2.click('#colorNextBtn');
    await page2.waitForSelector('.color-block');
    await setQty(page2, 0, 'M', 6);
    await page2.waitForTimeout(300);
    await page2.click('#sizesNextBtn');
    await page2.waitForSelector('#decorationMethodSelector .radio-pill');
    const pillLabels = await page2.locator('#decorationMethodSelector .radio-pill').allInnerTexts();
    assertOk(pillLabels.includes('DTF') && pillLabels.includes('Screen Print'), `print-method selector appears with both active methods once a 2nd is active (found: ${pillLabels.join(', ')})`);

    // switching methods re-fetches print locations without crashing
    await page2.click('#decorationMethodSelector [data-value]:has-text("Screen Print")');
    await page2.waitForTimeout(400);
    assertOk(await page2.locator('#locationGrid .option-card').first().isVisible(), 'print locations still render after switching decoration method');
    console.log('  ok: selecting a different print method re-fetches locations without error');

    // ---- 6) Confirmation is the last step, recaps everything, and hosts Additional Notes + the policy links + Calculate Total ----
    await page2.waitForSelector('#locationGrid .option-card');
    await page2.click('#locationsNextBtn');
    await page2.waitForSelector('.upload-section');
    await page2.click('.builder-step[data-step="artwork"] [data-nav="next"]');
    await page2.waitForSelector('#confirmationSummary .color-block');
    assertOk(await page2.locator('.builder-step[data-step="confirmation"]').isVisible(), 'Confirmation is the step reached after Artwork');
    const eyebrow7 = await page2.locator('.builder-step[data-step="confirmation"] .section-eyebrow').textContent();
    assertOk(eyebrow7.trim() === 'Step 7', `Confirmation step's eyebrow correctly reads "Step 7" (got "${eyebrow7.trim()}")`);
    const confirmationText = await page2.locator('#confirmationSummary').innerText();
    assertOk(confirmationText.includes('Picker'), 'confirmation recap includes the contact name entered on Info');
    assertOk(confirmationText.includes('Screen Print'), 'confirmation recap shows the selected print method');
    assertOk((await page2.locator('.builder-step[data-step="confirmation"] #additionalNotes').count()) === 1, 'Additional Notes now lives on the Confirmation step');
    assertOk((await page2.locator('.builder-step[data-step="confirmation"] a[href="/policy.html?key=order_rules"]').count()) === 1, 'Order Policy link now lives on the Confirmation step');
    assertOk((await page2.locator('.builder-step[data-step="confirmation"] #getPriceBtn').count()) === 1, '"Calculate Total" now lives on the Confirmation step');

    await page2.fill('#additionalNotes', 'This is a Task #28 regression test order.');
    await page2.click('#getPriceBtn');
    await page2.waitForURL('**/quote.html?id=*', { timeout: 15000 });
    const quoteCode = new URL(page2.url()).searchParams.get('id');
    assertOk(/^3T-\d{6}-\d{4}$/.test(quoteCode), `full flow starting from Info still generates a valid quote (${quoteCode})`);

    await browser2.close();
  } finally {
    // cleanup: deactivate Screen Print again so other tests' "only DTF active" assumptions hold
    await fetch(`${BASE}/api/admin/decoration-methods/${screenPrint.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ active: false }),
    });
  }

  console.log('\n=== STEP REORDER: ALL CHECKS PASSED ===');
}

main().catch(err => {
  console.error('STEP REORDER TEST FAILED:', err);
  process.exit(1);
});
