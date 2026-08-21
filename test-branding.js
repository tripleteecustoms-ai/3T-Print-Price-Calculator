// Focused test for Task #27: the Branding tab (app/business name + logo)
// and its effect on the customer-facing site. Covers the admin API (auth,
// upload, remove, name save) and a real browser pass proving an uploaded
// logo actually replaces the text-only wordmark in the shared site header
// used across every customer-facing page.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'http://localhost:4790';
const PNG_PATH = path.join(__dirname, 'test-artwork.png');

async function adminLogin() {
  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  assert(loginResp.ok, 'admin login succeeds');
  return loginResp.headers.get('set-cookie');
}

async function main() {
  console.log('=== BRANDING (APP NAME + LOGO) ===');
  const cookie = await adminLogin();

  // ---- 1) default state: no logo, default business name ----
  const infoBefore = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.strictEqual(infoBefore.logoUrl, null, 'business-info reports no logo by default (text-only wordmark)');
  const originalName = infoBefore.businessName;
  assert(originalName, 'business-info reports a business name');
  console.log(`  ok: default branding state has no logo and business name "${originalName}"`);

  // ---- 2) branding routes require admin auth ----
  const unauthResp = await fetch(`${BASE}/api/admin/branding/logo`, { method: 'DELETE' });
  assert.strictEqual(unauthResp.status, 401, 'branding logo route requires admin auth');
  console.log('  ok: branding logo routes require admin auth');

  // ---- 3) uploading a logo sets logo_url, reflected on business-info ----
  const pngBuffer = fs.readFileSync(PNG_PATH);
  const fd = new FormData();
  fd.append('logo', new Blob([pngBuffer], { type: 'image/png' }), 'logo.png');
  const uploadResp = await fetch(`${BASE}/api/admin/branding/logo`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
  const uploadBody = await uploadResp.json();
  assert(uploadResp.ok && uploadBody.logoUrl, `logo upload succeeds and returns a URL (got: ${JSON.stringify(uploadBody)})`);
  const infoWithLogo = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.strictEqual(infoWithLogo.logoUrl, uploadBody.logoUrl, 'business-info reflects the newly uploaded logo URL');
  console.log(`  ok: logo upload succeeds and is immediately reflected on /api/business-info (${uploadBody.logoUrl})`);

  // ---- 4) business name is editable via the generic settings route ----
  const nameResp = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ business_name: 'Test Branding Co' }),
  });
  assert(nameResp.ok, 'business name updates successfully');
  const infoWithName = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.strictEqual(infoWithName.businessName, 'Test Branding Co', 'business-info reflects the updated business name');
  console.log('  ok: business name updates and is immediately reflected on /api/business-info');

  // ==================================================================== BROWSER
  console.log('\n=== BROWSER: header reflects the uploaded logo + name ===');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });

  await page.goto(`${BASE}/`);
  await page.waitForSelector('#siteLogoText');
  await page.waitForTimeout(400); // let brand-header.js's fetch resolve
  const logoText = await page.locator('#siteLogoText').textContent();
  assert.strictEqual(logoText, 'TEST BRANDING CO', `builder header text updates to the new business name (got "${logoText}")`);
  const logoImgCount = await page.locator('header.site-header img').count();
  assert(logoImgCount >= 1, 'builder header shows an <img> logo in place of the dot once one is uploaded');
  console.log('  ok: order builder header shows both the updated business name and the uploaded logo image');

  // also check a second customer-facing page picks up the same branding (shared script, not a one-off)
  await page.goto(`${BASE}/terms.html`);
  await page.waitForSelector('#siteLogoText');
  await page.waitForTimeout(400);
  const termsLogoText = await page.locator('#siteLogoText').textContent();
  assert.strictEqual(termsLogoText, 'TEST BRANDING CO', 'terms.html header also reflects the branding change (shared brand-header.js)');
  console.log('  ok: branding is consistent across customer-facing pages via the shared brand-header.js script');

  await browser.close();

  // ---- 5) removing the logo reverts to the text-only wordmark ----
  const removeResp = await fetch(`${BASE}/api/admin/branding/logo`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert(removeResp.ok, 'removing the logo succeeds');
  const infoAfterRemove = await (await fetch(`${BASE}/api/business-info`)).json();
  assert.strictEqual(infoAfterRemove.logoUrl, null, 'business-info reports no logo again after removal');
  console.log('  ok: removing the logo reverts business-info back to the text-only wordmark');

  // revert business name so future runs/screenshots stay on the real branding
  await fetch(`${BASE}/api/admin/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ business_name: originalName }),
  });

  console.log('\n=== ALL BRANDING CHECKS PASSED ===');
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
