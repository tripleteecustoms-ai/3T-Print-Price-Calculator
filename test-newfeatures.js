// Tests for: clickable step tabs + prerequisite guards, expanded garment
// catalog, and per-garment price adjustments (Hoodie, Hat/Cap).
const { chromium } = require('playwright');
const path = require('path');

const BASE = 'http://localhost:4790';
function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); console.log('  ok:', msg); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  [pageerror]', e.message));

  console.log('\n=== GARMENT CATALOG ===');
  await page.goto(BASE + '/index.html');
  await page.waitForSelector('#garmentGrid .option-card');
  const garmentCount = await page.locator('#garmentGrid .option-card').count();
  assert(garmentCount === 11, `garment catalog shows all 11 garments (found ${garmentCount})`);
  const garmentNames = await page.locator('#garmentGrid .oc-title').allInnerTexts();
  console.log('  garments:', garmentNames.join(', '));
  for (const n of ['Standard Quality T-Shirt','Hoodie','Heavyweight Hoodie','Hat / Cap','Tote Bag','Polo Shirt']) {
    assert(garmentNames.includes(n), `catalog includes "${n}"`);
  }

  console.log('\n=== CLICKABLE TABS + PREREQUISITE GUARDS ===');
  // Jump straight to "PRINT" (index 3) with nothing selected yet.
  await page.click('.step-pill[data-step-index="3"]');
  await page.waitForSelector('.prereq-notice');
  const notice1 = await page.locator('#locationGrid .prereq-notice p').innerText();
  assert(notice1.includes('size quantities'), `locations step shows a helpful prompt instead of a blank grid ("${notice1}")`);
  // Nothing at all is selected yet, so following the "go back" chain should
  // cascade: locations -> sizes -> color -> garment, each with its own
  // accurate prompt, landing on the one step that's actually ready to use.
  await page.click('#locationGrid [data-goto-step]');
  await page.waitForTimeout(200);
  assert(await page.locator('.builder-step[data-step="sizes"]').isVisible(), 'chain step 1: lands on sizes step');
  const notice1b = await page.locator('#colorBlocks .prereq-notice p').innerText();
  assert(notice1b.includes('color'), `sizes step correctly says a color is needed first ("${notice1b}")`);
  await page.click('#colorBlocks [data-goto-step]');
  await page.waitForTimeout(200);
  assert(await page.locator('.builder-step[data-step="color"]').isVisible(), 'chain step 2: lands on color step');
  const notice1c = await page.locator('#colorGrid .prereq-notice p').innerText();
  assert(notice1c.includes('garment'), `color step correctly says a garment is needed first ("${notice1c}")`);
  await page.click('#colorGrid [data-goto-step]');
  await page.waitForTimeout(200);
  assert(await page.locator('.builder-step[data-step="garment"]').isVisible(), 'chain step 3: lands on garment step — the one step actually ready to use');

  // Now pick a garment, then jump ahead to ARTWORK before choosing print locations.
  await page.click('#garmentGrid .option-card >> nth=0');
  await page.waitForTimeout(200);
  await page.click('.step-pill[data-step-index="4"]'); // artwork
  await page.waitForSelector('#uploadSections .prereq-notice');
  const notice2 = await page.locator('#uploadSections .prereq-notice p').innerText();
  assert(notice2.includes('print location'), `artwork step shows a helpful prompt when no print location chosen ("${notice2}")`);

  // Jump to COLOR via tab — should work fine since garment is chosen.
  await page.click('.step-pill[data-step-index="1"]');
  await page.waitForSelector('#colorGrid .color-swatch');
  assert(await page.locator('#colorGrid .color-swatch').count() > 0, 'color step renders normally once garment is chosen (reached via tab click)');

  await ctx.close();

  console.log('\n=== HOODIE: PER-GARMENT PRICE ADJUSTMENT ===');
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE + '/index.html');
  await page2.waitForSelector('#garmentGrid .option-card');
  await page2.click('#garmentGrid .option-card:has(.oc-title:text-is("Hoodie"))');
  await page2.waitForSelector('#colorGrid .color-swatch');
  await page2.locator('#colorGrid .color-swatch').nth(0).click();
  await page2.click('#colorNextBtn');
  await page2.waitForSelector('.color-block');
  const mInput = page2.locator('.color-block').nth(0).locator('.qty-stepper[data-size="M"] input');
  await mInput.fill('12');
  await mInput.dispatchEvent('change');
  await page2.waitForTimeout(400);
  const hoodieSummary = await page2.locator('#summaryBody').innerText();
  console.log('  hoodie summary:\n' + hoodieSummary.split('\n').map(l => '    ' + l).join('\n'));
  // qty12 standard $22.50 + hoodie adjustment $12.00 = $34.50/ea x 12 = $414.00
  assert(hoodieSummary.includes('414.00'), 'Hoodie (12pc, standard price + $12 garment adjustment) totals $414.00');
  assert(hoodieSummary.includes('34.50'), 'displayed per-unit price ($34.50) matches what the total is actually multiplying — not the raw $22.50 tier price');

  await ctx2.close();

  console.log('\n=== HAT/CAP: ONE-SIZE GARMENT FULL FLOW ===');
  const ctx3 = await browser.newContext({ viewport: { width: 480, height: 900 } }); // mobile viewport too
  const page3 = await ctx3.newPage();
  await page3.goto(BASE + '/index.html');
  await page3.waitForSelector('#garmentGrid .option-card');
  await page3.click('#garmentGrid .option-card:has(.oc-title:text-is("Hat / Cap"))');
  await page3.waitForSelector('#colorGrid .color-swatch');
  await page3.locator('#colorGrid .color-swatch').nth(0).click();
  await page3.click('#colorNextBtn');
  await page3.waitForSelector('.color-block');
  const oneSizeInput = page3.locator('.color-block').nth(0).locator('.qty-stepper[data-size="One Size"] input');
  await oneSizeInput.fill('24');
  await oneSizeInput.dispatchEvent('change');
  await page3.waitForTimeout(400);
  await page3.screenshot({ path: path.join(__dirname, 'screenshots', '19-hat-onesize-mobile.png') });
  const hatSummary = await page3.locator('#summaryBody').innerText();
  console.log('  hat summary (mobile viewport):\n' + hatSummary.split('\n').map(l => '    ' + l).join('\n'));
  // qty24 standard $20.00 - hat adjustment $8.00 = $12.00/ea x 24 = $288.00
  assert(hatSummary.includes('288.00'), 'Hat/Cap (24pc, one-size, standard price - $8 garment adjustment) totals $288.00');
  assert(!hatSummary.includes('undefined') && !hatSummary.includes('NaN'), 'no broken values in one-size garment summary');
  await page3.click('#sizesNextBtn');
  await page3.waitForSelector('#locationGrid .option-card');
  await page3.click('#locationsNextBtn');
  await page3.waitForSelector('.upload-section');
  assert(await page3.locator('.upload-section').count() >= 1, 'artwork upload section renders for one-size garment');

  await ctx3.close();
  await browser.close();
  console.log('\n=== NEW-FEATURE CHECKS PASSED ===');
})().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
