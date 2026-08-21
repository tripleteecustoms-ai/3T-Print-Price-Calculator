// Verifies the app is safe to embed via <iframe> on another website:
//  1. The server sends no X-Frame-Options / frame-ancestors header that
//     would block a third-party site from framing it at all.
//  2. Clicking "Pay & Place Order" while embedded navigates the TOP-LEVEL
//     browser tab (escaping the iframe) rather than trying to load the
//     payment provider's checkout page inside the nested frame — most real
//     payment pages (Shopify included) refuse to render inside someone
//     else's iframe, so without this the embedded Pay step would look broken.
const { chromium } = require('playwright');
const assert = require('assert');
const http = require('http');

const BASE = 'http://localhost:4790';
const HOST_PORT = 4795;

async function setQty(page, colorBlockIndex, sizeLabel, qty) {
  const block = page.locator('.color-block').nth(colorBlockIndex);
  const stepper = block.locator(`.qty-stepper[data-size="${sizeLabel}"] input`);
  await stepper.fill(String(qty));
  await stepper.dispatchEvent('change');
}

(async () => {
  console.log('=== EMBEDDABILITY CHECKS ===');

  // 1) No frame-blocking response headers.
  const resp = await fetch(BASE + '/index.html');
  const xfo = resp.headers.get('x-frame-options');
  const csp = resp.headers.get('content-security-policy');
  assert(!xfo, `no X-Frame-Options header blocking iframe embedding (got "${xfo}")`);
  assert(!csp || !csp.includes('frame-ancestors'), `no frame-ancestors CSP directive blocking embedding (got "${csp}")`);
  console.log('  ok: server sends no headers that would block third-party iframe embedding');

  // 2) Build a wrapper page that embeds the builder in an iframe, exactly
  // like a real site would (served from its own real HTTP origin — not
  // about:blank/data: — so this matches how an actual host site behaves).
  const wrapperHtml = `<!doctype html><html><body style="margin:0;">
    <h1>Host Site (simulated)</h1>
    <iframe id="orderFrame" src="${BASE}/index.html" style="width:100%;height:900px;border:2px solid red;"></iframe>
  </body></html>`;
  const hostServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(wrapperHtml);
  });
  await new Promise(resolve => hostServer.listen(HOST_PORT, resolve));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${HOST_PORT}/`, { waitUntil: 'load' });
  const frame = page.frames().find(f => f.url().includes('/index.html'));
  assert(frame, 'the embedded iframe loaded the order builder');

  await frame.waitForSelector('#garmentGrid .option-card');
  await frame.click('#garmentGrid .option-card');
  await frame.waitForSelector('#colorGrid .color-swatch');
  await frame.locator('#colorGrid .color-swatch').first().click();
  await frame.click('#colorNextBtn');
  await frame.waitForSelector('.color-block');
  await setQty(frame, 0, 'M', 4);
  await frame.waitForTimeout(550); // past the ~300ms qty-input debounce (builder.js onSizesChanged)
  await frame.click('#sizesNextBtn');
  await frame.waitForSelector('#locationGrid .option-card');
  await frame.locator('#locationGrid .option-card').first().click();
  await frame.click('#locationsNextBtn');
  await frame.waitForSelector('#uploadSections');
  await frame.check('#artworkLaterCheckbox'); // no file on hand — explicit "send later" path
  await frame.click('.builder-step[data-step="artwork"] [data-nav="next"]');
  await frame.waitForSelector('#firstName');
  await frame.fill('#firstName', 'Embed');
  await frame.fill('#lastName', 'Test');
  await frame.fill('#email', 'embed.test@example.com');
  await frame.fill('#phone', '555-444-5555');
  await frame.check('#builderTermsCheckbox');
  await frame.click('#getPriceBtn');
  await frame.waitForURL('**/quote.html?id=*', { timeout: 15000 });
  console.log('  ok: full order flow works normally while running inside an iframe');

  await frame.check('#termsCheckbox');

  // Track top-level navigation vs. the iframe staying put.
  const topNavigation = page.waitForURL('**/checkout-mock.html*', { timeout: 10000 });
  await frame.click('#payBtn');
  await topNavigation;

  assert(page.url().includes('checkout-mock.html'), 'clicking Pay navigates the TOP-LEVEL tab to the checkout page (escapes the iframe)');
  const stillHasWrapperMarkup = await page.locator('h1:has-text("Host Site (simulated)")').count();
  assert(stillHasWrapperMarkup === 0, 'the host site wrapper is gone — this was a real top-level navigation, not a same-page trick');
  console.log('  ok: Pay & Place Order breaks out of the iframe to the full browser tab (would work the same way for a real Shopify checkout URL)');

  await browser.close();
  hostServer.close();
  console.log('\n=== EMBEDDABILITY CHECKS PASSED ===');
})().catch(err => { console.error('FAIL:', err); process.exit(1); });
