// Focused check for the "new colors + garment image upload" feature round:
//  1. The 4 new colors (Soft Pink, Safety Orange, Safety Yellow, Safety Green)
//     are present on the customer-facing garment catalog for apparel items
//     that use the shared core palette, but NOT on garments with a custom,
//     smaller palette (Hat/Cap, Tote Bag) — seed.js's back-fill pass should
//     be scoped correctly, not blanket-applied to every garment.
//  2. Re-running the seed migration on a DB that predates these colors
//     back-fills them in (without duplicating colors that already exist).
//  3. The admin garment-image upload endpoint accepts an image, stores it,
//     updates the garment's image_url, rejects disallowed file types, and
//     requires admin auth.
const assert = require('assert');

const BASE = 'http://localhost:4790';
const NEW_COLORS = ['Soft Pink', 'Safety Orange', 'Safety Yellow', 'Safety Green'];

function tinyPngBlob() {
  // 1x1 red PNG, valid enough for multer's mimetype-based filter + a real write to disk.
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  return new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' });
}

async function main() {
  console.log('=== NEW COLORS + GARMENT IMAGE UPLOAD ===');

  // ---- 1) customer-facing catalog has the new colors on core-palette garments ----
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  assert(tee, 'Standard Quality T-Shirt is in the customer catalog');
  const teeColorNames = tee.colors.map(c => c.name);
  for (const name of NEW_COLORS) {
    assert(teeColorNames.includes(name), `T-shirt color list includes "${name}"`);
  }
  console.log('  ok: core-palette garment (T-Shirt) has all 4 new colors');

  const hat = garments.find(g => g.name === 'Hat / Cap');
  assert(hat, 'Hat / Cap is in the customer catalog');
  const hatColorNames = hat.colors.map(c => c.name);
  for (const name of NEW_COLORS) {
    assert(!hatColorNames.includes(name), `Hat/Cap color list correctly does NOT include "${name}" (custom palette, not core)`);
  }
  console.log('  ok: custom-palette garment (Hat/Cap) was left alone by the back-fill');

  // ---- 2) migration back-fill is idempotent and actually re-runnable ----
  const db = require('./server/db');
  await db.ready;
  const hoodie = db.prepare("SELECT id FROM garments WHERE name='Hoodie'").get();
  db.prepare(`DELETE FROM garment_colors WHERE garment_id=? AND name IN (${NEW_COLORS.map(() => '?').join(',')})`)
    .run(hoodie.id, ...NEW_COLORS);
  const strippedCount = db.prepare('SELECT COUNT(*) as n FROM garment_colors WHERE garment_id=?').get(hoodie.id).n;
  assert.strictEqual(strippedCount, 6, 'test setup: Hoodie now back down to the original 6 colors');

  const runSeed = require('./server/seed');
  runSeed();
  runSeed(); // run twice to prove the back-fill doesn't duplicate rows

  const afterColors = db.prepare('SELECT name FROM garment_colors WHERE garment_id=?').all(hoodie.id).map(c => c.name);
  for (const name of NEW_COLORS) {
    assert(afterColors.includes(name), `Hoodie has "${name}" back-filled after re-seeding`);
  }
  assert.strictEqual(afterColors.length, 10, `Hoodie has exactly 10 colors after double re-seed, no duplicates (got ${afterColors.length}: ${afterColors.join(', ')})`);
  console.log('  ok: re-running seed back-fills missing core colors onto existing garments, idempotently');

  // ---- 3) admin image upload ----
  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  assert(loginResp.ok, 'admin login succeeds');
  const cookie = loginResp.headers.get('set-cookie');
  assert(cookie, 'admin login returns a session cookie');

  const adminGarments = await (await fetch(`${BASE}/api/admin/garments`, { headers: { Cookie: cookie } })).json();
  const targetGarment = adminGarments.garments.find(g => g.name === 'Standard Quality T-Shirt');
  const originalImageUrl = targetGarment.image_url;

  // 3a) unauthenticated upload is rejected
  const fd1 = new FormData();
  fd1.append('image', tinyPngBlob(), 'test.png');
  const unauthResp = await fetch(`${BASE}/api/admin/garments/${targetGarment.id}/image`, { method: 'POST', body: fd1 });
  assert.strictEqual(unauthResp.status, 401, 'image upload without admin session is rejected (401)');
  console.log('  ok: garment image upload requires admin auth');

  // 3b) disallowed file type is rejected
  const fd2 = new FormData();
  fd2.append('image', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'notes.txt');
  const badTypeResp = await fetch(`${BASE}/api/admin/garments/${targetGarment.id}/image`, { method: 'POST', headers: { Cookie: cookie }, body: fd2 });
  assert.strictEqual(badTypeResp.status, 400, 'uploading a non-image file type is rejected (400)');
  console.log('  ok: disallowed file types are rejected');

  // 3c) valid upload succeeds, persists, and updates the catalog
  const fd3 = new FormData();
  fd3.append('image', tinyPngBlob(), 'garment-photo.png');
  const uploadResp = await fetch(`${BASE}/api/admin/garments/${targetGarment.id}/image`, { method: 'POST', headers: { Cookie: cookie }, body: fd3 });
  assert(uploadResp.ok, 'valid image upload succeeds');
  const { imageUrl } = await uploadResp.json();
  assert(imageUrl && imageUrl.startsWith('/uploads/'), `upload response returns a stored image URL (got "${imageUrl}")`);
  assert.notStrictEqual(imageUrl, originalImageUrl, 'new image URL differs from whatever was there before');

  const fileCheck = await fetch(`${BASE}${imageUrl}`);
  assert(fileCheck.ok, 'the uploaded image is actually servable back from /uploads');
  console.log('  ok: valid image upload is stored and immediately servable');

  const refetched = await (await fetch(`${BASE}/api/admin/garments`, { headers: { Cookie: cookie } })).json();
  const updatedGarment = refetched.garments.find(g => g.id === targetGarment.id);
  assert.strictEqual(updatedGarment.image_url, imageUrl, "garment's image_url in the DB matches the uploaded file");
  console.log('  ok: uploaded image URL is persisted on the garment record');

  // 3d) uploading to a nonexistent garment 404s cleanly
  const fd4 = new FormData();
  fd4.append('image', tinyPngBlob(), 'x.png');
  const missingResp = await fetch(`${BASE}/api/admin/garments/999999/image`, { method: 'POST', headers: { Cookie: cookie }, body: fd4 });
  assert.strictEqual(missingResp.status, 404, 'uploading to a nonexistent garment id returns 404');
  console.log('  ok: nonexistent garment id is handled cleanly (404, not a crash)');

  console.log('\n=== GARMENT COLOR/IMAGE CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
