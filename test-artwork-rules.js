// Focused test for Task #24: artwork file-type rules (PNG, SVG, AI, PSD,
// PDF preferred; JPEG accepted but discouraged; everything else rejected)
// and the print-ready-art disclaimer policy. AI/PSD files don't have one
// reliable browser-reported MIME type, so the upload route falls back to
// checking the file extension when the MIME type is generic/unrecognized —
// this test proves that fallback works for the real formats (.ai, .psd)
// without accidentally opening the upload up to arbitrary files (.exe)
// just because they share the same generic 'application/octet-stream' type.
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function getDraftToken() {
  const resp = await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const { draftToken } = await resp.json();
  return draftToken;
}

async function uploadFile(draftToken, filename, mimeType, content = 'fake file content') {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: mimeType }), filename);
  fd.append('draftToken', draftToken);
  fd.append('printLocationCode', 'front');
  const resp = await fetch(`${BASE}/api/uploads`, { method: 'POST', body: fd });
  const json = await resp.json();
  return { ok: resp.ok, status: resp.status, json };
}

async function main() {
  console.log('=== ARTWORK RULES ===');

  // ---- 1) artwork_rules policy content mentions the real requirements ----
  const artworkPolicy = (await (await fetch(`${BASE}/api/policies/artwork_rules`)).json()).policy;
  assert(/PNG/.test(artworkPolicy.body) && /SVG/.test(artworkPolicy.body) && /AI/.test(artworkPolicy.body) && /PSD/.test(artworkPolicy.body) && /PDF/.test(artworkPolicy.body),
    'artwork_rules policy lists all 5 preferred file types');
  assert(/JPEG/i.test(artworkPolicy.body), 'artwork_rules policy mentions JPEG being discouraged');
  assert(/300 DPI/.test(artworkPolicy.body) && /CMYK/.test(artworkPolicy.body), 'artwork_rules policy states the 300 DPI / CMYK print-ready disclaimer');
  console.log('  ok: artwork_rules policy documents the accepted file types and the print-ready-art (300 DPI/CMYK) disclaimer');

  const draftToken = await getDraftToken();
  assert(draftToken, 'got a draft token to attach uploads to');

  // ---- 2) each preferred type uploads successfully ----
  const preferredCases = [
    ['design.png', 'image/png'],
    ['design.svg', 'image/svg+xml'],
    ['design.pdf', 'application/pdf'],
  ];
  for (const [filename, mime] of preferredCases) {
    const { ok, json } = await uploadFile(draftToken, filename, mime);
    assert(ok, `${filename} (${mime}) uploads successfully (got: ${JSON.stringify(json)})`);
  }
  console.log('  ok: PNG, SVG, and PDF all upload successfully by MIME type');

  // ---- 3) AI/PSD with a generic/octet-stream MIME type still upload, via extension fallback ----
  const aiResult = await uploadFile(draftToken, 'logo.ai', 'application/octet-stream');
  assert(aiResult.ok, `.ai file with a generic MIME type uploads via the extension fallback (got: ${JSON.stringify(aiResult.json)})`);
  const psdResult = await uploadFile(draftToken, 'mockup.psd', 'application/octet-stream');
  assert(psdResult.ok, `.psd file with a generic MIME type uploads via the extension fallback (got: ${JSON.stringify(psdResult.json)})`);
  console.log('  ok: .ai and .psd files upload correctly via the extension fallback, even with an unreliable/generic MIME type');

  // ---- 4) JPEG is still accepted (soft-discouraged, not blocked) ----
  const jpegResult = await uploadFile(draftToken, 'photo.jpg', 'image/jpeg');
  assert(jpegResult.ok, `JPEG still uploads successfully — discouraged, not blocked (got: ${JSON.stringify(jpegResult.json)})`);
  console.log('  ok: JPEG is still accepted (the "not preferred" guidance is a soft warning, not a hard block)');

  // ---- 5) a genuinely unsupported type is rejected with a clear error ----
  const txtResult = await uploadFile(draftToken, 'notes.txt', 'text/plain');
  assert(!txtResult.ok, 'a .txt file is rejected');
  assert(/unsupported file type/i.test(txtResult.json.error || ''), `rejection includes a clear "unsupported file type" error (got: ${JSON.stringify(txtResult.json)})`);
  console.log('  ok: an unsupported file type (.txt) is rejected with a clear error message');

  // ---- 6) the octet-stream fallback does NOT open the door to arbitrary file types ----
  // Same generic MIME type as the .ai/.psd cases above, but an extension
  // that was never on the allow-list — this is the actual security-relevant
  // check: proving the fallback is extension-scoped, not MIME-type-scoped.
  const exeResult = await uploadFile(draftToken, 'installer.exe', 'application/octet-stream');
  assert(!exeResult.ok, `an .exe file with the same generic MIME type as .ai/.psd is still rejected (got: ${JSON.stringify(exeResult.json)})`);
  console.log('  ok: the application/octet-stream fallback is scoped to known extensions (.ai/.psd) — an .exe with the same generic MIME type is still rejected');

  console.log('\n=== ALL ARTWORK RULES CHECKS PASSED ===');
}

main().catch(err => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
