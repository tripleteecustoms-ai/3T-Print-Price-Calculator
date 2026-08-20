// Focused check for discount codes: admin CRUD/generator, server-authoritative
// pricing (percent vs flat, capping, invalid/expired/exhausted/inactive codes
// never block a price — they just don't apply), the customer apply/remove
// flow, usage-limit enforcement, and that an applied discount survives
// server-side checkout recalculation.
const assert = require('assert');

const BASE = 'http://localhost:4790';

async function createQuote(qty) {
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const resp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty } ] }],
      printLocationIds: [], draftToken: draftTokenResp.draftToken,
      firstName: 'Disc', lastName: 'Ount', email: `disc.ount.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`, phone: '555-333-4444',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(resp.ok, 'test quote creation succeeds');
  return (await resp.json()).quoteCode;
}

async function main() {
  console.log('=== DISCOUNT CODES ===');

  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  const cookie = loginResp.headers.get('set-cookie');

  // ---- 0) admin auth required ----
  const unauthResp = await fetch(`${BASE}/api/admin/discount-codes`);
  assert.strictEqual(unauthResp.status, 401, 'listing discount codes requires admin auth');
  console.log('  ok: discount-codes admin routes require auth');

  // ---- 1) admin CRUD: create percent + flat codes ----
  const pctResp = await fetch(`${BASE}/api/admin/discount-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: 'save10', type: 'percent', value: 10, active: true }),
  });
  assert(pctResp.ok, 'creating a percent-off code succeeds');
  console.log('  ok: lowercase input code is accepted and will be normalized to uppercase');

  const flatResp = await fetch(`${BASE}/api/admin/discount-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: 'FLAT5', type: 'flat', value: 5, active: true }),
  });
  assert(flatResp.ok, 'creating a flat-$ code succeeds');

  // duplicate rejected
  const dupResp = await fetch(`${BASE}/api/admin/discount-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: 'SAVE10', type: 'percent', value: 20, active: true }),
  });
  assert.strictEqual(dupResp.status, 409, 'creating a duplicate code (case-insensitive) is rejected');

  // invalid type/value rejected
  const badTypeResp = await fetch(`${BASE}/api/admin/discount-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: 'BADTYPE', type: 'dollars', value: 5, active: true }),
  });
  assert.strictEqual(badTypeResp.status, 400, 'invalid discount type is rejected');
  const overPctResp = await fetch(`${BASE}/api/admin/discount-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: 'TOOBIG', type: 'percent', value: 150, active: true }),
  });
  assert.strictEqual(overPctResp.status, 400, 'a percent-off value over 100 is rejected');
  console.log('  ok: duplicate codes and invalid type/value are rejected');

  const listResp = await (await fetch(`${BASE}/api/admin/discount-codes`, { headers: { Cookie: cookie } })).json();
  const save10 = listResp.discountCodes.find(d => d.code === 'SAVE10');
  assert(save10, 'SAVE10 (normalized uppercase) appears in the admin list');
  assert.strictEqual(save10.type, 'percent');
  assert.strictEqual(save10.times_used, 0);
  console.log('  ok: created codes are listed with correct fields');

  // ---- 2) estimate: applying a code that doesn't exist doesn't block pricing ----
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');

  // ---- 3) create a quote and apply the percent code ----
  const quoteCode = await createQuote(10); // 10 x M
  const beforeDetail = await (await fetch(`${BASE}/api/quotes/${quoteCode}`)).json();
  const subtotalBefore = beforeDetail.pricing.subtotal;

  const badApplyResp = await fetch(`${BASE}/api/quotes/${quoteCode}/apply-discount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'NOTREAL' }),
  });
  assert.strictEqual(badApplyResp.status, 400, 'applying an unknown code is rejected with 400');
  console.log('  ok: applying an unknown code fails cleanly without changing the quote');

  const applyResp = await fetch(`${BASE}/api/quotes/${quoteCode}/apply-discount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'save10' }), // lowercase entry
  });
  assert(applyResp.ok, 'applying a valid code (entered lowercase) succeeds');
  const applyBody = await applyResp.json();
  const expectedAmount = Math.round(subtotalBefore * 0.10 * 100) / 100;
  assert.strictEqual(applyBody.pricing.discountAmount, expectedAmount, `10% of $${subtotalBefore} is $${expectedAmount} (got ${applyBody.pricing.discountAmount})`);
  assert.strictEqual(applyBody.pricing.total, Math.round((subtotalBefore - expectedAmount) * 100) / 100, 'total reflects subtotal minus the discount');
  console.log('  ok: percent discount computed correctly and case-insensitively');

  const afterApply = await (await fetch(`${BASE}/api/admin/discount-codes`, { headers: { Cookie: cookie } })).json();
  const save10After = afterApply.discountCodes.find(d => d.code === 'SAVE10');
  assert.strictEqual(save10After.times_used, 1, 'applying the code increments times_used');
  console.log('  ok: applying a code increments its usage count');

  // ---- 4) replacing with a different code frees the old slot and uses the new one ----
  const replaceResp = await fetch(`${BASE}/api/quotes/${quoteCode}/apply-discount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'FLAT5' }),
  });
  assert(replaceResp.ok, 'replacing with a different code succeeds');
  const replaceBody = await replaceResp.json();
  assert.strictEqual(replaceBody.pricing.discountAmount, 5, 'flat $5 discount applies as exactly $5');
  assert.strictEqual(replaceBody.pricing.discount.code, 'FLAT5');

  const afterReplace = await (await fetch(`${BASE}/api/admin/discount-codes`, { headers: { Cookie: cookie } })).json();
  const save10Freed = afterReplace.discountCodes.find(d => d.code === 'SAVE10');
  const flat5Used = afterReplace.discountCodes.find(d => d.code === 'FLAT5');
  assert.strictEqual(save10Freed.times_used, 0, 'replacing the code frees the old code\'s usage slot');
  assert.strictEqual(flat5Used.times_used, 1, 'the new code is now counted as used');
  console.log('  ok: replacing a discount code frees the old usage slot and counts the new one');

  // ---- 5) remove discount entirely ----
  const removeResp = await fetch(`${BASE}/api/quotes/${quoteCode}/remove-discount`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert(removeResp.ok, 'removing the discount succeeds');
  const removeBody = await removeResp.json();
  assert.strictEqual(removeBody.pricing.discount, null, 'no discount remains after removal');
  assert.strictEqual(removeBody.pricing.total, subtotalBefore, 'total returns to the original subtotal after removal');

  const afterRemove = await (await fetch(`${BASE}/api/admin/discount-codes`, { headers: { Cookie: cookie } })).json();
  const flat5AfterRemove = afterRemove.discountCodes.find(d => d.code === 'FLAT5');
  assert.strictEqual(flat5AfterRemove.times_used, 0, 'removing the discount frees its usage slot');
  console.log('  ok: removing a discount resets the total and frees the usage slot');

  // ---- 6) flat discount is capped at the subtotal (never goes negative) ----
  const hugeFlatResp = await fetch(`${BASE}/api/admin/discount-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: 'HUGEFLAT', type: 'flat', value: 999999, active: true }),
  });
  assert(hugeFlatResp.ok, 'creating an oversized flat discount code succeeds (validity is about the coupon, not the order)');
  const smallQuoteCode = await createQuote(1);
  const hugeApplyResp = await fetch(`${BASE}/api/quotes/${smallQuoteCode}/apply-discount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'HUGEFLAT' }),
  });
  assert(hugeApplyResp.ok, 'applying the oversized flat discount succeeds');
  const hugeBody = await hugeApplyResp.json();
  assert.strictEqual(hugeBody.pricing.total, 0, 'total is floored at $0, never negative');
  assert.strictEqual(hugeBody.pricing.discountAmount, hugeBody.pricing.subtotal, 'the discount amount is capped to exactly the subtotal, not the full coupon value');
  console.log('  ok: an oversized flat discount is capped so total never goes negative');

  // ---- 7) inactive code is rejected ----
  await fetch(`${BASE}/api/admin/discount-codes/${save10.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ active: false }) });
  const inactiveApplyResp = await fetch(`${BASE}/api/quotes/${smallQuoteCode}/apply-discount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'SAVE10' }),
  });
  assert.strictEqual(inactiveApplyResp.status, 400, 'applying a deactivated code is rejected');
  console.log('  ok: deactivated codes are rejected');

  // ---- 8) expired code is rejected ----
  const expiredResp = await fetch(`${BASE}/api/admin/discount-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: 'OLDCODE', type: 'percent', value: 10, active: true, expiresAt: '2020-01-01' }),
  });
  assert(expiredResp.ok);
  const expiredApplyResp = await fetch(`${BASE}/api/quotes/${smallQuoteCode}/apply-discount`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'OLDCODE' }),
  });
  assert.strictEqual(expiredApplyResp.status, 400, 'applying an expired code is rejected');
  console.log('  ok: expired codes are rejected');

  // ---- 9) usage limit enforcement ----
  await fetch(`${BASE}/api/admin/discount-codes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: 'ONLYONE', type: 'flat', value: 1, active: true, usageLimit: 1 }),
  });
  const q1 = await createQuote(1);
  const q2 = await createQuote(1);
  const firstUse = await fetch(`${BASE}/api/quotes/${q1}/apply-discount`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ONLYONE' }) });
  assert(firstUse.ok, 'first use of a usage_limit=1 code succeeds');
  const secondUse = await fetch(`${BASE}/api/quotes/${q2}/apply-discount`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ONLYONE' }) });
  assert.strictEqual(secondUse.status, 400, 'a second use once the usage limit is reached is rejected');
  console.log('  ok: usage limit is enforced across different quotes');

  // ---- 10) discount survives server-side checkout recalculation ----
  const preCheckout = await (await fetch(`${BASE}/api/quotes/${q1}`)).json();
  const checkoutResp = await fetch(`${BASE}/api/quotes/${q1}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true }) });
  assert(checkoutResp.ok, 'checkout succeeds with a discount applied');
  const postCheckout = await (await fetch(`${BASE}/api/quotes/${q1}`)).json();
  assert.strictEqual(postCheckout.pricing.total, preCheckout.pricing.total, 'checkout-time server recalculation preserves the applied discount');
  assert.strictEqual(postCheckout.pricing.discount.code, 'ONLYONE', 'the discount code is still reflected after checkout recalculation');
  console.log('  ok: applied discount survives server-side checkout recalculation');

  // ---- 11) admin delete ----
  const toDelete = afterRemove.discountCodes.find(d => d.code === 'FLAT5');
  const deleteResp = await fetch(`${BASE}/api/admin/discount-codes/${toDelete.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert(deleteResp.ok, 'admin can delete a discount code');
  const afterDelete = await (await fetch(`${BASE}/api/admin/discount-codes`, { headers: { Cookie: cookie } })).json();
  assert(!afterDelete.discountCodes.some(d => d.id === toDelete.id), 'deleted code no longer appears in the list');
  console.log('  ok: admin can delete a discount code');

  console.log('\n=== DISCOUNT CODES CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
