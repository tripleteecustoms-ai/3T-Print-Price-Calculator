// Phase 1 checks for:
//  1. The mailto: bulk-quote handoff was replaced with a real structured
//     POST /api/bulk-quote-requests, stored in the DB and surfaced to admins.
//  2. A customer can no longer silently skip the Artwork step — they must
//     either upload a file or explicitly check "I'll send artwork later"
//     (which flags artwork_pending=1 on the resulting quote, filterable by
//     admins).
//  3. The builder's real terms checkbox at quote-generation time is required
//     server-side (termsAccepted is no longer hardcoded true client-side).
//
// PHASE 2 NOTE: the 24-piece "bulk quote" cutoff this file originally tested
// against no longer exists — it was replaced by the 12-tier quantity model
// (server/pricingEngine.js, server/seed.js migration notes). qty=30 now
// falls in tier "25-49" (checkoutBehavior: immediate), not a bulk-quote
// trigger. The old #bulkQuoteForm/#bulkName/#bulkEmail/... UI and the admin
// "Bulk Requests" dashboard tab were both removed (dashboard.html now has a
// "Production Review" tab instead, driven by real quotes with
// needs_manual_review=1, not this legacy table).
//
// The bulk_quote_requests table + its API routes (POST /api/bulk-quote-
// requests, GET/PATCH /api/admin/bulk-quote-requests) were deliberately left
// in place (deprecated, not deleted — see server/db.js) since nothing forces
// their removal and deleting working, still-reachable API surface isn't
// necessary just because the UI that used to call it is gone. Section 1
// below still exercises that legacy API directly to prove it hasn't broken.
// Section 2 (previously a full UI walkthrough of the old bulk-quote form and
// its admin tab) is rewritten to instead prove the NEW behavior at the same
// qty=30: no bulk/review banner, normal "Get My Quote" checkout, and that
// the old bulk-quote UI elements are gone from the DOM. The real large-order
// (qty>1000) UI flow — shipping address collection, "Submit for Production
// Review", the exact confirmation copy, and the admin Production Review
// panel — is covered end-to-end in test-quantity-tiers.js instead.
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');

const BASE = 'http://localhost:4790';
const PNG_PATH = path.join(__dirname, 'test-artwork.png');

async function login() {
  const resp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  return resp.headers.get('set-cookie');
}

async function setQty(page, colorBlockIndex, sizeLabel, qty) {
  const block = page.locator('.color-block').nth(colorBlockIndex);
  const stepper = block.locator(`.qty-stepper[data-size="${sizeLabel}"] input`);
  await stepper.fill(String(qty));
  await stepper.dispatchEvent('change');
  await page.waitForTimeout(550); // past the ~300ms qty-input debounce
}

