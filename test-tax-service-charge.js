// Focused test for Task #31: a display-only tax + service-charge estimate,
// shown for customer transparency while the real, exact tax is calculated
// by Shopify at actual checkout. Both settings default to 0 (off) — a shop
// that hasn't configured a rate should see no change in behavior at all.
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'http://localhost:4790';
function assertOk(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); console.log('  ok:', msg); }

async function login() {
  const resp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  return resp.headers.get('set-cookie');
}

async function estimate(garmentId, colorSelections, printLocationIds) {
  const resp = await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ garmentId, colorSelections, printLocationIds }),
  });
  return (await resp.json()).estimate;
}

async function main() {
  console.log('=== TAX & SERVICE CHARGE ESTIMATE (Task #31) ===');
  const cookie = await login();

  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const colorSelections = [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty: 24 }] }];

  // ---- 1) default (0%) hides the estimate entirely — no behavior change for a shop that hasn't configured a rate ----
  const before = await estimate(tee.id, colorSelections, []);
  assert.strictEqual(before.estimatedTax, 0, 'estimatedTax is 0 by default');
  assert.strictEqual(before.estimatedServiceCharge, 0, 'estimatedServiceCharge is 0 by default');
  assert.strictEqual(before.estimatedGrandTotal, before.total, 'estimatedGrandTotal equals the real total when both rates are 0');
  console.log(`  ok: with 0% tax/service-charge configured, the estimate adds nothing (total stays $${before.total})`);

  // ---- 2) admin sets an 8.25% tax rate + 3% service charge ----
  const saveResp = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ estimated_tax_percent: '8.25', service_charge_percent: '3' }),
  });
  assert(saveResp.ok, 'admin can save an estimated tax rate + service charge percent');

  try {
    const after = await estimate(tee.id, colorSelections, []);
    const expectedTax = Math.round(after.total * 0.0825 * 100) / 100;
    const expectedService = Math.round(after.total * 0.03 * 100) / 100;
    assert.strictEqual(after.estimatedTaxPercent, 8.25, 'estimatedTaxPercent reflects the configured rate');
    assert.strictEqual(after.estimatedTax, expectedTax, `estimatedTax is computed correctly off the real total (8.25% of $${after.total} = $${expectedTax}, got $${after.estimatedTax})`);
    assert.strictEqual(after.estimatedServiceCharge, expectedService, `estimatedServiceCharge is computed correctly (3% of $${after.total} = $${expectedService}, got $${after.estimatedServiceCharge})`);
    const expectedGrand = Math.round((after.total + expectedTax + expectedService) * 100) / 100;
    assert.strictEqual(after.estimatedGrandTotal, expectedGrand, `estimatedGrandTotal = total + tax + service charge ($${expectedGrand})`);
    // critically: the REAL total (what's actually charged / used for checkout) must be completely unaffected
    assert.strictEqual(after.total, before.total, 'the real, authoritative total is completely unaffected by the tax/service-charge estimate — this is display-only');
    console.log('  ok: estimatedTax/estimatedServiceCharge/estimatedGrandTotal all compute correctly, and the real charge total never changes');

    // ---- 3) the browser summary panel and quote receipt both show the estimate, clearly separate from the real total ----
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();
    page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });

    await page.goto(`${BASE}/`);
    await page.waitForSelector('#firstName');
    await page.fill('#firstName', 'Tax');
    await page.fill('#lastName', 'Estimate');
    await page.fill('#email', `tax.estimate.${Date.now()}@example.com`);
    await page.fill('#phone', '555-820-3000');
    await page.click('.builder-step[data-step="contact"] [data-nav="next"]');
    await page.waitForSelector('#garmentGrid .option-card');
    await page.click('#garmentGrid .option-card');
    await page.waitForSelector('#colorGrid .color-swatch');
    await page.locator('#colorGrid .color-swatch').nth(0).click();
    await page.click('#colorNextBtn');
    await page.waitForSelector('.color-block');
    const stepper = page.locator('.color-block').nth(0).locator('.qty-stepper[data-size="M"] input');
    await stepper.fill('24');
    await stepper.dispatchEvent('change');
    await page.waitForTimeout(400);

    const summaryText = await page.locator('#summaryBody').innerText();
    assertOk(/Est\. Tax \(8\.25%\)/.test(summaryText), `builder summary panel shows the estimated tax line (got:\n${summaryText})`);
    assertOk(/Est\. Service Charge \(3%\)/.test(summaryText), 'builder summary panel shows the estimated service charge line');
    assertOk(/Est\. Grand Total/.test(summaryText), 'builder summary panel shows an estimated grand total, separate from the real "Estimated Total"');
    assertOk(/estimates only/i.test(summaryText), 'summary note clarifies these figures are estimates only');
    console.log('  ok: builder summary panel shows tax/service-charge as clearly-labeled estimates');

    await page.click('#sizesNextBtn');
    await page.waitForSelector('#locationGrid .option-card');
    await page.click('#locationsNextBtn');
    await page.waitForSelector('.upload-section');
    await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');
    await page.waitForSelector('#confirmationSummary .color-block');
    await page.click('#getPriceBtn');
    await page.waitForURL('**/quote.html?id=*', { timeout: 15000 });
    await page.waitForSelector('.receipt-total');

    const receiptText = await page.locator('#itemizedPricing').innerText();
    assertOk(/Estimated Tax \(8\.25%\)/.test(receiptText), `quote receipt shows the estimated tax line (got:\n${receiptText})`);
    assertOk(/Estimated Service Charge \(3%\)/.test(receiptText), 'quote receipt shows the estimated service charge line');
    assertOk(/Est\. grand total/i.test(receiptText), 'quote receipt shows an estimated grand total line, separate from the real charge total');

    const realTotalText = await page.locator('.receipt-total .rt-amt').innerText();
    assertOk(realTotalText.trim() === `$${after.total.toFixed(2)}`, `the real receipt total (what would actually be charged) stays exactly $${after.total.toFixed(2)}, unaffected by the tax estimate (got ${realTotalText})`);
    console.log('  ok: quote receipt shows the estimate clearly separate from the real, authoritative charge total');

    await browser.close();
  } finally {
    // cleanup: reset to 0% so other tests' assumptions (no tax/service-charge noise) hold
    await fetch(`${BASE}/api/admin/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ estimated_tax_percent: '0', service_charge_percent: '0' }),
    });
  }

  console.log('\n=== TAX & SERVICE CHARGE ESTIMATE: ALL CHECKS PASSED ===');
}

main().catch(err => {
  console.error('TAX/SERVICE CHARGE TEST FAILED:', err);
  process.exit(1);
});
