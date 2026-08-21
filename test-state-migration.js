// Regression test for a real bug a customer hit in production: the customer
// builder persists in-progress state to sessionStorage, which survives page
// reloads and new deploys within the same browser tab. Before this fix,
// builder.js did `const state = loadState() || {defaults}` — if ANY state
// object was already saved (e.g. from before a new field like `designSizes`
// existed), it was used completely as-is, so the new field came back
// `undefined` and the first read of it crashed
// ("Cannot read properties of undefined (reading 'front')", since the
// default print location's `code` is "front"). That crash happened inside
// renderUploadSections() on the Artwork step, so it also silently blanked
// out the upload dropzone — no error banner, no button, just nothing.
//
// The fix merges loadState()'s result onto DEFAULT_STATE (one level deep,
// plus a nested merge for `contact`) instead of returning the saved object
// as-is, so any field missing from an older snapshot falls back to its
// default. This test simulates exactly that: a customer with an
// old-shaped, in-progress session (reached Artwork, but saved before
// `designSizes` existed) reloading the page under the current code.
const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function main() {
  console.log('=== STATE MIGRATION (stale sessionStorage) ===');

  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const { printLocations } = await (await fetch(`${BASE}/api/print-locations?qty=2`)).json();
  const front = printLocations.find(l => l.included);
  assert(front, 'seed data has a default included print location to build the fixture around');

  // An "old-shaped" saved state: everything a customer would have going into
  // the Artwork step, but WITHOUT `designSizes` — simulating a session saved
  // before that field was ever added to DEFAULT_STATE.
  const oldShapedState = {
    stepIndex: 5, // 'artwork' in the default order (contact, garment, color, sizes, locations, artwork, confirmation)
    draftToken: null,
    garments: [tee],
    selectedGarmentId: tee.id,
    selectedColors: [{ id: black.id, name: black.name, hex: black.hex }],
    sizesByColor: { [black.id]: { M: 2 } },
    garmentSizes: tee.sizes,
    printLocations,
    selectedLocationIds: [front.id],
    uploads: {},
    // designSizes: intentionally OMITTED — this is the pre-existing-field
    // that a real customer's saved session was missing.
    designNotes: '',
    contact: { firstName: '', lastName: '', email: '', phone: '', businessName: '', orderPurposes: [], neededByDate: '', additionalNotes: '', fulfillmentMethod: 'pickup' },
    estimate: null,
    businessInfo: null,
  };

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();

  // Track actual thrown JS exceptions (pageerror) separately from generic
  // console "error"-level messages, which also catch benign browser noise
  // unrelated to app code (e.g. a missing favicon) — pageerror is what
  // actually corresponds to "Cannot read properties of undefined" crashes.
  const jsErrors = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  // sessionStorage has to be set on the right origin BEFORE builder.js runs
  // its top-level `const state = loadState();` — addInitScript runs before
  // any page script on every subsequent navigation.
  await page.addInitScript((stateJson) => {
    sessionStorage.setItem('3t_builder_state', stateJson);
  }, JSON.stringify(oldShapedState));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // ---- 1) no crash ----
  assert.strictEqual(jsErrors.length, 0, `no JS exceptions loading with a stale pre-designSizes session (got: ${JSON.stringify(jsErrors)})`);
  console.log('  ok: loading a stale, pre-designSizes saved session throws no error');

  // ---- 2) lands on the Artwork step (stepIndex from the old state is honored) ----
  const activeStep = await page.locator('.step-pill.active').textContent();
  assert.strictEqual(activeStep, 'Artwork', `honors the saved stepIndex and lands on Artwork (got "${activeStep}")`);
  console.log('  ok: resumes on the correct step from the old saved session');

  // ---- 3) the upload dropzone actually renders (this is what was silently blank before) ----
  const dropzoneCount = await page.locator('.upload-dropzone').count();
  assert(dropzoneCount > 0, `upload dropzone renders instead of being silently blanked (found ${dropzoneCount})`);
  const dropzoneText = await page.locator('.upload-dropzone').first().textContent();
  assert(/upload artwork/i.test(dropzoneText), 'the dropzone shows its normal "Click to upload artwork" prompt');
  console.log('  ok: the artwork upload dropzone renders correctly (not silently blank)');

  // ---- 4) the missing field healed itself to the correct default ----
  const designSizeState = await page.evaluate(() => JSON.parse(sessionStorage.getItem('3t_builder_state')).designSizes);
  assert(designSizeState && typeof designSizeState === 'object', 'designSizes healed to an object instead of staying undefined');
  assert.strictEqual(designSizeState[front.code], 'standard', `the missing field defaulted correctly for the selected location (got ${JSON.stringify(designSizeState)})`);
  console.log('  ok: the missing field self-healed to its correct default and was persisted back');

  // ---- 5) a design-size pill is selectable without error (exercises the exact code path that used to crash) ----
  await page.locator('.radio-pill[data-value="large"]').first().click();
  await page.waitForTimeout(300);
  assert.strictEqual(jsErrors.length, 0, 'selecting a design size after recovering from a stale session still throws no error');
  console.log('  ok: design-size selection works normally after recovering from stale state');

  await browser.close();
  console.log('=== STATE MIGRATION: ALL CHECKS PASSED ===');
}

main().catch(err => {
  console.error('STATE MIGRATION TEST FAILED:', err);
  process.exit(1);
});
