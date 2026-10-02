// Design placement previews (public/js/placement.js), server side:
//  1. a quote stores the customer's placement per print location and serves
//     it back to the quote page and the admin
//  2. anything malformed or pointing at an outside image is dropped, never stored
//  3. a garment's print-area calibration saves, sanitized, and reaches the
//     customer catalog; clearing it returns to the built-in default (null)
// Runs against the app on :4790.
const assert = require('assert');

const BASE = 'http://localhost:4790';
let cookie = '';
async function call(method, path, body) {
  const resp = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = resp.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

async function main() {
  console.log('=== DESIGN PLACEMENT PREVIEWS ===');
  const { garments } = (await call('GET', '/api/garments')).body;
  const tee = garments.find(g => !g.isOther);
  const color = tee.colors[0];

  const good = {
    locationCode: 'front', locationName: 'Front', view: 'front', colorName: color.name,
    imageUrl: 'https://www.ssactivewear.com/Images/Color/33310_f_fl.jpg', artworkUrl: '/uploads/abc-123.png', designSize: 'standard',
    zone: { x: 0.355, y: 0.21, w: 0.29, h: 0.2953 }, design: { x: 0.4, y: 0.25, w: 0.2, h: 0.12 },
    widthIn: 7.5, heightIn: 4.5, zoneWidthIn: 11, zoneHeightIn: 14, fromLeftIn: 1.75, fromTopIn: 2,
  };
  const quote = await call('POST', '/api/quotes', {
    firstName: 'Place', lastName: 'Ment', email: `placement.${Date.now()}@example.com`, phone: '4785550123', termsAccepted: true, fulfillmentMethod: 'pickup',
    garmentId: tee.id, colorSelections: [{ colorName: color.name, colorHex: color.hex, sizes: [{ label: tee.sizes[1].label, qty: 3 }] }], printLocationIds: [],
    placements: [
      good,
      { ...good, locationCode: 'front' },                                         // duplicate location
      { ...good, locationCode: 'back', imageUrl: 'https://evil.example/x.jpg' },  // outside image
      { ...good, locationCode: 'left_chest', artworkUrl: 'javascript:alert(1)' }, // not an upload
      { ...good, locationCode: 'upper_back', widthIn: 'wide' },                   // not a number
      'nonsense',
    ],
  });
  assert.strictEqual(quote.status, 200, JSON.stringify(quote.body));

  const pub = (await call('GET', `/api/quotes/${quote.body.quoteCode}`)).body.quote.placements;
  assert.strictEqual(pub.length, 1, 'only the one valid placement is kept');
  assert.strictEqual(pub[0].locationCode, 'front'); assert.strictEqual(pub[0].widthIn, 7.5); assert.strictEqual(pub[0].zone.w, 0.29);
  console.log('  ok: a quote stores its valid placement and drops duplicates, outside images, non-uploads and bad numbers');

  assert.strictEqual((await call('POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' })).status, 200);
  const adminQuote = (await call('GET', `/api/admin/quotes/${quote.body.quoteCode}`)).body.quote;
  assert.strictEqual(JSON.parse(adminQuote.placements_json)[0].fromTopIn, 2, 'the admin sees the same placement');
  console.log('  ok: the admin quote detail carries the placement');

  // ---- print-area calibration ----
  const before = garments.find(g => g.id === tee.id).mockup;
  try {
    const saved = await call('PUT', `/api/admin/garments/${tee.id}/mockup`, { mockup: { front: { cx: 0.48, top: 0.25, w11: 0.31 }, back: { cx: 5, top: 0.2, w11: 0.3 }, sleeve: { cx: 0.5, top: 0.5, w11: 0.3 } } });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.mockup, { front: { cx: 0.48, top: 0.25, w11: 0.31 } }, 'out-of-range and unknown views are dropped');
    assert.deepStrictEqual((await call('GET', '/api/garments')).body.garments.find(g => g.id === tee.id).mockup, { front: { cx: 0.48, top: 0.25, w11: 0.31 } });
    const cleared = await call('PUT', `/api/admin/garments/${tee.id}/mockup`, { mockup: {} });
    assert.strictEqual(cleared.body.mockup, null, 'an empty config means "use the defaults"');
    console.log('  ok: print-area calibration saves sanitized, reaches the catalog, and clears back to the default');
  } finally {
    await call('PUT', `/api/admin/garments/${tee.id}/mockup`, { mockup: before || {} });
  }
  await call('POST', '/api/admin/quotes/bulk', { action: 'delete', codes: [quote.body.quoteCode] }); // tidy up the test quote
  console.log('\n=== DESIGN PLACEMENT CHECKS PASSED ===');
}

main().catch(err => { console.error('PLACEMENT TEST FAILED:', err); process.exit(1); });
