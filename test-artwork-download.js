// Artwork download: every uploaded file (image AND PDF) must be downloadable
// by an admin from both the Artwork tab and the quote detail, as a real
// attachment under the customer's original filename. Logged-out requests
// must be refused. Runs against a server already listening on :4790.
const assert = require('assert');

const BASE = 'http://localhost:4790';
let cookie = '';

async function call(method, path, body, isForm) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  });
  const sc = resp.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return resp;
}

async function main() {
  console.log('=== ARTWORK DOWNLOAD ===');
  const { draftToken } = await (await call('POST', '/api/draft-token')).json();

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const uploads = [
    { name: 'Front Logo.png', type: 'image/png', bytes: png, code: 'front' },
    { name: 'Back Design.pdf', type: 'application/pdf', bytes: pdf, code: 'back' },
  ];
  for (const u of uploads) {
    const form = new FormData();
    form.append('draftToken', draftToken);
    form.append('printLocationCode', u.code);
    form.append('file', new Blob([u.bytes], { type: u.type }), u.name);
    const r = await call('POST', '/api/uploads', form, true);
    assert.strictEqual(r.status, 200, `upload ${u.name}`);
  }

  const { garments } = await (await call('GET', '/api/garments')).json();
  const { printLocations } = await (await call('GET', '/api/print-locations')).json();
  const tee = garments[0];
  const q = await call('POST', '/api/quotes', {
    firstName: 'Art', lastName: 'Download', email: 'art@example.com', phone: '4785551234', termsAccepted: true,
    garmentId: tee.id, colorSelections: [{ colorName: 'Black', sizes: [{ label: 'L', qty: 2 }] }],
    printLocationIds: printLocations.filter(l => ['front', 'back'].includes(l.code)).map(l => l.id),
    fulfillmentMethod: 'pickup', draftToken,
  });
  const qBody = await q.json();
  assert.strictEqual(q.status, 200, 'quote created: ' + JSON.stringify(qBody));
  const quoteCode = qBody.quoteCode || (qBody.quote && qBody.quote.quote_code);

  // logged out: refused
  const noAuth = await fetch(BASE + '/api/admin/artwork/1/download');
  assert.strictEqual(noAuth.status, 401, 'logged-out download is refused');
  console.log('  ok: logged-out download returns 401');

  const login = await call('POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' });
  assert.strictEqual(login.status, 200, 'admin login');

  const { artwork } = await (await call('GET', '/api/admin/artwork')).json();
  const mine = artwork.filter(a => a.quote_code === quoteCode);
  assert.strictEqual(mine.length, 2, 'both files show on the Artwork tab');
  for (const f of mine) {
    assert.ok(f.downloadUrl, 'Artwork tab entry has a downloadUrl');
    const r = await call('GET', f.downloadUrl);
    assert.strictEqual(r.status, 200, `download ${f.original_filename}`);
    const cd = r.headers.get('content-disposition') || '';
    assert.ok(/attachment/i.test(cd), `${f.original_filename} is sent as an attachment (got "${cd}")`);
    assert.ok(cd.includes(f.original_filename.split(' ')[0]), `${f.original_filename} keeps its original filename`);
    const got = Buffer.from(await r.arrayBuffer());
    const want = uploads.find(u => u.name === f.original_filename).bytes;
    assert.ok(got.equals(want), `${f.original_filename} bytes match what was uploaded`);
    console.log(`  ok: ${f.original_filename} downloads as an attachment with identical bytes`);
  }

  const detail = await (await call('GET', '/api/admin/quotes/' + quoteCode)).json();
  assert.ok(detail.artwork.length === 2 && detail.artwork.every(a => a.downloadUrl), 'quote detail artwork has downloadUrls');
  console.log('  ok: quote detail artwork entries carry downloadUrls');

  const missing = await call('GET', '/api/admin/artwork/99999999/download');
  assert.strictEqual(missing.status, 404, 'unknown artwork id is a 404');
  console.log('  ok: unknown artwork id returns 404');

  console.log('\n=== ARTWORK DOWNLOAD CHECKS PASSED ===');
}

main().catch(err => { console.error('ARTWORK DOWNLOAD TEST FAILED:', err); process.exit(1); });