async function main() {
  console.log('=== BULK QUOTE REQUESTS + ARTWORK GATE + REAL TERMS CHECKBOX ===');
  const cookie = await login();

  // ================================================================ 1) BULK QUOTE REQUESTS API
  const badReq = await fetch(`${BASE}/api/bulk-quote-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', email: '' }),
  });
  assert.strictEqual(badReq.status, 400, 'bulk quote request without name/email is rejected (400)');

  const goodReq = await fetch(`${BASE}/api/bulk-quote-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Big Order Bob', email: 'bob@example.com', phone: '555-000-1111', garmentName: 'Hoodie', approxQuantity: 250, notes: 'Need these by homecoming.' }),
  });
  assert(goodReq.ok, 'valid bulk quote request is accepted');
  const { id } = await goodReq.json();
  assert(id, 'bulk quote request returns an id');

  // unauthenticated admin list is rejected
  const unauthList = await fetch(`${BASE}/api/admin/bulk-quote-requests`);
  assert.strictEqual(unauthList.status, 401, 'admin bulk-quote-requests list requires auth');

  const adminList = await (await fetch(`${BASE}/api/admin/bulk-quote-requests`, { headers: { Cookie: cookie } })).json();
  const found = adminList.bulkQuoteRequests.find(r => r.id === id);
  assert(found, 'the submitted bulk quote request appears in the admin list');
  assert.strictEqual(found.name, 'Big Order Bob', 'admin list shows the submitted name');
  assert.strictEqual(found.email, 'bob@example.com', 'admin list shows the submitted email');
  assert.strictEqual(found.approx_quantity, 250, 'admin list shows the approx quantity');
  assert.strictEqual(found.status, 'new', 'new bulk quote requests default to status "new"');
  console.log('  ok: POST /api/bulk-quote-requests stores the lead and it is visible to admins (no mailto: involved)');

  const statusUpdate = await fetch(`${BASE}/api/admin/bulk-quote-requests/${id}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ status: 'contacted' }),
  });
  assert(statusUpdate.ok, 'admin can update a bulk quote request status');
  console.log('  ok: admin can mark a bulk quote request as contacted/closed');

  // ================================================================ 2) qty=30 (old bulk-cutoff qty) now flows through normal checkout
  // Each flow below uses its own fresh browser context (its own clean
  // sessionStorage) rather than clearing/reloading one shared page — simpler
  // and avoids any timing dependence on when a reload's async init() finishes.
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE + '/index.html');
  await page.waitForSelector('#garmentGrid .option-card');
  await page.click('#garmentGrid .option-card');
  await page.waitForSelector('#colorGrid .color-swatch');
  await page.locator('#colorGrid .color-swatch').first().click();
  await page.click('#colorNextBtn');
  await page.waitForSelector('.color-block');
  await setQty(page, 0, 'XL', 30); // over the OLD 24pc cap, but well under the new 1,000pc review threshold (tier "25-49")
  assert(await page.locator('#bulkBanner').isHidden(), 'qty=30 (tier 25-49, immediate checkout) shows no bulk/review banner — the old 24pc cutoff no longer applies');
  assert(await page.locator('#bulkQuoteBtn').count() === 0, 'the old mailto: "Get a Bulk Quote" link is gone');
  assert(await page.locator('#bulkQuoteForm').count() === 0, 'the old structured bulk-quote form is gone from the DOM (superseded by the >1,000pc production-review flow)');
  console.log('  ok: qty=30 no longer triggers any bulk-quote UI — it is an ordinary immediate-checkout tier');

  await page.click('#sizesNextBtn');
  await page.waitForSelector('#locationGrid .option-card');
  await page.click('#locationsNextBtn');
  await page.waitForSelector('#uploadSections');
  await page.check('#artworkLaterCheckbox');
  await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');
  await page.waitForSelector('#firstName');
  await page.fill('#firstName', 'Thirty');
  await page.fill('#lastName', 'Pieces');
  await page.fill('#email', 'thirty.pieces@example.com');
  await page.fill('#phone', '555-030-0030');
  await page.check('#builderTermsCheckbox');
  const getPriceLabel = (await page.locator('#getPriceBtn').innerText()).trim().toLowerCase();
  assert.strictEqual(getPriceLabel, 'get my quote', 'qty=30 keeps the normal "Get My Quote" button label — not "Submit for Production Review"');
  await page.click('#getPriceBtn');
  await page.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  console.log('  ok: qty=30 reaches a normal quote page through the standard immediate-checkout path');

  // ---- and the old admin "Bulk Requests" tab is gone, replaced by "Production Review" ----
  const adminPage = await (await browser.newContext()).newPage();
  adminPage.on('pageerror', e => console.log('  [admin pageerror]', e.message));
  await adminPage.goto(BASE + '/admin/login.html');
  await adminPage.fill('#username', 'admin');
  await adminPage.fill('#password', '3tprint-admin-2026');
  await adminPage.click('#loginBtn');
  await adminPage.waitForURL('**/admin/dashboard.html');
  assert(await adminPage.locator('.admin-nav-item[data-panel="bulkrequests"]').count() === 0, 'the old "Bulk Requests" nav tab is gone');
  assert(await adminPage.locator('.admin-nav-item[data-panel="productionreview"]').count() === 1, 'a "Production Review" nav tab exists in its place');
  await adminPage.click('.admin-nav-item[data-panel="productionreview"]');
  await adminPage.waitForSelector('#productionReviewBody');
  console.log('  ok: admin dashboard has a "Production Review" tab (Bulk Requests tab removed) — see test-quantity-tiers.js for its full content test');
  await adminPage.close();

  // ================================================================ 3) ARTWORK STEP GATE + REAL TERMS CHECKBOX
  const page2 = await (await browser.newContext()).newPage();
  await page2.goto(BASE + '/index.html');
  await page2.waitForSelector('#garmentGrid .option-card');
  await page2.click('#garmentGrid .option-card');
  await page2.waitForSelector('#colorGrid .color-swatch');
  await page2.locator('#colorGrid .color-swatch').first().click();
  await page2.click('#colorNextBtn');
  await page2.waitForSelector('.color-block');
  await setQty(page2, 0, 'M', 5);
  await page2.click('#sizesNextBtn');
  await page2.waitForSelector('#locationGrid .option-card');
  await page2.click('#locationsNextBtn');
  await page2.waitForSelector('#uploadSections');

  assert(await page2.locator('#artworkNextBtn').isDisabled(), 'artwork Continue is disabled before any choice is made');
  assert(await page2.locator('#artworkLaterCheckbox').count() === 1, '"I\'ll send artwork later" checkbox exists on the artwork step');

  await page2.check('#artworkLaterCheckbox');
  assert(await page2.locator('#artworkNextBtn').isEnabled(), 'checking "send later" enables Continue');
  await page2.uncheck('#artworkLaterCheckbox');
  assert(await page2.locator('#artworkNextBtn').isDisabled(), 'unchecking it disables Continue again (no upload present)');

  const fileInput = page2.locator('#uploadSections input[type="file"]').first();
  await fileInput.setInputFiles(PNG_PATH);
  await page2.waitForSelector('.file-chip');
  assert(await page2.locator('#artworkNextBtn').isEnabled(), 'uploading a file also enables Continue (either path works)');
  await page2.click('.builder-step[data-step="artwork"] [data-nav="next"]');

  await page2.waitForSelector('#firstName');
  await page2.fill('#firstName', 'Gate');
  await page2.fill('#lastName', 'Test');
  await page2.fill('#email', 'gate.test@example.com');
  await page2.fill('#phone', '555-777-6666');

  assert(await page2.locator('#getPriceBtn').isDisabled(), 'Get My Quote is disabled until the real terms checkbox is checked');
  assert(await page2.locator('#builderTermsCheckbox').count() === 1, 'a real terms checkbox (not hardcoded) exists on the contact step');
  await page2.check('#builderTermsCheckbox');
  assert(await page2.locator('#getPriceBtn').isEnabled(), 'checking terms enables Get My Quote');
  // .btn is styled text-transform:uppercase, so compare case-insensitively
  const priceBtnLabel = (await page2.locator('#getPriceBtn').innerText()).trim().toLowerCase();
  assert.strictEqual(priceBtnLabel, 'get my quote', 'button label reflects what it actually does (not "Calculate Total")');

  await page2.click('#getPriceBtn');
  await page2.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  console.log('  ok: quote generation is blocked until terms are explicitly accepted, and the button is honestly labeled');

  // server-side: rejecting termsAccepted:false directly against the API too
  const noTermsResp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: 1, colorSelections: [{ colorName: 'Black', colorHex: '#111', sizes: [{ label: 'M', qty: 2 }] }],
      printLocationIds: [1], firstName: 'No', lastName: 'Terms', email: 'no.terms@example.com', phone: '555-111-2222',
      fulfillmentMethod: 'pickup', termsAccepted: false,
    }),
  });
  assert.strictEqual(noTermsResp.status, 400, 'server rejects quote creation when termsAccepted is false, independent of the client');
  console.log('  ok: server independently enforces termsAccepted (not just a client-side gate)');

  // ================================================================ 4) artwork_pending flag round-trip
  const page3 = await (await browser.newContext()).newPage();
  await page3.goto(BASE + '/index.html');
  await page3.waitForSelector('#garmentGrid .option-card');
  await page3.click('#garmentGrid .option-card');
  await page3.waitForSelector('#colorGrid .color-swatch');
  await page3.locator('#colorGrid .color-swatch').first().click();
  await page3.click('#colorNextBtn');
  await page3.waitForSelector('.color-block');
  await setQty(page3, 0, 'L', 3);
  await page3.click('#sizesNextBtn');
  await page3.waitForSelector('#locationGrid .option-card');
  await page3.click('#locationsNextBtn');
  await page3.waitForSelector('#uploadSections');
  await page3.check('#artworkLaterCheckbox');
  await page3.click('.builder-step[data-step="artwork"] [data-nav="next"]');
  await page3.waitForSelector('#firstName');
  await page3.fill('#firstName', 'Later');
  await page3.fill('#lastName', 'Artwork');
  await page3.fill('#email', 'later.artwork@example.com');
  await page3.fill('#phone', '555-333-4444');
  await page3.check('#builderTermsCheckbox');
  await page3.click('#getPriceBtn');
  await page3.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  const pendingQuoteCode = new URL(page3.url()).searchParams.get('id');

  const filteredList = await (await fetch(`${BASE}/api/admin/quotes?artworkPending=1`, { headers: { Cookie: cookie } })).json();
  const pendingRow = filteredList.quotes.find(q => q.quoteCode === pendingQuoteCode);
  assert(pendingRow, 'the "send artwork later" quote shows up under the admin artworkPending=1 filter');
  assert.strictEqual(pendingRow.artworkPending, true, 'admin quote row reports artworkPending: true');

  const unfilteredHasIt = (await (await fetch(`${BASE}/api/admin/quotes`, { headers: { Cookie: cookie } })).json())
    .quotes.some(q => q.quoteCode === pendingQuoteCode);
  assert(unfilteredHasIt, 'the same quote also appears in the unfiltered list');
  console.log('  ok: "send artwork later" sets artwork_pending on the quote, filterable by admins for follow-up');

  await browser.close();
  console.log('\n=== BULK QUOTE / ARTWORK GATE / TERMS CHECKS PASSED ===');
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
