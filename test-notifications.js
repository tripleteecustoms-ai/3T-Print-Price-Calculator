// Focused check for the notifications + admin-UI feature round:
//  1. Clicking "Pay & Place Order" emails the itemized quote (even before payment completes).
//  2. Changing an order's status in admin sends a matching customer email.
//  3. The paid mock-checkout flow sends a "thank you" email.
//  4. Admin quote detail shows color swatches (dot + name as its own row) and
//     artwork that's clickable (opens full-size) + explicitly downloadable.
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');

const BASE = 'http://localhost:4790';
const ARTWORK = path.join(__dirname, 'test-artwork.png');

async function setQty(page, colorBlockIndex, sizeLabel, qty) {
  const block = page.locator('.color-block').nth(colorBlockIndex);
  const stepper = block.locator(`.qty-stepper[data-size="${sizeLabel}"] input`);
  await stepper.fill(String(qty));
  await stepper.dispatchEvent('change');
}

(async () => {
  const fs = require('fs');
  if (!fs.existsSync(ARTWORK)) {
    // 1x1 PNG, same trick used elsewhere in this project's tests
    fs.writeFileSync(ARTWORK, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  }

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  console.log('=== ORDER STATUS / PAY-CLICK EMAIL + ADMIN UI CHECKS ===');

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text()); });

  await page.goto(BASE + '/index.html');
  await page.waitForSelector('#garmentGrid .option-card');
  await page.click('#garmentGrid .option-card');
  await page.waitForSelector('#colorGrid .color-swatch');
  await page.locator('#colorGrid .color-swatch').nth(3).click(); // pick a non-black/white color so the swatch check is meaningful
  await page.click('#colorNextBtn');
  await page.waitForSelector('.color-block');
  await setQty(page, 0, 'L', 6);
  await page.waitForTimeout(300);
  await page.click('#sizesNextBtn');
  await page.waitForSelector('#locationGrid .option-card');
  await page.locator('#locationGrid .option-card').first().click();
  await page.click('#locationsNextBtn');
  await page.waitForSelector('#uploadSections');
  const fileInput = page.locator('#uploadSections input[type="file"]').first();
  await fileInput.setInputFiles(ARTWORK);
  await page.waitForTimeout(500);
  await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');

  await page.waitForSelector('#firstName');
  await page.fill('#firstName', 'Notif');
  await page.fill('#lastName', 'Test');
  await page.fill('#email', 'notif.test@example.com');
  await page.fill('#phone', '555-222-3333');
  await page.click('#getPriceBtn');
  await page.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  const quoteCode = new URL(page.url()).searchParams.get('id');
  console.log('  Generated quote code:', quoteCode);

  // ---- Click Pay & Place Order (without finishing payment) and confirm the itemized quote email fires ----
  await page.check('#termsCheckbox');
  await page.click('#payBtn');
  await page.waitForURL('**/checkout-mock.html*', { timeout: 10000 });
  console.log('  ok: reached mock checkout after clicking Pay & Place Order (payment not yet completed)');

  // ---- Admin: log in, open the quote, check color swatch + artwork link UI ----
  const actx = await browser.newContext();
  const apage = await actx.newPage();
  await apage.goto(BASE + '/admin/login.html');
  await apage.fill('#username', 'admin');
  await apage.fill('#password', '3tprint-admin-2026');
  await apage.click('#loginBtn');
  await apage.waitForURL('**/admin/dashboard.html', { timeout: 10000 });

  await apage.click('[data-panel="quotes"]');
  await apage.waitForSelector('#quotesBody tr');
  await apage.click(`#quotesBody [data-open-quote="${quoteCode}"]`);
  await apage.waitForSelector('.modal');

  // Color swatch: a colored dot rendered as its own row, next to the color name
  const swatch = apage.locator('.color-breakdown-row span').first();
  const swatchBg = await swatch.evaluate(el => getComputedStyle(el).backgroundColor);
  assert(swatchBg && swatchBg !== 'rgba(0, 0, 0, 0)' && swatchBg !== 'transparent', `color swatch dot renders with an actual background color (got ${swatchBg})`);
  console.log('  ok: color breakdown shows a swatch dot with color', swatchBg);
  const colorRowText = await apage.locator('.color-breakdown-row').first().innerText();
  assert(/L/.test(colorRowText) && /6/.test(colorRowText), 'color row still shows the correct size/qty breakdown next to the swatch');

  // Artwork: thumbnail + filename should be links (view full-size), plus an explicit Download link
  const thumbLink = apage.locator('.print-detail-row a img.thumb-40').first();
  assert(await thumbLink.count() > 0, 'artwork thumbnail is wrapped in a clickable link to the full-size file');
  const thumbHref = await apage.locator('.print-detail-row a:has(img.thumb-40)').first().getAttribute('href');
  assert(thumbHref && thumbHref.includes('/uploads/'), `thumbnail link points at the uploaded file (${thumbHref})`);
  const downloadLink = apage.locator('.pd-file a[download]').first();
  assert(await downloadLink.count() > 0, 'artwork row has an explicit Download link with the download attribute set');
  console.log('  ok: artwork thumbnail + filename are clickable, and a Download link is present');

  // ---- Status change -> customer email ----
  await apage.selectOption('#statusSelect', 'approved');
  await apage.click('#applyStatusBtn');
  await apage.waitForSelector('.modal .badge:has-text("approved")', { timeout: 8000 });
  console.log('  ok: status changed to approved in admin');

  await apage.keyboard.press('Escape').catch(() => {});
  await apage.click('#modalCloseBtn').catch(() => {});
  await apage.click('[data-panel="settings"]');
  await apage.waitForSelector('#settingBusinessName');
  await apage.click('[data-tab="email"]');
  await apage.waitForTimeout(300);
  const emailLogText = await apage.locator('#emailsBody').innerText();
  assert(emailLogText.includes('Your order has been approved'), 'status-change email ("approved") shows up in the email log');
  assert(emailLogText.includes(`Your 3T Print Solutions Quote - #${quoteCode}`), 'the checkout-click itemized quote email also shows up in the log');
  console.log('  ok: both the pay-click quote email and the approved-status email are logged');

  // ---- Complete mock payment -> "thank you" paid email ----
  await page.click('#payBtn'); // checkout-mock.html's own confirm button
  await page.waitForURL('**/order-received.html*', { timeout: 10000 });
  console.log('  ok: mock payment completed');

  await apage.reload();
  await apage.click('[data-panel="settings"]');
  await apage.waitForSelector('#settingBusinessName');
  await apage.click('[data-tab="email"]');
  await apage.waitForTimeout(300);
  const emailLogAfterPaid = await apage.locator('#emailsBody').innerText();
  assert(emailLogAfterPaid.includes('Thank you for your order!'), 'paid confirmation email ("Thank you for your order!") shows up after mock payment completes');
  console.log('  ok: paid confirmation email logged after mock payment');

  await browser.close();
  console.log('\n=== NOTIFICATIONS / ADMIN UI CHECKS PASSED ===');
})().catch(err => { console.error('FAIL:', err); process.exit(1); });
