// Full end-to-end smoke test across all three sides of the app.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:4790';
const SHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR);

// small red-square PNG for artwork upload tests
const PNG_PATH = path.join(__dirname, 'test-artwork.png');
if (!fs.existsSync(PNG_PATH)) {
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(PNG_PATH, png1x1);
}

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); console.log('  ok:', msg); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ================================================================ CUSTOMER FLOW
  console.log('\n=== CUSTOMER ORDER BUILDER ===');
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));
  page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text()); });

  await page.goto(BASE + '/index.html');
  await page.waitForSelector('#garmentGrid .option-card');
  await page.screenshot({ path: path.join(SHOT_DIR, '01-garment.png') });
  await page.click('#garmentGrid .option-card');
  await page.waitForSelector('#colorGrid .color-swatch');
  assert(await page.locator('.builder-step[data-step="color"]').isVisible(), 'advanced to color step');

  // select two colors to exercise multi-color flow
  const swatches = page.locator('#colorGrid .color-swatch');
  await swatches.nth(0).click(); // Black
  await swatches.nth(1).click(); // White
  await page.screenshot({ path: path.join(SHOT_DIR, '02-colors.png') });
  await page.click('#colorNextBtn');

  await page.waitForSelector('.color-block');
  // Black: S2 M5 L8 XL5 2XL3 3XL1 = 24 total (matches spec worked example)
  await setQty(page, 0, 'S', 2); await setQty(page, 0, 'M', 5); await setQty(page, 0, 'L', 8);
  await setQty(page, 0, 'XL', 5); await setQty(page, 0, '2XL', 3); await setQty(page, 0, '3XL', 1);
  // qty input now debounces the price-refresh network call by ~300ms
  // (see builder.js onSizesChanged) — wait past that before reading the
  // summary panel below.
  await page.waitForTimeout(550);
  await page.screenshot({ path: path.join(SHOT_DIR, '03-sizes.png') });
  const sizesNextDisabled = await page.locator('#sizesNextBtn').isDisabled();
  assert(!sizesNextDisabled, '24pc order allowed to continue (not blocked as bulk)');
  await page.click('#sizesNextBtn');

  await page.waitForSelector('#locationGrid .option-card');
  // select Back print in addition to included Front
  const backCard = page.locator('#locationGrid .option-card:has(.oc-title:text-is("BACK"))');
  await backCard.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, '04-locations.png') });
  const summaryText = await page.locator('#summaryBody').innerText();
  console.log('  summary panel:\n' + summaryText.split('\n').map(l => '    ' + l).join('\n'));
  assert(summaryText.includes('609.00'), 'live estimate shows $609.00 (matches server calc incl. size surcharges)');
  await page.click('#locationsNextBtn');

  await page.waitForSelector('.upload-section');
  const uploadInputs = page.locator('.upload-section input[type=file]');
  await uploadInputs.nth(0).setInputFiles(PNG_PATH);
  await page.waitForSelector('.file-chip');
  await uploadInputs.nth(1).setInputFiles(PNG_PATH);
  await page.waitForTimeout(300);
  await page.fill('#designNotes', 'Please make the logo approximately 10 inches wide.');
  const artworkNextEnabled = await page.locator('#artworkNextBtn').isEnabled();
  assert(artworkNextEnabled, 'artwork Continue button is enabled once files are uploaded for every location (no explicit "send later" needed)');
  await page.screenshot({ path: path.join(SHOT_DIR, '05-artwork.png') });
  await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');

  await page.waitForSelector('#firstName');
  await page.fill('#firstName', 'Jane');
  await page.fill('#lastName', 'Doe');
  await page.fill('#email', 'jane.doe@example.com');
  await page.fill('#phone', '555-867-5309');
  await page.fill('#businessName', 'Doe Events Co');
  await page.click('#orderPurposeGroup [data-value="Special Event"]');
  await page.click('#fulfillmentGroup [data-value="shipping"]');
  const getPriceDisabledBeforeTerms = await page.locator('#getPriceBtn').isDisabled();
  assert(getPriceDisabledBeforeTerms, 'Get My Quote is disabled until the terms checkbox is checked');
  await page.check('#builderTermsCheckbox');
  await page.screenshot({ path: path.join(SHOT_DIR, '06-contact.png') });

  await page.click('#getPriceBtn');
  await page.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  const quoteUrl = new URL(page.url());
  const quoteCode = quoteUrl.searchParams.get('id');
  console.log('  Generated quote code:', quoteCode);
  assert(/^3T-\d{6}-\d{4}$/.test(quoteCode), 'quote code matches 3T-YYMMDD-#### format');

  // ================================================================ QUOTE / CHECKOUT
  console.log('\n=== CUSTOMER QUOTE PAGE ===');
  await page.waitForSelector('#itemizedPricing');
  await page.screenshot({ path: path.join(SHOT_DIR, '07-quote.png'), fullPage: true });
  const totalText = await page.locator('.receipt-total .rt-amt').innerText();
  assert(totalText.trim() === '$609.00', `quote total is $609.00 (got ${totalText})`);
  const customerDetailsText = await page.locator('#customerDetails').innerText();
  assert(customerDetailsText.includes('Special Event'), 'quote page shows selected order purpose (Special Event)');
  const payDisabled = await page.locator('#payBtn').isDisabled();
  assert(payDisabled, 'Pay button disabled until terms accepted');

  await page.check('#termsCheckbox');
  await page.click('#payBtn');
  await page.waitForURL('**/checkout-mock.html*', { timeout: 10000 });
  await page.screenshot({ path: path.join(SHOT_DIR, '08-mock-checkout.png') });
  assert((await page.locator('#mAmount').innerText()) === '$609.00', 'mock checkout shows correct amount');

  await page.click('#payBtn');
  await page.waitForURL('**/order-received.html*', { timeout: 10000 });
  await page.waitForSelector('#orderDetails .detail-item');
  await page.screenshot({ path: path.join(SHOT_DIR, '09-order-received.png') });
  const orderDetailsText = await page.locator('#orderDetails').innerText();
  assert(orderDetailsText.includes('$609.00'), 'order received page shows amount paid $609.00');
  assert(orderDetailsText.includes('Pending Production Review'), 'order marked PAID - PENDING PRODUCTION REVIEW');
  console.log('  Paid quote code:', quoteCode);

  // ================================================================ SECOND QUOTE for override/edit testing (unpaid)
  console.log('\n=== SECOND (UNPAID) QUOTE FOR ADMIN OVERRIDE + EDIT TESTS ===');
  await page.goto(BASE + '/index.html');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.waitForSelector('#garmentGrid .option-card');
  await page.click('#garmentGrid .option-card');
  await page.waitForSelector('#colorGrid .color-swatch');
  await page.locator('#colorGrid .color-swatch').nth(2).click(); // Royal Blue
  await page.click('#colorNextBtn');
  await page.waitForSelector('.color-block');
  await setQty(page, 0, 'M', 24); // simple 24pc single-size order, front only
  await page.waitForTimeout(550); // past the ~300ms qty-input debounce
  await page.click('#sizesNextBtn');
  await page.waitForSelector('#locationGrid .option-card');
  await page.click('#locationsNextBtn'); // front only (default selected)
  await page.waitForSelector('.upload-section');
  const artworkNextDisabledNoChoice = await page.locator('#artworkNextBtn').isDisabled();
  assert(artworkNextDisabledNoChoice, 'artwork Continue is disabled until an upload or "send later" is chosen (no silent skip)');
  await page.check('#artworkLaterCheckbox'); // no artwork on hand yet — explicit "send later" path
  assert(await page.locator('#artworkNextBtn').isEnabled(), 'checking "send artwork later" enables Continue');
  await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');
  await page.waitForSelector('#firstName');
  await page.fill('#firstName', 'Alex');
  await page.fill('#lastName', 'Rivera');
  await page.fill('#email', 'alex.rivera@example.com');
  await page.fill('#phone', '555-222-3333');
  await page.check('#builderTermsCheckbox');
  await page.click('#getPriceBtn');
  await page.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  const quoteCode2 = new URL(page.url()).searchParams.get('id');
  console.log('  Generated 2nd quote code:', quoteCode2);
  const total2 = await page.locator('.receipt-total .rt-amt').innerText();
  assert(total2.trim() === '$480.00', `24pc front-only standard total is $480.00 (got ${total2}) — matches spec example`);

  await ctx.close();

  // ================================================================ ADMIN
  console.log('\n=== ADMIN DASHBOARD ===');
  const actx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const apage = await actx.newPage();
  apage.on('pageerror', e => console.log('  [pageerror]', e.message));

  await apage.goto(BASE + '/admin/login.html');
  await apage.fill('#username', 'admin');
  await apage.fill('#password', '3tprint-admin-2026');
  await apage.click('#loginBtn');
  await apage.waitForURL('**/admin/dashboard.html', { timeout: 10000 });
  await apage.waitForSelector('.stat-tile');
  await apage.screenshot({ path: path.join(SHOT_DIR, '10-admin-dashboard.png'), fullPage: true });
  const dashboardText = await apage.locator('#statGrid').innerText();
  console.log('  dashboard stats:\n' + dashboardText.split('\n').map(l => '    ' + l).join('\n'));
  assert(dashboardText.includes('1'), 'dashboard shows at least 1 paid order');

  // ---- Quotes panel + detail modal ----
  await apage.click('[data-panel="quotes"]');
  await apage.waitForSelector('#quotesBody tr');
  await apage.screenshot({ path: path.join(SHOT_DIR, '11-admin-quotes.png') });
  const rowCount = await apage.locator('#quotesBody tr').count();
  assert(rowCount >= 2, `quotes list shows both generated quotes (found ${rowCount})`);

  await apage.click(`#quotesBody [data-open-quote="${quoteCode2}"]`);
  await apage.waitForSelector('.modal');
  await apage.screenshot({ path: path.join(SHOT_DIR, '12-admin-quote-detail.png'), fullPage: true });
  const marginText = await apage.locator('.override-grid').innerText();
  console.log('  pricing tiles:\n' + marginText.split('\n').map(l => '    ' + l).join('\n'));
  assert(marginText.includes('$20.00'), 'standard price tile shows $20.00 for 24pc');
  assert(marginText.includes('$16.67'), 'hard floor tile shows $16.67 for 24pc');

  // ---- Below-floor override with confirmation gate ----
  await apage.fill('#overrideUnitPrice', '10.00'); // well below the $16.67 floor
  await apage.fill('#overrideNote', 'Testing below-floor confirmation gate');
  await apage.click('#applyOverrideBtn');
  await apage.waitForSelector('#confirmBelowFloor');
  await apage.screenshot({ path: path.join(SHOT_DIR, '13-below-floor-warning.png') });
  assert(await apage.locator('.warn-box.red').isVisible(), 'below-floor warning box appears before confirmation');
  await apage.check('#confirmBelowFloor');
  await apage.click('#applyOverrideBtn');
  await apage.waitForSelector('.warn-box.red:has-text("Below Floor Override Active")', { timeout: 8000 });
  console.log('  ok: below-floor override applied only after explicit confirmation, and is now flagged on the quote');

  // ---- Status update ----
  await apage.selectOption('#statusSelect', 'needs_review');
  await apage.click('#applyStatusBtn');
  await apage.waitForTimeout(400);
  await apage.waitForSelector('.modal .badge:has-text("needs review")', { timeout: 8000 });
  console.log('  ok: quote status updated to needs_review');
  await apage.keyboard.press('Escape').catch(() => {});
  await apage.click('#modalCloseBtn').catch(() => {});

  // ---- Garments panel: add a color ----
  await apage.click('[data-panel="garments"]');
  await apage.waitForSelector('.admin-card[data-garment-id]');
  const colorCountBefore = await apage.locator('.color-row').count();
  await apage.click('.add-color-btn');
  await apage.waitForTimeout(500);
  const colorCountAfter = await apage.locator('.color-row').count();
  assert(colorCountAfter === colorCountBefore + 1, `garment color added (before ${colorCountBefore}, after ${colorCountAfter})`);
  await apage.screenshot({ path: path.join(SHOT_DIR, '14-admin-garments.png') });

  // ---- Pricing panel (Phase 2): edit the "Standard Quality T-Shirt" garment's
  // 10-24 tier row and verify it persists. Replaces the old global 1-24
  // exact-quantity matrix editor — Phase 2 moved to per-garment tier pricing,
  // see server/pricingEngine.js / server/seed.js migration notes.
  await apage.click('[data-panel="pricing"]');
  await apage.waitForSelector('#pricingGarmentSelect');
  await apage.selectOption('#pricingGarmentSelect', { label: 'Standard Quality T-Shirt' });
  await apage.waitForSelector('#fixedTierTable tr[data-tier-id]');
  const tier1024Row = apage.locator('#fixedTierTable tr').filter({ hasText: '10-24' });
  await tier1024Row.locator('.ft-standard').fill('21.00');
  await apage.click('#saveFixedTierBtn');
  await apage.waitForTimeout(400);
  await apage.reload();
  await apage.click('[data-panel="pricing"]');
  await apage.waitForSelector('#pricingGarmentSelect');
  await apage.selectOption('#pricingGarmentSelect', { label: 'Standard Quality T-Shirt' });
  await apage.waitForSelector('#fixedTierTable tr[data-tier-id]');
  const reloadedRow = apage.locator('#fixedTierTable tr').filter({ hasText: '10-24' });
  const newStandard = await reloadedRow.locator('.ft-standard').inputValue();
  assert(newStandard === '21', `per-garment tier price edit persisted (10-24 tier standard now $${newStandard})`);
  // .badge is styled text-transform:uppercase (brand.css), so innerText() renders
  // "CONFIRMED" — compare case-insensitively rather than against the HTML-source casing.
  assert(/confirmed/i.test(await reloadedRow.innerText()), 'editing a tier price clears its Estimated badge (real admin edit)');

  // Regression test for a real bug found during development: "Save Tier Prices"
  // used to submit EVERY row unconditionally, silently clearing the Estimated
  // flag on placeholder tiers the admin never touched. Prove that editing one
  // still-estimated tier ("25-49") leaves a DIFFERENT untouched estimated tier
  // ("50-99") still flagged Estimated after save+reload.
  const tier2549RowBefore = apage.locator('#fixedTierTable tr').filter({ hasText: '25-49' });
  assert(/estimated/i.test(await tier2549RowBefore.innerText()), '25-49 tier starts out flagged Estimated (placeholder from migration)');
  const tier5099RowBefore = apage.locator('#fixedTierTable tr').filter({ hasText: '50-99' });
  assert(/estimated/i.test(await tier5099RowBefore.innerText()), '50-99 tier starts out flagged Estimated (placeholder from migration, left untouched)');
  await tier2549RowBefore.locator('.ft-standard').fill('19.50');
  await apage.click('#saveFixedTierBtn');
  await apage.waitForTimeout(400);
  await apage.reload();
  await apage.click('[data-panel="pricing"]');
  await apage.waitForSelector('#pricingGarmentSelect');
  await apage.selectOption('#pricingGarmentSelect', { label: 'Standard Quality T-Shirt' });
  await apage.waitForSelector('#fixedTierTable tr[data-tier-id]');
  const tier2549RowAfter = apage.locator('#fixedTierTable tr').filter({ hasText: '25-49' });
  assert(/confirmed/i.test(await tier2549RowAfter.innerText()), 'editing the 25-49 tier clears ONLY its own Estimated badge');
  const tier5099RowAfter = apage.locator('#fixedTierTable tr').filter({ hasText: '50-99' });
  assert(/estimated/i.test(await tier5099RowAfter.innerText()), 'untouched 50-99 tier is STILL flagged Estimated after saving a different row (bulk-save bug fixed)');
  // revert the 25-49 edit so future runs / other checks stay clean
  await tier2549RowAfter.locator('.ft-standard').fill('19.40');
  await apage.click('#saveFixedTierBtn');
  await apage.waitForTimeout(300);

  // revert the 10-24 edit so future runs / other checks stay clean
  const tier1024RowRevert = apage.locator('#fixedTierTable tr').filter({ hasText: '10-24' });
  await tier1024RowRevert.locator('.ft-standard').fill('20.00');
  await apage.click('#saveFixedTierBtn');
  await apage.screenshot({ path: path.join(SHOT_DIR, '15-admin-pricing.png') });

  // ---- Price Tester: same code path as a live quote, no quote created ----
  await apage.waitForSelector('#priceTesterQty');
  await apage.fill('#priceTesterQty', '24');
  await apage.click('#priceTesterBtn');
  await apage.waitForSelector('#priceTesterResult .override-grid');
  const testerText = await apage.locator('#priceTesterResult').innerText();
  assert(testerText.includes('$20.00'), `Price Tester shows the correct standard unit price at qty 24 (got:\n${testerText})`);
  console.log('  ok: admin Price Tester computes a live price without creating a quote');

  // ---- Print locations panel ----
  await apage.click('[data-panel="locations"]');
  await apage.waitForSelector('.admin-card[data-loc-id]');
  await apage.screenshot({ path: path.join(SHOT_DIR, '16-admin-locations.png') });

  // ---- Artwork panel ----
  await apage.click('[data-panel="artwork"]');
  await apage.waitForTimeout(400);
  await apage.screenshot({ path: path.join(SHOT_DIR, '17-admin-artwork.png') });
  const artworkCount = await apage.locator('#artworkGrid .option-card').count();
  assert(artworkCount >= 2, `artwork panel lists uploaded files (found ${artworkCount})`);

  // ---- Settings panel ----
  await apage.click('[data-panel="settings"]');
  await apage.waitForSelector('#settingBusinessName');
  await apage.click('[data-tab="email"]');
  await apage.waitForTimeout(300);
  await apage.screenshot({ path: path.join(SHOT_DIR, '18-admin-settings-email.png') });
  const emailRows = await apage.locator('#emailsBody tr').count();
  assert(emailRows >= 1, `mock email log shows sent quote emails (found ${emailRows})`);

  // ---- Settings > Payment: Shopify Client ID/Secret fields save correctly ----
  await apage.click('[data-tab="payment"]');
  await apage.waitForSelector('#settingShopifyClientId');
  await apage.fill('#settingShopifyDomain', 'test-shop.myshopify.com');
  await apage.fill('#settingShopifyClientId', 'test_client_id_123');
  await apage.fill('#settingShopifyClientSecret', 'test_client_secret_456');
  await apage.click('#savePaymentBtn');
  await apage.waitForTimeout(400);
  await apage.reload();
  await apage.click('[data-panel="settings"]');
  await apage.waitForSelector('#settingBusinessName');
  await apage.click('[data-tab="payment"]');
  await apage.waitForSelector('#settingShopifyClientId');
  const savedClientId = await apage.locator('#settingShopifyClientId').inputValue();
  const savedClientSecret = await apage.locator('#settingShopifyClientSecret').inputValue();
  assert(savedClientId === 'test_client_id_123', `Shopify Client ID persists after save/reload (got "${savedClientId}")`);
  assert(savedClientSecret === 'test_client_secret_456', `Shopify Client Secret persists after save/reload (got "${savedClientSecret}")`);
  console.log('  ok: Shopify Client ID/Secret fields save and reload correctly (the new Jan-2026 credential model)');
  // revert so this doesn't leave the app pointed at "shopify"-ready-looking fake creds
  await apage.fill('#settingShopifyDomain', '');
  await apage.fill('#settingShopifyClientId', '');
  await apage.fill('#settingShopifyClientSecret', '');
  await apage.click('#savePaymentBtn');
  await apage.waitForTimeout(300);

  // ---- verify quote total confirmed unaffected by tampering (server recompute) ----
  console.log('\n=== SERVER-SIDE PRICE INTEGRITY CHECK ===');
  const tamperResp = await apage.evaluate(async () => {
    const r = await fetch('/api/estimate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ garmentId: 1, colorSelections: [{ colorName: 'Black', colorHex:'#111', sizes: [{ label: 'M', qty: 24 }] }], printLocationIds: [1], total: 1 }),
    });
    return r.json();
  });
  assert(tamperResp.estimate.total === 480, `client-sent bogus "total:1" field ignored — server recalculated real total $${tamperResp.estimate.total}`);

  await actx.close();
  await browser.close();
  console.log('\n=== ALL CHECKS PASSED ===');
})().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});

async function setQty(page, colorBlockIndex, sizeLabel, qty) {
  const block = page.locator('.color-block').nth(colorBlockIndex);
  const stepper = block.locator(`.qty-stepper[data-size="${sizeLabel}"] input`);
  await stepper.fill(String(qty));
  await stepper.dispatchEvent('change');
}
