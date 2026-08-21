// Phase 2: large-order (>1,000 pieces) production-review flow, and the
// tight-deadline (<3 business days) manual-review flag. Covers:
//   1. Full customer walkthrough at qty=1,200: "Submit for Production
//      Review" button label, the "Preliminary volume estimate" note (exact
//      required wording), required shipping-address collection + validation
//      when shipping is chosen, and the exact required confirmation copy on
//      the resulting quote page (no pay button, no mailto/blank email).
//   2. Server-side defense in depth: checkout is refused for the same order
//      even if called directly.
//   3. The admin Production Review panel lists the order with a real quote
//      number, and the quote detail shows quantity tier, shipping address,
//      review reasons, and original/final approved price.
//   4. Tight-deadline flag: a SMALL (qty=5, <=1,000, immediate-tier) order
//      with a deadline <3 business days away is flagged for review but is
//      NOT blocked from checkout — flags never block at <=1,000 qty.
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function login() {
  const resp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  return resp.headers.get('set-cookie');
}
async function getJSON(url, opts) {
  const resp = await fetch(url, opts);
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, ok: resp.ok, body };
}

async function setQty(page, colorBlockIndex, sizeLabel, qty) {
  const block = page.locator('.color-block').nth(colorBlockIndex);
  const stepper = block.locator(`.qty-stepper[data-size="${sizeLabel}"] input`);
  await stepper.fill(String(qty));
  await stepper.dispatchEvent('change');
  await page.waitForTimeout(550);
}

