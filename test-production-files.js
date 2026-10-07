// Production files: Customer Artwork / Mockup / Print Ready as three separate
// assets per print slot, the job ticket, the Production PDF, the files ZIP,
// revision numbers, production status, and that none of it is public or
// changes pricing. Runs against a server on :4790.
const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');

const BASE = 'http://localhost:4790';

function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const isForm = body instanceof FormData;
    const raw = typeof body === 'string';
    const resp = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? (isForm || raw ? body : JSON.stringify(body)) : undefined,
    });
    const sc = resp.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const buffer = Buffer.from(await resp.arrayBuffer());
    let json = {}; try { json = JSON.parse(buffer.toString('utf8')); } catch (e) {}
    return { status: resp.status, body: json, buffer, headers: resp.headers, location: resp.headers.get('location') };
  };
}

// A real PNG of a solid color, w x h.
function png(w, h, [r, g, b]) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="200" fill="#CCFF00"/><circle cx="150" cy="100" r="70" fill="#000"/></svg>');
// The names and bytes of every file in a (stored, uncompressed) ZIP.
function unzip(buffer) {
  const files = {};
  let i = 0;
  while (buffer.readUInt32LE(i) === 0x04034b50) {
    const size = buffer.readUInt32LE(i + 18), nameLen = buffer.readUInt16LE(i + 26), extra = buffer.readUInt16LE(i + 28);
    const name = buffer.toString('utf8', i + 30, i + 30 + nameLen);
    files[name] = buffer.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return files;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function main() {
  console.log('=== PRODUCTION FILES, JOB TICKET, PDF, ZIP ===');
  const admin = client(), guest = client(), stranger = client();
  assert.strictEqual((await admin('POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' })).status, 200);
  const settingsBefore = (await admin('GET', '/api/admin/settings')).body.settings;
  await admin('PUT', '/api/admin/settings', { email_provider: 'mock', payment_provider: 'mock', shopify_client_secret: 'test-shopify-secret' });

  // ---- an apparel order: two colors, front and back, PNG on the front (placed by the customer), SVG on the back ----
  const stamp = Date.now();
  const { garments } = (await guest('GET', '/api/garments')).body;
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const locations = (await guest('GET', '/api/print-locations?qty=24')).body.printLocations;
  const front = locations.find(l => l.code === 'front'), back = locations.find(l => l.code === 'back');
  const { draftToken } = (await guest('POST', '/api/draft-token', {})).body;
  const upload = async (name, bytes, type, code) => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type }), name);
    fd.append('draftToken', draftToken);
    fd.append('printLocationCode', code);
    const r = await guest('POST', '/api/uploads', fd);
    assert.strictEqual(r.status, 200, r.buffer.toString());
    return r.body.file || r.body;
  };
  const frontPng = png(400, 300, [30, 60, 200]);
  const frontFile = await upload('front-logo.png', frontPng, 'image/png', 'front');
  await upload('back-design.svg', SVG, 'image/svg+xml', 'back');
  const garmentPhoto = await upload('shirt-photo.png', png(600, 700, [240, 240, 240]), 'image/png', 'front'); // stands in for the garment photo
  const order = await guest('POST', '/api/quotes', {
    firstName: 'Prod', lastName: 'Tester', email: `prod.${stamp}@example.com`, phone: '4785550100', termsAccepted: true, fulfillmentMethod: 'pickup', draftToken,
    neededByDate: '2031-10-08', notes: 'Call before printing', designNotes: 'Keep the blue exact',
    garmentId: tee.id, printLocationIds: [front.id, back.id],
    colorSelections: [{ colorName: tee.colors[0].name, sizes: [{ label: 'S', qty: 3 }, { label: 'M', qty: 5 }, { label: 'L', qty: 8 }] }, { colorName: tee.colors[1].name, sizes: [{ label: 'XL', qty: 6 }, { label: '2XL', qty: 2 }] }],
    placements: [{ locationCode: 'front', locationName: 'Front', view: 'front', colorName: tee.colors[0].name, fileName: 'front-logo.png', fileType: 'PNG', imageUrl: garmentPhoto.url, artworkUrl: frontFile.url,
      zone: { x: 0.3, y: 0.25, w: 0.4, h: 0.45 }, design: { x: 0.35, y: 0.3, w: 0.3, h: 0.225 }, widthIn: 8.25, heightIn: 6.19, zoneWidthIn: 11, zoneHeightIn: 14, fromLeftIn: 1.38, fromTopIn: 1.56, designSize: 'standard' }],
  });
  assert.strictEqual(order.status, 200, order.buffer.toString());
  const code = order.body.quoteCode;
  const before = (await guest('GET', `/api/quotes/${code}`)).body;
  const T = async () => { const r = await admin('GET', `/api/admin/orders/${code}/production`); assert.strictEqual(r.status, 200, r.buffer.toString()); return r.body; };

  // ---- 1) the three assets are separate, per print location ----
  let t = await T();
  assert.strictEqual(t.items.length, 1);
  const item = t.items[0];
  assert.strictEqual(item.quantity, 24);
  assert.ok(/Gildan/.test(item.brandStyle), `brand and style shown (${item.brandStyle})`);
  assert.ok(item.sizeBreakdown.includes('S-3 / M-5 / L-8') && item.sizeBreakdown.includes('XL-6 / 2XL-2'), 'size breakdown per color');
  assert.deepStrictEqual(item.slots.map(s => s.label), ['Front', 'Back'], 'one production slot per print location');
  let [fs, bs] = item.slots;
  assert.deepStrictEqual(fs.customerArtwork.map(f => f.name).sort(), ['front-logo.png', 'shirt-photo.png']);
  assert.deepStrictEqual(bs.customerArtwork.map(f => f.name), ['back-design.svg']);
  assert.ok(fs.printReady === null && bs.printReady === null, 'no print ready file until the shop uploads one');
  assert.ok(/8\.25 × 6\.19 in/.test(fs.dimensions), `actual print dimensions from the placement (${fs.dimensions})`);
  assert.strictEqual(t.production.stage, 'Artwork Pending');
  assert.strictEqual(t.dueDate, '2031-10-08');
  assert.ok(!JSON.stringify(t).includes('"path"'), 'server file paths are never sent to the browser');
  console.log('  ok: job ticket has one slot per location with customer artwork, mockup and print ready kept apart');

  // ---- 2) the customer's placement became a stored mockup file ----
  assert.strictEqual(fs.mockups.length, 1, 'the front placement is stored as a mockup');
  assert.strictEqual(fs.mockups[0].source, 'placement');
  const mock = await admin('GET', fs.mockups[0].viewUrl);
  assert.strictEqual(mock.headers.get('content-type'), 'image/png');
  assert.ok(mock.buffer.length > 1000 && mock.buffer.readUInt32BE(16) === 600, 'a real PNG at the garment photo size');
  assert.strictEqual((await T()).items[0].slots[0].mockups[0].id, fs.mockups[0].id, 'it is made once, not on every view');
  assert.strictEqual(bs.mockups.length, 0);
  console.log('  ok: apparel placement stored as a PNG mockup (no longer browser-only)');

  // ---- 3) nothing is public; everything needs the admin login ----
  assert.strictEqual((await stranger('GET', `/api/admin/orders/${code}/production`)).status, 401);
  assert.strictEqual((await stranger('GET', fs.mockups[0].viewUrl)).status, 401);
  assert.strictEqual((await stranger('GET', `/api/admin/orders/${code}/production.pdf`)).status, 401);
  for (const link of ['', '/edit', '/mockups', '/print-ready', '/production.pdf', '/files.zip']) {
    const r = await stranger('GET', `/admin/orders/${code}${link}`);
    assert.strictEqual(r.status, 302);
    assert.ok(r.location.startsWith('/admin/login.html?next='), `${link || 'view'} sends a signed-out visitor to the admin login`);
    assert.strictEqual(decodeURIComponent(r.location.split('next=')[1]), `/admin/orders/${code}${link}`, 'and brings them back afterwards');
  }
  assert.strictEqual((await admin('GET', `/admin/orders/${code}/print-ready`)).location, `/admin/order.html?code=${code}&view=print-ready`);
  assert.strictEqual((await admin('GET', `/admin/orders/${code}/edit`)).location, `/admin/order.html?code=${code}&view=edit`);
  console.log('  ok: every link needs the admin login and returns there after signing in');

  // ---- 4) print ready files: upload, replace, view, download; the original is never touched ----
  const originalHash = sha((await admin('GET', fs.customerArtwork.find(f => f.name === 'front-logo.png').viewUrl)).buffer);
  const send = (slot, kind, name, bytes, type) => { const fd = new FormData(); fd.append('slot', slot); fd.append('kind', kind); fd.append('file', new Blob([bytes], { type }), name); return admin('POST', `/api/admin/orders/${code}/assets`, fd); };
  assert.strictEqual((await send(fs.key, 'print_ready', 'virus.exe', Buffer.from('x'), 'application/octet-stream')).status, 400, 'unexpected file types are refused');
  assert.strictEqual((await send('loc-99999', 'print_ready', 'a.png', frontPng, 'image/png')).status, 400, 'a slot that is not on the order is refused');
  assert.strictEqual((await send(fs.key, 'nonsense', 'a.png', frontPng, 'image/png')).status, 400);
  const rev0 = t.revision;
  const ready1 = png(1200, 900, [10, 10, 10]);
  let r = await send(fs.key, 'print_ready', 'front-print-ready.png', ready1, 'image/png');
  assert.strictEqual(r.status, 200, r.buffer.toString());
  t = r.body; [fs, bs] = t.items[0].slots;
  assert.strictEqual(fs.printReady.name, 'front-print-ready.png');
  assert.ok(t.revision > rev0, 'uploading a print ready file raises the revision');
  assert.strictEqual(fs.customerArtwork.length, 2, 'the customer artwork is still there');
  assert.strictEqual(sha((await admin('GET', fs.customerArtwork.find(f => f.name === 'front-logo.png').viewUrl)).buffer), originalHash, 'the customer file is byte-for-byte unchanged');
  assert.strictEqual(t.production.stage, 'Artwork Pending', 'not print ready until every location has a file');
  const firstId = fs.printReady.id;
  const ready2 = png(1500, 1100, [200, 0, 0]);
  t = (await send(fs.key, 'print_ready', 'front-print-ready-v2.png', ready2, 'image/png')).body; [fs, bs] = t.items[0].slots;
  assert.strictEqual(fs.printReady.name, 'front-print-ready-v2.png', 'replacing swaps the current file');
  assert.notStrictEqual(fs.printReady.id, firstId);
  assert.strictEqual(sha((await admin('GET', `/api/admin/production/assets/${firstId}/file`)).buffer), sha(ready1), 'the replaced file is kept as history');
  const dl = await admin('GET', fs.printReady.viewUrl + '?download=1');
  assert.strictEqual(sha(dl.buffer), sha(ready2), 'the downloaded print ready file is the exact file that was uploaded');
  assert.ok(/attachment; filename="front-print-ready-v2\.png"/.test(dl.headers.get('content-disposition')));
  assert.strictEqual((await stranger('GET', `/uploads/${fs.printReady.viewUrl.split('/')[5]}`)).status, 404);
  t = (await send(bs.key, 'print_ready', 'back-print-ready.svg', SVG, 'image/svg+xml')).body; [fs, bs] = t.items[0].slots;
  assert.strictEqual(sha((await admin('GET', bs.printReady.viewUrl)).buffer), sha(SVG), 'an SVG master is stored as is, not converted');
  const preview = await admin('GET', bs.printReady.previewUrl);
  assert.strictEqual(preview.headers.get('content-type'), 'image/png', 'an SVG gets a PNG preview');
  assert.ok(preview.buffer.readUInt32BE(16) === 1400, 'the preview is high resolution');
  assert.strictEqual(t.production.stage, 'Print Ready', 'every location has a print ready file');
  t = (await send(bs.key, 'mockup', 'back-mockup.png', png(500, 600, [90, 90, 90]), 'image/png')).body; [fs, bs] = t.items[0].slots;
  assert.strictEqual(bs.mockups[0].name, 'back-mockup.png');
  assert.strictEqual(bs.printReady.name, 'back-print-ready.svg', 'a mockup and a print ready file are separate assets');
  console.log('  ok: print ready upload / replace / view / download; originals untouched; SVG kept and previewed');

  // ---- 5) production notes, due date, revision ----
  const revA = t.revision;
  r = await admin('PUT', `/api/admin/orders/${code}/production`, { productionNotes: 'Press at 300F, 12 seconds', dueDate: '2031-10-09', slotNotes: { [fs.key]: 'Center 3 in below collar' } });
  assert.strictEqual(r.status, 200, r.buffer.toString());
  t = r.body;
  assert.strictEqual(t.productionNotes, 'Press at 300F, 12 seconds');
  assert.strictEqual(t.dueDate, '2031-10-09');
  assert.strictEqual(t.items[0].slots[0].note, 'Center 3 in below collar');
  assert.strictEqual(t.revision, revA + 1, 'changing production details raises the revision by one');
  assert.strictEqual((await admin('PUT', `/api/admin/orders/${code}/production`, { dueDate: 'next week' })).status, 400);
  console.log('  ok: production notes, due date and per-location notes; revision goes up');

  // ---- 6) Production PDF: fresh every time, with the revision and the details ----
  let pdf = await admin('GET', `/admin/orders/${code}/production.pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok(pdf.headers.get('content-disposition').includes(`filename="${code}_Production.pdf"`), pdf.headers.get('content-disposition'));
  let doc = await PDFDocument.load(pdf.buffer);
  assert.ok(doc.getTitle().includes(code));
  assert.ok(doc.getSubject().startsWith(`Revision ${t.revision},`), doc.getSubject());
  // page 1 + 2 mockups + (print ready + 2 customer files) for the front + (print ready + 1 customer file) for the back
  assert.strictEqual(doc.getPageCount(), 1 + 2 + 3 + 2, 'summary, then a page per mockup, then a page per artwork preview');
  await admin('PUT', `/api/admin/orders/${code}/production`, { productionNotes: 'Press at 310F' });
  doc = await PDFDocument.load((await admin('GET', `/api/admin/orders/${code}/production.pdf`)).buffer);
  assert.ok(doc.getSubject().startsWith(`Revision ${t.revision + 1},`), 'the PDF is rebuilt from current data, with the new revision');
  console.log(`  ok: Production PDF generated fresh (${doc.getPageCount()} pages) with order, revision and generated time`);

  // ---- 7) once Shopify has the order, its number is in the file names ----
  const shopOrder = { id: 880000 + (stamp % 9000), name: '#1277', financial_status: 'paid', total_price: '700.00', total_outstanding: '0.00', note_attributes: [{ name: 'quote_id', value: code }] };
  const hookBody = JSON.stringify(shopOrder);
  await stranger('POST', '/api/webhooks/shopify', hookBody, { 'x-shopify-topic': 'orders/paid', 'x-shopify-event-id': crypto.randomUUID(), 'x-shopify-hmac-sha256': crypto.createHmac('sha256', 'test-shopify-secret').update(hookBody).digest('base64') });
  pdf = await admin('GET', `/admin/orders/${code}/production.pdf?download=1`);
  assert.ok(pdf.headers.get('content-disposition').includes(`attachment; filename="Order-1277_${code}_Production.pdf"`), pdf.headers.get('content-disposition'));

  // ---- 8) Download All Files: the real files, in their original formats ----
  const zipResp = await admin('GET', `/admin/orders/${code}/files.zip`);
  assert.strictEqual(zipResp.status, 200);
  assert.ok(zipResp.headers.get('content-disposition').includes(`filename="Order-1277_${code}_Files.zip"`));
  const files = unzip(zipResp.buffer);
  const names = Object.keys(files).sort();
  assert.deepStrictEqual(names, [
    'Customer-Uploads/Back-Original.svg', 'Customer-Uploads/Front-Original-2.png', 'Customer-Uploads/Front-Original.png',
    'Mockups/Back-Mockup.png', 'Mockups/Front-Mockup.png',
    'Print-Ready/Back-Print-Ready.svg', 'Print-Ready/Front-Print-Ready.png',
    `Production-PDF/Order-1277_${code}_Production.pdf`,
  ], names.join('\n'));
  assert.strictEqual(sha(files['Print-Ready/Front-Print-Ready.png']), sha(ready2), 'the print ready PNG in the ZIP is the uploaded file, untouched');
  assert.strictEqual(sha(files['Print-Ready/Back-Print-Ready.svg']), sha(SVG), 'the SVG master is in the ZIP as an SVG');
  assert.strictEqual(sha(files['Customer-Uploads/Front-Original.png']), originalHash);
  assert.ok((await PDFDocument.load(files[`Production-PDF/Order-1277_${code}_Production.pdf`])).getPageCount() >= 8);
  console.log('  ok: files ZIP has Production-PDF / Mockups / Print-Ready / Customer-Uploads with the original files');

  // ---- 9) production status: independent stages; declined artwork is a flag, not a stage ----
  const queue = (await admin('GET', `/api/admin/artwork?filter=active&q=${code}`)).body.artwork;
  await admin('POST', '/api/admin/artwork/activate', { changes: [{ id: queue.find(f => f.original_filename === 'back-design.svg').id, status: 'declined' }] });
  t = await T();
  assert.strictEqual(t.production.declinedArtwork, 1);
  assert.ok(t.production.stages.every(s => !/declin/i.test(s)), 'Declined is not a production stage');
  assert.strictEqual(t.production.stage, 'Print Ready');
  await admin('PATCH', `/api/admin/quotes/${code}/status`, { status: 'in_production' });
  assert.strictEqual((await T()).production.stage, 'In Production');
  await admin('PATCH', `/api/admin/quotes/${code}/status`, { status: 'ready_for_pickup' });
  assert.strictEqual((await T()).production.stage, 'Ready for Pickup');
  await admin('PATCH', `/api/admin/quotes/${code}/status`, { status: 'completed' });
  t = await T();
  assert.strictEqual(t.production.stage, 'Completed');
  assert.ok(t.paymentStatus.startsWith('Paid in full'), 'payment status is reported separately from production status');
  console.log('  ok: Artwork Pending -> Print Ready -> In Production -> Ready for Pickup -> Completed; declined is a flag');

  // ---- 10) removing a print ready file; pricing and checkout untouched ----
  r = await admin('DELETE', `/api/admin/production/assets/${t.items[0].slots[0].printReady.id}`);
  assert.strictEqual(r.body.items[0].slots[0].printReady, null);
  assert.strictEqual(r.body.items[0].slots[0].customerArtwork.length, 2);
  const after = (await guest('GET', `/api/quotes/${code}`)).body;
  for (const key of ['orderTotal', 'taxAmount', 'rushFee', 'shippingFee', 'grandTotal']) assert.strictEqual(after.checkout[key], before.checkout[key], `${key} unchanged`);
  assert.strictEqual(after.pricing.total, before.pricing.total);
  console.log('  ok: a print ready file can be removed; prices, tax and totals are exactly as before');

  // ---- 11) a print product order with two designs keeps each design's files apart ----
  const catalog = (await guest('GET', '/api/print-catalog')).body.families.find(f => f.key === 'stickers');
  if (catalog && catalog.active && catalog.products.length) {
    const product = catalog.products[0];
    const size = product.sizes[0], size2 = product.sizes[1] || product.sizes[0];
    const qty = (size.packs[0] || size.tables[0].packs[0]).qty;
    const dt = (await guest('POST', '/api/draft-token', {})).body.draftToken;
    const up = async (name, label) => { const fd = new FormData(); fd.append('file', new Blob([png(300, 300, [0, 150, 90])], { type: 'image/png' }), name); fd.append('draftToken', dt); fd.append('locationName', label); return (await guest('POST', '/api/uploads', fd)).body; };
    const a1 = await up('sticker-one.png', 'Artwork'), a2 = await up('sticker-two.png', 'Artwork'), m2 = await up('sticker-two-proof.png', 'Approved Mockup');
    const pick = (s) => ({ productId: product.id, sizeId: s.id, qty, options: {} });
    const est = await guest('POST', '/api/estimate', { printSelection: { family: 'stickers', items: [pick(size), pick(size2)] } });
    const labels = est.body.estimate.printOrder.items.map(i => i.label);
    const po = await guest('POST', '/api/quotes', {
      firstName: 'Sticker', lastName: 'Tester', email: `stick.${stamp}@example.com`, phone: '4785550101', termsAccepted: true, fulfillmentMethod: 'pickup', draftToken: dt,
      printSelection: { family: 'stickers', items: [pick(size), pick(size2)] },
      artworkLabels: { [(a1.file || a1).id]: `${labels[0]} - Artwork`, [(a2.file || a2).id]: `${labels[1]} - Artwork`, [(m2.file || m2).id]: `${labels[1]} - Approved Mockup` },
    });
    assert.strictEqual(po.status, 200, po.buffer.toString());
    const pt = (await admin('GET', `/api/admin/orders/${po.body.quoteCode}/production`)).body;
    assert.strictEqual(pt.items.length, 2, 'one item per design');
    assert.deepStrictEqual(pt.items.map(i => i.slots[0].customerArtwork.map(f => f.name)), [['sticker-one.png'], ['sticker-two.png']], 'each design keeps its own artwork');
    assert.deepStrictEqual(pt.items.map(i => i.slots[0].mockups.map(f => f.name)), [[], ['sticker-two-proof.png']], 'a mockup stays with the design it was approved for');
    assert.notStrictEqual(pt.items[0].slots[0].key, pt.items[1].slots[0].key);
    const fd = new FormData(); fd.append('slot', pt.items[1].slots[0].key); fd.append('kind', 'print_ready'); fd.append('file', new Blob([SVG], { type: 'image/svg+xml' }), 'sticker-two-cut.svg');
    const pr = (await admin('POST', `/api/admin/orders/${po.body.quoteCode}/assets`, fd)).body;
    assert.strictEqual(pr.items[0].slots[0].printReady, null);
    assert.strictEqual(pr.items[1].slots[0].printReady.name, 'sticker-two-cut.svg', 'a print ready file lands on the right design');
    const pz = Object.keys(unzip((await admin('GET', `/admin/orders/${po.body.quoteCode}/files.zip`)).buffer));
    assert.ok(pz.some(n => /^Print-Ready\/Design-2.*Artwork-Print-Ready\.svg$/.test(n)) && pz.some(n => /^Customer-Uploads\/Design-1.*Original\.png$/.test(n)), pz.join('\n'));
    assert.strictEqual((await admin('GET', `/admin/orders/${po.body.quoteCode}/production.pdf`)).headers.get('content-type'), 'application/pdf');
    console.log('  ok: a two-design sticker order keeps artwork, mockup and print ready file with the right design');
  } else {
    console.log('  (skipped the print product check: stickers are switched off in this database)');
  }

  // ---- 12) a garment color with no supplier photo is mocked up on a built-in flat ----
  const flat = await stranger('GET', '/flats/tee-front-1e3a8a.svg');
  assert.strictEqual(flat.status, 200);
  assert.ok(flat.headers.get('content-type').startsWith('image/svg+xml') && flat.buffer.toString().includes('#1e3a8a'), 'a flat is drawn in the garment color');
  for (const type of ['tee', 'longsleeve', 'sweatshirt', 'hoodie', 'polo', 'hat', 'tote']) for (const view of ['front', 'back']) assert.strictEqual((await stranger('GET', `/flats/${type}-${view}-ffffff.svg`)).status, 200, `${type} ${view} flat`);
  assert.strictEqual((await stranger('GET', '/flats/tee-front-zzzzzz.svg')).status, 404);
  const dt2 = (await guest('POST', '/api/draft-token', {})).body.draftToken;
  const fd2 = new FormData(); fd2.append('file', new Blob([png(300, 200, [204, 255, 0])], { type: 'image/png' }), 'logo.png'); fd2.append('draftToken', dt2); fd2.append('printLocationCode', 'front');
  const art2 = (await guest('POST', '/api/uploads', fd2)).body; const artFile = art2.file || art2;
  const flatOrder = await guest('POST', '/api/quotes', {
    firstName: 'Flat', lastName: 'Tester', email: `flat.${stamp}@example.com`, phone: '4785550102', termsAccepted: true, fulfillmentMethod: 'pickup', draftToken: dt2,
    garmentId: tee.id, printLocationIds: [front.id], colorSelections: [{ colorName: tee.colors[0].name, sizes: [{ label: 'M', qty: 6 }] }],
    placements: [{ locationCode: 'front', locationName: 'Front', view: 'front', colorName: tee.colors[0].name, fileName: 'logo.png', fileType: 'PNG', imageUrl: '/flats/tee-front-1e3a8a.svg', artworkUrl: artFile.url,
      zone: { x: 0.34, y: 0.21, w: 0.32, h: 0.34 }, design: { x: 0.36, y: 0.23, w: 0.28, h: 0.16 }, widthIn: 9.5, heightIn: 6.33, zoneWidthIn: 11, zoneHeightIn: 14, fromLeftIn: 0.75, fromTopIn: 0.75, designSize: 'standard' }],
  });
  assert.strictEqual(flatOrder.status, 200, flatOrder.buffer.toString());
  const flatTicket = (await admin('GET', `/api/admin/orders/${flatOrder.body.quoteCode}/production`)).body;
  const flatMock = flatTicket.items[0].slots[0].mockups[0];
  assert.ok(flatMock && flatMock.source === 'placement', 'the placement on a flat is saved with the order and stored as a mockup');
  const flatPng = await admin('GET', flatMock.viewUrl);
  assert.ok(flatPng.headers.get('content-type') === 'image/png' && flatPng.buffer.readUInt32BE(16) === 1000 && flatPng.buffer.readUInt32BE(20) === 1200, 'stored as a 1000 x 1200 PNG');
  console.log('  ok: built-in garment flats for every garment type; a flat mockup is stored like a photo mockup');

  await admin('PUT', '/api/admin/settings', { shopify_client_secret: settingsBefore.shopify_client_secret || '', email_provider: settingsBefore.email_provider || 'mock', payment_provider: settingsBefore.payment_provider || 'mock' });
  console.log('ALL PRODUCTION FILE CHECKS PASSED');
}

main().then(() => process.exit(0)).catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
