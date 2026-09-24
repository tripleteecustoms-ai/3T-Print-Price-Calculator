// S&S Activewear integration, end to end against a FAKE S&S API (started
// here on :4791, shaped like https://api.ssactivewear.com/v2) so it runs
// without real credentials. Runs against the app on :4790, pointed at the
// fake via the ss_api_base setting (restored at the end).
//
// Covers: write-only API key, bad credentials, test connection, linking by
// "Brand Style", reference tee auto-link, cost -> upcharge -> tier prices,
// size surcharges from S&S size pricing, colors/swatches/photos, sold-out
// colors hidden, per-size stock, stock-short review flag, search + import,
// unlink.
const assert = require('assert');
const http = require('http');

const BASE = 'http://localhost:4790';
const FAKE_PORT = 4791;
const ACCOUNT = '123456';
const KEY = 'fake-key-abc';
let cookie = '';

// ---------------------------------------------------------------- fake S&S
const STYLES = [
  { styleID: 39, brandName: 'Gildan', styleName: '5000', title: 'Heavy Cotton T-Shirt', baseCategory: 'T-Shirts', styleImage: 'Images/Style/39_fm.jpg' },
  { styleID: 190, brandName: 'Gildan', styleName: '18500', title: 'Heavy Blend Hooded Sweatshirt', baseCategory: 'Fleece', styleImage: 'Images/Style/190_fm.jpg' },
  { styleID: 777, brandName: 'BELLA + CANVAS', styleName: '3001', title: 'Unisex Jersey Tee', baseCategory: 'T-Shirts', styleImage: 'Images/Style/777_fm.jpg' },
];
// per style: base cost (S-XL), 2XL cost, colors [name, hex, stock by size]
const CATALOG = {
  39: { base: 3.00, xxl: 4.50, colors: [['Black', '000000', { S: 900, M: 900, L: 900, XL: 900, '2XL': 5 }], ['White', 'FFFFFF', { S: 900, M: 900, L: 900, XL: 900, '2XL': 900 }]] },
  190: { base: 10.50, xxl: 12.50, colors: [['Black', '000000', { S: 300, M: 300, L: 300, XL: 300, '2XL': 5 }], ['Sport Grey', '97999B', { S: 300, M: 0, L: 300, XL: 300, '2XL': 300 }], ['Cardinal Red', '8A1538', { S: 0, M: 0, L: 0, XL: 0, '2XL': 0 }]] },
  777: { base: 3.50, xxl: 5.00, colors: [['Black', '000000', { S: 50, M: 50, L: 50, XL: 50, '2XL': 50 }]] },
};
const SIZE_ORDER = { S: 'B', M: 'C', L: 'D', XL: 'E', '2XL': 'F' };
function productsFor(styleID) {
  const c = CATALOG[styleID];
  const out = [];
  for (const [colorName, hex, stock] of c.colors) {
    for (const [size, qty] of Object.entries(stock)) {
      out.push({
        sku: `${styleID}-${colorName}-${size}`, styleID, colorName, color1: '#' + hex, sizeName: size, sizeOrder: SIZE_ORDER[size],
        colorSwatchImage: `Images/ColorSwatch/${styleID}_${colorName.replace(/ /g, '')}.jpg`,
        colorFrontImage: `Images/Color/${styleID}_${colorName.replace(/ /g, '')}_fm.jpg`,
        customerPrice: size === '2XL' ? c.xxl : c.base, piecePrice: 99, qty,
      });
    }
  }
  return out;
}
const fake = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  const [user, pass] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (user !== ACCOUNT || pass !== KEY) return send(401, { message: 'Unauthorized' });
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/v2/styles/') {
    if (url.searchParams.get('styleid')) return send(200, STYLES.filter(s => String(s.styleID) === url.searchParams.get('styleid')));
    const q = (url.searchParams.get('search') || '').toLowerCase().split(/\s+/).filter(Boolean);
    return send(200, STYLES.filter(s => q.every(w => `${s.brandName} ${s.styleName} ${s.title}`.toLowerCase().includes(w))));
  }
  if (url.pathname === '/v2/products/') {
    const id = Number(url.searchParams.get('styleid'));
    return CATALOG[id] ? send(200, productsFor(id)) : send(404, []);
  }
  send(404, []);
});

// ---------------------------------------------------------------- helpers
async function call(method, path, body) {
  const resp = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = resp.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}
async function estimate(garmentId, qty, color = 'Black', size = 'L') {
  return (await call('POST', '/api/estimate', { garmentId, colorSelections: [{ colorName: color, sizes: [{ label: size, qty }] }], printLocationIds: [1] })).body.estimate;
}

