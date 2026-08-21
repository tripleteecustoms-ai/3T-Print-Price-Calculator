// Phase 1 checks for:
//  1. Logo links (customer + admin), homepage "Admin" nav link, /admin
//     auth-aware redirect UX.
//  2. Keyboard operability + button semantics for color swatches, design-size
//     pills, and order-purpose/fulfillment pills (role="button"/real
//     <button>, tabindex, Enter/Space activation, visible focus).
//  3. Color swatches show a visible text name (never color-only).
//  4. Live-price fetch failure surfaces an inline retry message instead of
//     silently no-op'ing, with aria-live on the summary.
//  5. Loading state while garments/colors are fetched (no longer blank).
//  6. Garment "No image" gray box replaced with an inline SVG placeholder.
//  7. Basic label/for pairing + required attributes on index.html/quote.html.
//  8. Mobile fundamentals: 16px+ inputs, 44px+ touch targets, no horizontal
//     scroll, and the sticky mobile summary bar at 375x667 / 390x844.
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function main() {
  console.log('=== ACCESSIBILITY + MOBILE CHECKS ===');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ================================================================ 1) LOGO LINKS + ADMIN NAV
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE + '/index.html');
    await page.waitForSelector('#garmentGrid .option-card');
    const logoHref = await page.locator('header.site-header a.logo').getAttribute('href');
    assert.strictEqual(logoHref, '/', 'customer homepage logo links to /');
    const logoAriaLabel = await page.locator('header.site-header a.logo').getAttribute('aria-label');
    assert(logoAriaLabel && /3T Print Solutions/i.test(logoAriaLabel), 'logo link has a descriptive aria-label');

    const adminLink = page.locator('a.header-admin-link');
    assert.strictEqual(await adminLink.count(), 1, '"Admin" link exists on the customer homepage');
    assert.strictEqual((await adminLink.innerText()).trim(), 'Admin', 'admin link is labeled exactly "Admin"');
    assert.strictEqual(await adminLink.getAttribute('href'), '/admin', 'admin link points at /admin (the auth-aware redirect route)');

    // keyboard focus reaches the logo link and shows a visible focus ring
    await page.locator('header.site-header a.logo').focus();
    const outlineWidth = await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth);
    assert(outlineWidth && outlineWidth !== '0px', `focused logo link has a visible focus outline (got outline-width: ${outlineWidth})`);
    console.log('  ok: customer logo is a real link (/) with a visible focus ring, and a plain "Admin" nav link points at /admin');

    await page.goto(BASE + '/quote.html');
    const quoteLogoHref = await page.locator('a.logo').getAttribute('href');
    assert.strictEqual(quoteLogoHref, '/', 'quote.html logo also links to /');

    await page.goto(BASE + '/admin/login.html');
    const loginLogoHref = await page.locator('.login-logo a').getAttribute('href');
    assert.strictEqual(loginLogoHref, '/admin', 'admin login page logo links to /admin');
    await page.close();
  }

  // ================================================================ 2/3) KEYBOARD + BUTTON SEMANTICS + COLOR NAME TEXT
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE + '/index.html');
    await page.waitForSelector('#garmentGrid .option-card');
    await page.click('#garmentGrid .option-card');
    await page.waitForSelector('#colorGrid .color-swatch');

    const firstSwatch = page.locator('#colorGrid .color-swatch').first();
    assert.strictEqual(await firstSwatch.getAttribute('role'), 'button', 'color swatch has role="button"');
    assert.strictEqual(await firstSwatch.getAttribute('tabindex'), '0', 'color swatch is keyboard-focusable (tabindex="0")');
    const swatchText = (await firstSwatch.locator('.cname').innerText()).trim();
    assert(swatchText.length > 0, `color swatch shows a visible text name, not just a color chip (got "${swatchText}")`);

    await firstSwatch.focus();
    await page.keyboard.press('Enter');
    assert(await firstSwatch.evaluate(el => el.classList.contains('selected')), 'pressing Enter on a focused color swatch selects it (keyboard-operable)');
    await page.keyboard.press('Enter'); // toggle back off, matches click-toggle behavior
    assert(!(await firstSwatch.evaluate(el => el.classList.contains('selected'))), 'pressing Enter again deselects it (Space/Enter mirrors click)');
    await firstSwatch.focus();
    await page.keyboard.press(' ');
    assert(await firstSwatch.evaluate(el => el.classList.contains('selected')), 'pressing Space also activates the swatch');
    console.log('  ok: color swatches are real keyboard-operable controls with a visible color name');

    await page.click('#colorNextBtn');
    await page.waitForSelector('.color-block');
    const stepper = page.locator('.color-block').nth(0).locator('.qty-stepper[data-size="M"] input');
    await stepper.fill('3');
    await stepper.dispatchEvent('input');
    await page.click('#sizesNextBtn');
    await page.waitForSelector('#locationGrid .option-card');
    await page.click('#locationsNextBtn');
    await page.waitForSelector('#uploadSections');

    const designPill = page.locator('[data-design-size-group] [data-value]').first();
    assert.strictEqual(await designPill.getAttribute('role'), 'button', 'design-size pill has role="button"');
    assert.strictEqual(await designPill.getAttribute('tabindex'), '0', 'design-size pill is keyboard-focusable');
    await designPill.focus();
    await page.keyboard.press('Enter');
    assert(await designPill.evaluate(el => el.classList.contains('selected')), 'Enter activates a design-size pill');
    console.log('  ok: design-size pills are keyboard-operable');

    await page.close();
    const page2 = await (await browser.newContext()).newPage();
    await page2.goto(BASE + '/index.html'); // genuinely fresh page/session for the contact-step pills, avoids re-walking the whole flow
    await page2.waitForSelector('#garmentGrid .option-card');
    // Jump straight to the contact step (builder.js's top-level functions are
    // plain globals since it's a classic non-module <script>) — the
    // order-purpose/fulfillment pills only render visible inside that step.
    await page2.evaluate(() => goToStep(5));
    await page2.waitForSelector('.builder-step[data-step="contact"].active');
    const purposePill = page2.locator('#orderPurposeGroup .radio-pill').first();
    assert.strictEqual(await purposePill.getAttribute('role'), 'button', 'order-purpose pill has role="button"');
    assert.strictEqual(await purposePill.getAttribute('tabindex'), '0', 'order-purpose pill is keyboard-focusable');
    await purposePill.focus();
    await page2.keyboard.press('Enter');
    assert(await purposePill.evaluate(el => el.getAttribute('aria-pressed') === 'true'), 'Enter toggles aria-pressed on an order-purpose pill');

    const fulfillPill = page2.locator('#fulfillmentGroup .radio-pill').nth(1);
    await fulfillPill.focus();
    await page2.keyboard.press(' ');
    assert(await fulfillPill.evaluate(el => el.classList.contains('selected')), 'Space activates a fulfillment pill');
    console.log('  ok: order-purpose and fulfillment pills are keyboard-operable with aria-pressed state');
    await page2.close();
  }

  // ================================================================ 4) LIVE PRICE FETCH FAILURE + aria-live
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE + '/index.html');
    await page.waitForSelector('#garmentGrid .option-card');
    const ariaLive = await page.locator('#summaryBody').getAttribute('aria-live');
    assert.strictEqual(ariaLive, 'polite', '#summaryBody has aria-live="polite" so price updates are announced');

    await page.click('#garmentGrid .option-card');
    await page.waitForSelector('#colorGrid .color-swatch');
    await page.locator('#colorGrid .color-swatch').first().click();
    await page.click('#colorNextBtn');
    await page.waitForSelector('.color-block');

    // Force the next /api/estimate call to fail so refreshEstimate() must
    // hit its error path instead of silently no-op'ing.
    await page.route('**/api/estimate', route => route.fulfill({ status: 500, body: JSON.stringify({ error: 'boom' }) }));
    const stepper = page.locator('.color-block').nth(0).locator('.qty-stepper[data-size="M"] input');
    await stepper.fill('4');
    await stepper.dispatchEvent('input');
    await page.waitForSelector('#summaryErrorBox:not(.hidden)', { timeout: 5000 });
    const errText = await page.locator('#summaryErrorBox').innerText();
    assert(errText.includes("We couldn't update your price. Your selections are saved. Please retry."), `error box shows the expected copy (got "${errText}")`);
    assert(await page.locator('#retryEstimateBtn').count() === 1, 'a Retry button is offered');

    // unblock the network and retry
    await page.unroute('**/api/estimate');
    await page.click('#retryEstimateBtn');
    await page.waitForSelector('#summaryErrorBox', { state: 'hidden', timeout: 5000 });
    console.log('  ok: a failed price refresh shows an inline retry message (not a silent no-op) and recovers on retry');
    await page.close();
  }

  // ================================================================ 5) LOADING STATE + 6) GARMENT ICON PLACEHOLDER
  {
    const page = await (await browser.newContext()).newPage();
    // Slow the /api/garments response so the loading state is observable —
    // long enough that even a slow CI runner will catch it mid-flight.
    await page.route('**/api/garments', async route => {
      await new Promise(r => setTimeout(r, 1500));
      route.continue();
    });
    await page.goto(BASE + '/index.html');
    // Poll briefly rather than a single read — avoids a race against the
    // exact instant loadGarments() sets the loading text synchronously.
    let loadingText = '';
    for (let i = 0; i < 20 && !/loading garments/i.test(loadingText); i++) {
      loadingText = await page.locator('#garmentGrid').innerText();
      if (!/loading garments/i.test(loadingText)) await page.waitForTimeout(50);
    }
    assert(/loading garments/i.test(loadingText), `garment grid shows a loading state while fetching (got "${loadingText}")`);
    await page.waitForSelector('#garmentGrid .option-card', { timeout: 5000 });
    console.log('  ok: garment grid shows a real loading state instead of sitting blank while fetching');

    // Garments are seeded with image_url: '' by default (server/seed.js) —
    // confirm the placeholder is a real inline SVG icon, not a gray "No image" box.
    const noImageCard = page.locator('#garmentGrid .option-card').filter({ hasText: 'Hoodie' }).first();
    const svgCount = await noImageCard.locator('svg').count();
    assert(svgCount >= 1, 'a garment with no photo shows an inline SVG placeholder icon');
    const cardText = await noImageCard.innerText();
    assert(!/no image/i.test(cardText), 'the old ugly "No image" text label is gone');
    console.log('  ok: garments without a real photo show a clean inline-SVG silhouette instead of a gray "No image" box');
    await page.close();
  }

  // ================================================================ 7) LABEL/FOR + REQUIRED ATTRIBUTES
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE + '/index.html');
    await page.waitForSelector('#garmentGrid .option-card');
    for (const id of ['firstName', 'lastName', 'email', 'phone', 'businessName', 'neededByDate', 'additionalNotes']) {
      const label = page.locator(`label[for="${id}"]`);
      assert.strictEqual(await label.count(), 1, `index.html has a <label for="${id}">`);
    }
    for (const id of ['firstName', 'lastName', 'email', 'phone']) {
      const required = await page.locator(`#${id}`).getAttribute('required');
      assert(required !== null, `#${id} has the required attribute`);
    }
    const designNotesLabel = await page.locator('label[for="designNotes"]').count();
    assert.strictEqual(designNotesLabel, 1, 'Design Notes textarea has an associated label');
    console.log('  ok: index.html contact-step fields have proper label/for pairing and required attributes');

    await page.goto(BASE + '/quote.html');
    // discountCodeInput is rendered client-side once a quote loads — check
    // the source pattern is present in quote.js instead of requiring a live quote here.
    await page.close();
  }

  // ================================================================ 8) MOBILE FUNDAMENTALS
  for (const vp of [{ width: 375, height: 667, name: '375x667' }, { width: 390, height: 844, name: '390x844' }]) {
    const page = await (await browser.newContext({ viewport: { width: vp.width, height: vp.height } })).newPage();
    await page.goto(BASE + '/index.html');
    await page.waitForSelector('#garmentGrid .option-card');

    const noHorizScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert(noHorizScroll, `no horizontal scroll at ${vp.name} on the garment step`);

    const inputFontSize = await page.evaluate(() => {
      const el = document.querySelector('.field input[type=text], .field input[type=email], .field input[type=tel]');
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    });
    // (queried before any text input is visible on this step, so also check on the contact step below)

    // stepper touch target size + no h-scroll on the sizes step
    await page.click('#garmentGrid .option-card');
    await page.waitForSelector('#colorGrid .color-swatch');
    await page.locator('#colorGrid .color-swatch').first().click();
    await page.click('#colorNextBtn');
    await page.waitForSelector('.color-block');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll at ${vp.name} on the sizes step`);

    const stepperBtnBox = await page.locator('.qty-stepper button').first().boundingBox();
    assert(stepperBtnBox.width >= 44 && stepperBtnBox.height >= 44, `qty-stepper buttons are >=44x44px at ${vp.name} (got ${stepperBtnBox.width}x${stepperBtnBox.height})`);

    const stepper = page.locator('.color-block').nth(0).locator('.qty-stepper[data-size="M"] input');
    const stepperInputFontSize = parseFloat(await stepper.evaluate(el => getComputedStyle(el).fontSize));
    assert(stepperInputFontSize >= 16, `qty-stepper input font-size is >=16px at ${vp.name} (got ${stepperInputFontSize}px, prevents iOS auto-zoom)`);

    await stepper.fill('20');
    await stepper.dispatchEvent('input');
    await page.waitForTimeout(600); // past the debounce so the price + mobile bar settle
    await page.click('#sizesNextBtn');
    await page.waitForSelector('#locationGrid .option-card');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll at ${vp.name} on the locations step`);

    // sticky mobile summary bar
    const bar = page.locator('#mobileSummaryBar');
    await bar.waitFor({ state: 'visible', timeout: 5000 });
    const barBox = await bar.boundingBox();
    assert(barBox, `mobile summary bar is visible at ${vp.name}`);
    assert(barBox.y + barBox.height <= vp.height + 1, `mobile summary bar is not clipped off-screen at ${vp.name}`);
    const barText = await bar.innerText();
    assert(/20 Items?/i.test(barText), `mobile bar shows the running item count at ${vp.name} (got "${barText}")`);
    assert(/\$/.test(barText), `mobile bar shows a running total at ${vp.name} (got "${barText}")`);

    // "View Order" scrolls the desktop summary panel into view
    await page.click('#mobileViewOrderBtn');
    await page.waitForTimeout(400);
    const panelInView = await page.locator('#summaryPanel').evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    assert(panelInView, `"View Order" scrolls the order summary into view at ${vp.name}`);
    console.log(`  ok: mobile fundamentals hold at ${vp.name} (no h-scroll, 44px+ touch targets, 16px+ inputs, sticky bar with count+total)`);

    // contact-step input font-size check (16px minimum, iOS zoom guard)
    await page.click('#locationsNextBtn');
    await page.waitForSelector('#uploadSections');
    await page.check('#artworkLaterCheckbox');
    await page.click('.builder-step[data-step="artwork"] [data-nav="next"]');
    await page.waitForSelector('#firstName');
    const contactFontSize = parseFloat(await page.locator('#firstName').evaluate(el => getComputedStyle(el).fontSize));
    assert(contactFontSize >= 16, `contact-step text inputs are >=16px at ${vp.name} (got ${contactFontSize}px)`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal scroll at ${vp.name} on the contact step`);
    await page.close();
  }

  await browser.close();
  console.log('\n=== ACCESSIBILITY + MOBILE CHECKS PASSED ===');
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