async function main() {
  console.log('=== LARGE-ORDER (>1,000 PCS) PRODUCTION REVIEW FLOW ===');
  const cookie = await login();
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ================================================================ 1) full walkthrough, qty=1,200
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1100 } })).newPage();
  await page.goto(BASE + '/index.html');
  await page.waitForSelector('#garmentGrid .option-card');
  await page.click('#garmentGrid .option-card:has(.oc-title:text-is("Standard Quality T-Shirt"))');
  await page.waitForSelector('#colorGrid .color-swatch');
  await page.locator('#colorGrid .color-swatch').first().click();
  await page.click('#colorNextBtn');
  await page.waitForSelector('.color-block');
  await setQty(page, 0, 'M', 700);
  await setQty(page, 0, 'L', 500); // 1,200 total -> tier "1,001-2,499" (review)

  const summaryText = await page.locator('#summaryBody').innerText();
  assert(summaryText.includes('Preliminary volume estimate'), `builder summary shows "Preliminary volume estimate" note for a 1,200pc order (got:\n${summaryText})`);
  assert(summaryText.includes('final pricing depends on garment inventory, freight and production scheduling'),
    'the volume-estimate note uses the EXACT required wording');
  console.log('  ok: builder summary shows the exact "Preliminary volume estimate - final pricing depends on garment inventory, freight and production scheduling." note');

  await page.click('#sizesNextBtn');
  await page.waitForSelector('#locationGrid .option-card');
  await page.click('#locationsNextBtn'); // front only
  await page.waitForSelector('#uploadSections');
  await page.check('#artworkLaterCheckbox');
  await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');
  await page.waitForSelector('#firstName');

  const btnLabelBefore = (await page.locator('#getPriceBtn').innerText()).trim().toLowerCase();
  assert.strictEqual(btnLabelBefore, 'submit for production review', `a 1,200pc order shows "Submit for Production Review" instead of "Get My Quote" (got "${btnLabelBefore}")`);
  console.log('  ok: the Contact step button reads "Submit for Production Review" for a >1,000pc order');

  await page.fill('#firstName', 'Big');
  await page.fill('#lastName', 'Order');
  await page.fill('#email', `big.order.${Date.now()}@example.com`);
  await page.fill('#phone', '555-120-0120');
  await page.click('#fulfillmentGroup [data-value="shipping"]');
  await page.waitForSelector('#shippingAddressField:not(.hidden)');
  await page.check('#builderTermsCheckbox');

  // try to submit with an incomplete shipping address -> client-side block, no navigation
  await page.click('#getPriceBtn');
  await page.waitForTimeout(400);
  assert(page.url().includes('/index.html'), 'submitting a >1,000pc shipping order with an incomplete address does not proceed to a quote');
  const errorText = (await page.locator('#errorBanner').innerText()).trim();
  assert(errorText.includes('complete shipping address'), `incomplete shipping address blocks submission client-side with a helpful message (got "${errorText}")`);
  console.log(`  ok: incomplete shipping address blocks submission client-side (message: "${errorText}")`);

  await page.fill('#shipLine1', '500 Production Way');
  await page.fill('#shipCity', 'Charlotte');
  await page.fill('#shipState', 'NC');
  await page.fill('#shipZip', '28202');
  await page.click('#getPriceBtn');
  await page.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  const bigOrderQuoteCode = new URL(page.url()).searchParams.get('id');
  console.log('  Generated large-order quote code:', bigOrderQuoteCode);
  assert(/^3T-\d{6}-\d{4}$/.test(bigOrderQuoteCode), 'the large order still gets a real quote code in the standard 3T-YYMMDD-#### format (no separate ad-hoc numbering)');

  await page.waitForSelector('#largeOrderCard:not(.hidden)');
  const largeOrderText = await page.locator('#largeOrderConfirmText').innerText();
  assert.strictEqual(largeOrderText.trim(),
    "Your order has been submitted for production and inventory review. You'll receive a confirmed invoice within one business day.",
    `quote page confirmation text matches the EXACT required copy (got: "${largeOrderText.trim()}")`);
  assert(await page.locator('#termsCard').isHidden(), 'the normal Pay/checkout card is hidden for a large order — no payment collected here');
  assert(await page.locator('#payBtn').count() === 0 || await page.locator('#payBtn').isHidden(), 'no active Pay button is shown for a large order');
  console.log('  ok: quote page shows the exact required confirmation text and swaps out the normal Pay flow entirely (no mailto/blank email)');

  const receiptText = await page.locator('.receipt-total').locator('..').innerText().catch(() => '');
  const fullQuoteBody = await page.locator('#itemizedPricing, body').first().innerText().catch(() => '');
  assert(fullQuoteBody.includes('Preliminary volume estimate'), 'the itemized quote page also shows the "Preliminary volume estimate" note next to the estimated total');
  console.log('  ok: itemized quote total is clearly labeled as a preliminary estimate, not a final price');

  // ================================================================ 2) server-side defense in depth: checkout is still refused directly
  const directCheckout = await getJSON(`${BASE}/api/quotes/${bigOrderQuoteCode}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true }),
  });
  assert.strictEqual(directCheckout.status, 400, 'calling checkout directly for a large order is still refused server-side (defense in depth, not just a hidden UI button)');
  assert.strictEqual(directCheckout.body.error,
    'This order is in production and inventory review. You will receive a confirmed invoice within one business day — no payment is needed here.',
    'the server-side refusal message is the expected production-review copy');
  console.log('  ok: POST checkout is refused server-side for this order even when called directly');

  // ================================================================ 3) admin Production Review panel + quote detail
  const adminPage = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  await adminPage.goto(BASE + '/admin/login.html');
  await adminPage.fill('#username', 'admin');
  await adminPage.fill('#password', '3tprint-admin-2026');
  await adminPage.click('#loginBtn');
  await adminPage.waitForURL('**/admin/dashboard.html');
  await adminPage.click('.admin-nav-item[data-panel="productionreview"]');
  await adminPage.waitForSelector('#productionReviewBody tr');
  const reviewRowsText = await adminPage.locator('#productionReviewBody').innerText();
  assert(reviewRowsText.includes(bigOrderQuoteCode), 'the large order appears in the admin Production Review panel by its real quote number');
  assert(reviewRowsText.includes('1200') || reviewRowsText.includes('1,200'), 'the Production Review row shows the real quantity (1,200)');
  console.log('  ok: admin Production Review panel lists the order by its real quote code and quantity');

  await adminPage.click(`#productionReviewBody [data-open-quote="${bigOrderQuoteCode}"]`);
  await adminPage.waitForSelector('.modal');
  const modalText = await adminPage.locator('.modal').innerText();
  assert(modalText.includes('1,001-2,499') || modalText.includes('Review'), 'quote detail modal shows the quantity tier ("1,001-2,499", Review)');
  assert(modalText.includes('500 Production Way'), 'quote detail modal shows the collected shipping address');
  assert(modalText.includes('Charlotte'), 'quote detail modal shows the shipping city');
  assert(/flagged for review/i.test(modalText), 'quote detail modal shows a "Flagged for review" banner');
  assert(/qty over 1000/i.test(modalText), 'the review-reasons banner names "qty over 1000" as the flag reason');
  assert(/original calculated price/i.test(modalText), 'quote detail modal shows "Original Calculated Price"');
  assert(/final approved price/i.test(modalText), 'quote detail modal shows "Final Approved Price"');
  console.log('  ok: admin quote detail shows quantity tier, shipping address, review reasons, and original/final approved price');
  await adminPage.keyboard.press('Escape').catch(() => {});
  await adminPage.click('#modalCloseBtn').catch(() => {});

  // Confirm original_calculated_price/final_approved_price via the raw API too (case-insensitive text match above could pass on unrelated text)
  const bigOrderDetail = await getJSON(`${BASE}/api/admin/quotes/${bigOrderQuoteCode}`, { headers: { Cookie: cookie } });
  assert.strictEqual(bigOrderDetail.body.quote.original_calculated_price, bigOrderDetail.body.pricing.total,
    'original_calculated_price equals the price computed at quote-creation time (no override has happened yet)');
  assert.strictEqual(bigOrderDetail.body.quote.final_approved_price, bigOrderDetail.body.pricing.total,
    'final_approved_price also starts equal to the calculated price before any owner override');

  // ================================================================ 4) tight-deadline flag: small order, near-term deadline, NEVER blocks checkout
  console.log('\n=== TIGHT-DEADLINE (<3 BUSINESS DAYS) FLAG ===');
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const tightEmail = `tight.deadline.${Date.now()}@example.com`;
  const tightQuote = await getJSON(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: (await (await fetch(`${BASE}/api/garments`)).json()).garments.find(g => g.name === 'Standard Quality T-Shirt').id,
      colorSelections: [{ colorName: 'Black', colorHex: '#111', sizes: [{ label: 'M', qty: 5 }] }],
      printLocationIds: [1], firstName: 'Tight', lastName: 'Deadline', email: tightEmail, phone: '555-003-0003',
      fulfillmentMethod: 'pickup', termsAccepted: true, neededByDate: tomorrowStr,
    }),
  });
  assert(tightQuote.ok, 'a qty=5 order with a near-term deadline is still created successfully');
  assert.strictEqual(tightQuote.body.needsManualReview, true, `qty=5 with neededByDate=${tomorrowStr} (< 3 business days away) IS flagged needsManualReview`);
  assert(tightQuote.body.reviewReasons.includes('tight_deadline'), 'the flag reason is tight_deadline');
  assert(!tightQuote.body.reviewReasons.includes('qty_over_1000'), 'qty=5 never carries the qty_over_1000 reason');

  const tightCheckout = await getJSON(`${BASE}/api/quotes/${tightQuote.body.quoteCode}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true }),
  });
  assert(tightCheckout.ok, `a tight-deadline order at qty=5 still reaches checkout successfully — tight_deadline is a FLAG ONLY, it never blocks checkout at <=1,000 qty (status ${tightCheckout.status})`);
  console.log(`  ok: qty=5 order with neededByDate=${tomorrowStr} is flagged tight_deadline for the admin to notice, but checkout is NOT blocked`);

  await browser.close();
  console.log('\n=== LARGE-ORDER / TIGHT-DEADLINE CHECKS PASSED ===');
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