async function main() {
  await new Promise(r => fake.listen(FAKE_PORT, r));
  console.log('=== S&S ACTIVEWEAR INTEGRATION (fake S&S API) ===');
  assert.strictEqual((await call('POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' })).status, 200);
  const before = (await call('GET', '/api/admin/settings')).body.settings;
  const beforeSs = (await call('GET', '/api/admin/ss/settings')).body;
  if (beforeSs.hasApiKey) throw new Error('A real S&S API key is saved on this server; refusing to run the fake-API test here.');
  const testGarmentIds = [];
  await call('PUT', '/api/admin/settings', { ss_api_base: `http://localhost:${FAKE_PORT}/v2` });

  try {
    // ---- credentials ----
    await call('PUT', '/api/admin/ss/settings', { accountNumber: ACCOUNT, apiKey: 'wrong-key', markupPct: 60, autoSync: false });
    const bad = await call('POST', '/api/admin/ss/test', {});
    assert.strictEqual(bad.status, 400); assert.ok(/rejected/.test(bad.body.error), 'bad key gives a clear message');
    await call('PUT', '/api/admin/ss/settings', { apiKey: KEY });
    const s = (await call('GET', '/api/admin/ss/settings')).body;
    assert.strictEqual(s.hasApiKey, true); assert.strictEqual(s.configured, true); assert.strictEqual(s.apiKey, undefined);
    assert.ok(!('ss_api_key' in (await call('GET', '/api/admin/settings')).body.settings), 'API key is never sent back to the browser');
    await call('PUT', '/api/admin/ss/settings', { accountNumber: ACCOUNT, apiKey: '' });
    assert.strictEqual((await call('POST', '/api/admin/ss/test', {})).status, 200, 'blank key on save keeps the saved key');
    console.log('  ok: API key is write-only; bad key rejected clearly; test connection works');

    // ---- throwaway garments, so the real catalog is never touched ----
    // A test tee becomes the reference garment (it starts on the tee price
    // table, like the real Standard Tee), plus a test hoodie.
    const tee = { id: (await call('POST', '/api/admin/garments', { name: 'SS Test Tee', brand: 'Gildan', styleNumber: '5000' })).body.id };
    const hoodie = { id: (await call('POST', '/api/admin/garments', { name: 'SS Test Hoodie', brand: 'Gildan', styleNumber: '18500' })).body.id };
    testGarmentIds.push(tee.id, hoodie.id);
    await call('PUT', '/api/admin/ss/settings', { referenceGarmentId: tee.id });

    // ---- link the hoodie: auto-links + syncs the (unlinked) reference tee first ----
    const link = await call('POST', `/api/admin/garments/${hoodie.id}/ss-link`, { style: 'Gildan 18500' });
    assert.strictEqual(link.status, 200, JSON.stringify(link.body));
    assert.strictEqual(link.body.styleID, 190);
    assert.strictEqual(link.body.baseCost, 10.50);
    assert.strictEqual(link.body.upcharge, 12.00, '(10.50 - 3.00) x 1.60 = +12.00');
    const after = (await call('GET', '/api/admin/garments')).body.garments;
    const teeAfter = after.find(g => g.id === tee.id), hoodieAfter = after.find(g => g.id === hoodie.id);
    assert.strictEqual(teeAfter.ss_style_id, 39, 'reference tee was auto-linked to Gildan 5000');
    assert.strictEqual(teeAfter.ss_cost, 3.00);
    assert.strictEqual(hoodieAfter.internal_cost, 10.50, 'S&S cost feeds the internal cost (margin warnings)');
    console.log('  ok: linking Hoodie auto-linked the tee; cost $10.50 vs $3.00 -> upcharge +$12.00');

    // ---- prices ----
    assert.strictEqual((await estimate(tee.id, 1)).finalBaseUnit, 35.00, 'tee keeps its own price table');
    assert.strictEqual((await estimate(hoodie.id, 1)).finalBaseUnit, 47.00, 'Hoodie at 1 = $35 + $12');
    assert.strictEqual((await estimate(hoodie.id, 1000)).finalBaseUnit, 22.00, 'Hoodie at 1,000 = $10 + $12');
    const xxl = hoodieAfter.sizes.find(sz => sz.label === '2XL');
    assert.strictEqual(xxl.surcharge, 3.20, '2XL surcharge = (12.50 - 10.50) x 1.60');
    assert.strictEqual(hoodieAfter.sizes.find(sz => sz.label === 'L').surcharge, 0);
    console.log('  ok: Hoodie $47.00 at 1, $22.00 at 1,000; 2XL surcharge +$3.20 from S&S size pricing');

    // ---- colors, photos, stock ----
    const pub = (await call('GET', '/api/garments')).body.garments.find(g => g.id === hoodie.id);
    const names = pub.colors.map(c => c.name).sort();
    assert.deepStrictEqual(names, ['Black', 'Sport Grey'], 'S&S colors in; the sold-out color hidden');
    const grey = pub.colors.find(c => c.name === 'Sport Grey');
    assert.strictEqual(grey.hex, '#97999B');
    assert.ok(grey.swatchUrl.startsWith('https://www.ssactivewear.com/Images/ColorSwatch/'), 'swatch image from S&S');
    assert.ok(grey.imageUrl.startsWith('https://www.ssactivewear.com/Images/Color/'), 'color photo from S&S');
    assert.strictEqual(grey.stock.M, 0, 'per-size stock is exposed (M sold out in Sport Grey)');
    assert.ok(pub.imageUrl === '' || pub.imageUrl.startsWith('https://www.ssactivewear.com/') || !!pub.imageUrl, 'garment has a photo');
    console.log('  ok: colors, hex, swatches and photos from S&S; sold-out color hidden; per-size stock exposed');

    // ---- stock-short review flag (never blocks) ----
    const q = await call('POST', '/api/quotes', {
      firstName: 'Stock', lastName: 'Short', email: 'stock@example.com', phone: '4785550000', termsAccepted: true, fulfillmentMethod: 'pickup',
      garmentId: hoodie.id, colorSelections: [{ colorName: 'Black', sizes: [{ label: '2XL', qty: 10 }] }], printLocationIds: [1],
    });
    assert.strictEqual(q.status, 200);
    assert.ok(q.body.reviewReasons.includes('supplier_stock_short'), 'ordering 10 when S&S has 5 flags the quote');
    console.log('  ok: ordering more than S&S has in stock flags the quote "supplier stock short" (does not block)');

    // ---- search + import ----
    const found = (await call('POST', '/api/admin/ss/search', { query: 'bella 3001' })).body.styles;
    assert.strictEqual(found.length, 1); assert.strictEqual(found[0].styleID, 777);
    const imp = await call('POST', '/api/admin/ss/import', { styleID: 777 });
    assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
    testGarmentIds.push(imp.body.id);
    assert.strictEqual(imp.body.upcharge, 0.80, '(3.50 - 3.00) x 1.60 = +0.80');
    assert.strictEqual((await estimate(imp.body.id, 1)).finalBaseUnit, 35.80);
    assert.strictEqual((await call('POST', '/api/admin/ss/import', { styleID: 777 })).status, 400, 'importing the same style twice is refused');
    console.log('  ok: search finds a style; Import creates a priced garment ($35.80 at 1); duplicate import refused');

    // ---- markup change + sync all ----
    await call('PUT', '/api/admin/ss/settings', { markupPct: 100 });
    const all = (await call('POST', '/api/admin/ss/sync-all', {})).body.results;
    assert.ok(all.every(r => r.ok), JSON.stringify(all));
    assert.strictEqual(all[0].isReference, true, 'sync-all does the reference garment first');
    assert.strictEqual((await estimate(hoodie.id, 1)).finalBaseUnit, 50.00, 'markup 100%: $35 + (7.50 x 2)');
    console.log('  ok: changing markup to 100% and Sync All reprices Hoodie to $50.00');

    // ---- price-sync off keeps prices ----
    await call('PUT', `/api/admin/garments/${hoodie.id}/ss-price-sync`, { enabled: false });
    await call('PUT', '/api/admin/ss/settings', { markupPct: 60 });
    await call('POST', `/api/admin/garments/${hoodie.id}/ss-sync`, {});
    assert.strictEqual((await estimate(hoodie.id, 1)).finalBaseUnit, 50.00, 'with price sync off, a sync leaves prices alone');
    await call('PUT', `/api/admin/garments/${hoodie.id}/ss-price-sync`, { enabled: true });
    await call('POST', `/api/admin/garments/${hoodie.id}/ss-sync`, {});
    assert.strictEqual((await estimate(hoodie.id, 1)).finalBaseUnit, 47.00);
    console.log('  ok: "update prices from S&S" off leaves prices alone; back on reprices');

    // ---- unknown style + unlink ----
    const nope = await call('POST', `/api/admin/garments/${hoodie.id}/ss-link`, { style: 'Nobody 99999' });
    assert.strictEqual(nope.status, 400); assert.ok(/no style matching/.test(nope.body.error));
    await call('POST', `/api/admin/garments/${imp.body.id}/ss-unlink`, {});
    const unl = (await call('GET', '/api/admin/garments')).body.garments.find(g => g.id === imp.body.id);
    assert.strictEqual(unl.ss_style_id, null);
    assert.ok(!(await call('GET', '/api/garments')).body.garments.find(g => g.id === imp.body.id).colors[0].stock, 'unlinked garment has no stock data');
    console.log('  ok: unknown style gives a clear error; unlink removes the S&S link and stock');
  } finally {
    // Put everything back: deactivate the throwaway garments (unlinked, so
    // no sync ever touches them) and restore the S&S settings.
    for (const id of testGarmentIds) {
      await call('POST', `/api/admin/garments/${id}/ss-unlink`, {});
      await call('DELETE', `/api/admin/garments/${id}`);
    }
    await call('PUT', '/api/admin/settings', {
      ss_api_base: before.ss_api_base || '', ss_account_number: before.ss_account_number || '',
      ss_markup_pct: before.ss_markup_pct || '60', ss_reference_garment_id: before.ss_reference_garment_id || '',
      ss_auto_sync: before.ss_auto_sync || '1',
    });
    if (!beforeSs.hasApiKey) await call('PUT', '/api/admin/ss/settings', { clearApiKey: true });
    fake.close();
  }
  console.log('\n=== S&S ACTIVEWEAR CHECKS PASSED ===');
}

main().catch(err => { console.error('S&S TEST FAILED:', err); fake.close(); process.exit(1); });
