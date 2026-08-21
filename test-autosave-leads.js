// Focused test for Task #29: auto-save of contact info as the customer
// types. A visitor who fills in name/email/phone on the Info step but never
// finishes the builder should still be captured server-side as a lead (via
// debounced POST /api/draft-contact), visible to the admin under the new
// "Leads" panel — and should drop off that list once they DO go on to
// generate a real quote (converted_quote_id gets set).
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

async function main() {
  console.log('=== AUTO-SAVE / LEAD CAPTURE (Task #29) ===');

  // ---- 0) route-level sanity: missing token rejected, blank fields are a no-op (not an error) ----
  const noToken = await fetch(`${BASE}/api/draft-contact`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'X' }),
  });
  assert.strictEqual(noToken.status, 400, 'draft-contact without a draftToken is rejected');
  const blank = await fetch(`${BASE}/api/draft-contact`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draftToken: 'route-sanity-blank' }),
  });
  assert.strictEqual(blank.status, 204, 'draft-contact with all-blank fields is a harmless no-op (no empty row written)');
  console.log('  ok: route-level validation (missing token rejected, all-blank fields skipped)');

  const cookie = await login();

  // ---- 1) typing on the Info step debounced-saves a lead, visible to the admin ----
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });

  const uniqueEmail = `autosave.lead.${Date.now()}@example.com`;
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#firstName');
  await page.fill('#firstName', 'Auto');
  await page.fill('#lastName', 'Save');
  await page.fill('#email', uniqueEmail);
  await page.fill('#phone', '555-611-7000');
  // debounce is 900ms — give it time to fire, without ever clicking Continue
  // or Calculate Total (the customer never finishes the builder)
  await page.waitForTimeout(1500);

  const adminLeadsResp = await fetch(`${BASE}/api/admin/draft-leads`, { headers: { Cookie: cookie } });
  const { leads } = await adminLeadsResp.json();
  const captured = leads.find(l => l.email === uniqueEmail);
  assertOk(captured, `lead was auto-saved server-side while typing, before Continue/Calculate Total was ever clicked (found among ${leads.length} unconverted leads)`);
  assertOk(captured.first_name === 'Auto' && captured.last_name === 'Save' && captured.phone === '555-611-7000', 'auto-saved lead has the correct name/phone captured mid-typing');
  console.log('  ok: contact info auto-saves server-side as the customer types, without submitting anything');

  // ---- 2) admin "Leads" panel renders the captured lead ----
  const apage = await browser.newPage();
  apage.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });
  await apage.goto(`${BASE}/admin/login.html`);
  await apage.fill('#username', 'admin');
  await apage.fill('#password', '3tprint-admin-2026');
  await apage.click('#loginBtn');
  await apage.waitForURL('**/admin/dashboard.html', { timeout: 10000 });
  await apage.click('[data-panel="leads"]');
  await apage.waitForSelector('#leadsBody tr');
  const leadsPanelText = await apage.locator('#leadsBody').innerText();
  assertOk(leadsPanelText.includes(uniqueEmail), 'the admin Leads panel lists the auto-saved lead');
  assertOk(leadsPanelText.includes('Auto Save'), 'the admin Leads panel shows the captured name');
  console.log('  ok: admin Leads panel renders captured leads with mailto/tel-friendly contact info');

  // ---- 3) finishing the builder converts the lead (it drops off the Leads list) ----
  await page.click('.builder-step[data-step="contact"] [data-nav="next"]');
  await page.waitForSelector('#garmentGrid .option-card');
  await page.click('#garmentGrid .option-card');
  await page.waitForSelector('#colorGrid .color-swatch');
  await page.locator('#colorGrid .color-swatch').nth(0).click();
  await page.click('#colorNextBtn');
  await page.waitForSelector('.color-block');
  const stepper = page.locator('.color-block').nth(0).locator('.qty-stepper[data-size="M"] input');
  await stepper.fill('6');
  await stepper.dispatchEvent('change');
  await page.waitForTimeout(300);
  await page.click('#sizesNextBtn');
  await page.waitForSelector('#locationGrid .option-card');
  await page.click('#locationsNextBtn');
  await page.waitForSelector('.upload-section');
  await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');
  await page.waitForSelector('#confirmationSummary .color-block');
  await page.click('#getPriceBtn');
  await page.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  console.log('  ok: the same session went on to generate a real quote');

  const leadsAfterResp = await fetch(`${BASE}/api/admin/draft-leads`, { headers: { Cookie: cookie } });
  const { leads: leadsAfter } = await leadsAfterResp.json();
  assertOk(!leadsAfter.some(l => l.email === uniqueEmail), 'the lead drops off the (unconverted) Leads list once it becomes a real quote');
  console.log('  ok: a converted lead no longer clutters the follow-up list');

  await browser.close();
  console.log('\n=== AUTO-SAVE / LEAD CAPTURE: ALL CHECKS PASSED ===');
}

main().catch(err => {
  console.error('AUTO-SAVE LEAD TEST FAILED:', err);
  process.exit(1);
});
