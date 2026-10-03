// Print products (stickers / posters / mylar packs / yard signs): the
// admin-edited catalog, server-authoritative pricing through the same
// /api/estimate and /api/quotes paths apparel uses (listed and custom
// quantities, custom sizes, price tables chosen by option combination,
// per-piece and flat options, add-ons, design fees), the "switched off"
// gate, the structured order stored on a quote, flat shipping at checkout,
// frozen prices at checkout, discounts and owner overrides on a print
// quote, and that apparel pricing is untouched. Runs against a server on
// :4790; the catalog it finds is put back at the end.
const assert = require('assert');
const { DEFAULT_CATALOG } = require('./server/printProducts');

const BASE = 'http://localhost:4790';
const json = (body, cookie) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });

async function estimate(printSelection) {
  const resp = await fetch(`${BASE}/api/estimate`, json({ printSelection }));
  return { status: resp.status, body: await resp.json() };
}

async function createQuote(printSelection, extra) {
  const { draftToken } = await (await fetch(`${BASE}/api/draft-token`, json({}))).json();
  const resp = await fetch(`${BASE}/api/quotes`, json({
    printSelection, draftToken,
    firstName: 'Print', lastName: 'Order', email: `print.order.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`, phone: '555-222-1111',
    fulfillmentMethod: 'pickup', termsAccepted: true, ...extra,
  }));
  const body = await resp.json();
  assert(resp.ok, `print quote creation succeeds (${body.error || resp.status})`);
  return body.quoteCode;
}

async function main() {
  console.log('=== PRINT PRODUCTS ===');

  // ---- 0) admin auth required ----
  assert.strictEqual((await fetch(`${BASE}/api/admin/print-catalog`)).status, 401, 'reading the print catalog requires admin auth');
  assert.strictEqual((await fetch(`${BASE}/api/admin/print-catalog`, { ...json({}), method: 'PUT' })).status, 401, 'saving the print catalog requires admin auth');
  assert.strictEqual((await fetch(`${BASE}/api/admin/print-catalog/image`, { method: 'POST' })).status, 401, 'uploading a premade design picture requires admin auth');
  console.log('  ok: print-catalog admin routes require auth');

  const loginResp = await fetch(`${BASE}/api/admin/login`, json({ username: 'admin', password: '3tprint-admin-2026' }));
  const cookie = loginResp.headers.get('set-cookie');
  const saveCatalog = async (catalog) => {
    const resp = await fetch(`${BASE}/api/admin/print-catalog`, { ...json(catalog, cookie), method: 'PUT' });
    return { status: resp.status, body: await resp.json() };
  };
  const original = await (await fetch(`${BASE}/api/admin/print-catalog`, { headers: { Cookie: cookie } })).json();
  assert.deepStrictEqual(original.families.map(f => f.key), ['stickers', 'posters', 'mylar', 'yardsigns'], 'the catalog always has the four product types');

  // A known catalog for the checks below: the shipped defaults (the owner's
  // price tables), with stickers, mylar and yard signs on and posters off.
  const test = JSON.parse(JSON.stringify(DEFAULT_CATALOG));
  const byKey = (key) => test.families.find(f => f.key === key);
  byKey('stickers').active = true;
  byKey('stickers').products[0].maxQty = 500;
  byKey('stickers').products[0].costEach = 0.5;
  byKey('posters').active = false;
  byKey('mylar').active = true;
  byKey('mylar').products[0].design.templates = [{ id: 't1', name: 'Template One', category: 'signature', imageUrl: '', backImageUrl: '' }];
  byKey('yardsigns').active = true;

  try {
    // ---- 1) the catalog is validated on save ----
    const dupQty = JSON.parse(JSON.stringify(test));
    dupQty.families[0].products[0].sizes[0].packs.push({ qty: 25, price: 1 });
    assert.strictEqual((await saveCatalog(dupQty)).status, 400, 'a size cannot list the same quantity twice');
    const noPrice = JSON.parse(JSON.stringify(test));
    noPrice.families[0].products[0].sizes[0].packs[0].price = -5;
    assert.strictEqual((await saveCatalog(noPrice)).status, 400, 'a quantity needs a valid price');
    const saved = await saveCatalog(test);
    assert.strictEqual(saved.status, 200, 'a well-formed catalog saves');
    console.log('  ok: catalog is validated on save');

    // ---- 2) public catalog: only switched-on types expose products, only priced sizes, never costs ----
    const pub = await (await fetch(`${BASE}/api/print-catalog`)).json();
    const pubBy = (key) => pub.families.find(f => f.key === key);
    assert.strictEqual(pubBy('posters').active, false);
    assert.strictEqual(pubBy('posters').products.length, 0, 'a switched-off type exposes no products');
    assert.strictEqual(pubBy('stickers').products[0].sizes.length, 9);
    assert.deepStrictEqual(pubBy('mylar').products.map(p => p.id), ['myl-std', 'myl-pound'], 'products without any prices yet (zip, rectangular) are not offered');
    assert(!JSON.stringify(pub).includes('costEach'), 'the public catalog never includes cost');
    console.log('  ok: public catalog hides switched-off types, unpriced products and costs');

    // ---- 3) sticker price table: the listed price is the order price ----
    const STICKERS = { '2x2': [30, 45, 75], '2x4': [35, 55, 85], '3x3': [45, 65, 105], '3x5': [45, 75, 120], '4x4': [60, 85, 140], '4x5': [55, 90, 150], '5x5': [65, 110, 185], '5x6': [75, 135, 215], '8x8': [160, 285, 480] };
    for (const [sizeId, prices] of Object.entries(STICKERS)) {
      for (const [i, qty] of [25, 50, 100].entries()) {
        const res = await estimate({ family: 'stickers', productId: 'stk-gloss', sizeId, qty });
        assert.strictEqual(res.body.estimate.total, prices[i], `${qty} × ${sizeId} stickers is $${prices[i]}`);
      }
    }
    const stk = { family: 'stickers', productId: 'stk-gloss', sizeId: '3x3', qty: 50 };
    let r = await estimate(stk);
    assert.strictEqual(r.body.estimate.printOrder.unitPrice, 1.3, 'per-piece display price: $1.30 each');
    assert(!('internal' in r.body.estimate) && !('floorUnit' in r.body.estimate), 'no internal cost/margin fields reach the customer');
    r = await estimate({ ...stk, price: 1, total: 1 });
    assert.strictEqual(r.body.estimate.total, 65, 'a client-supplied price is ignored');
    console.log('  ok: sticker prices match the price table for every size and quantity');

    // ---- 3b) posters: eight sizes, 1 / 5 / 10 totals exactly as listed ----
    const withPosters = JSON.parse(JSON.stringify(test));
    withPosters.families.find(f => f.key === 'posters').active = true;
    await saveCatalog(withPosters);
    const POSTERS = { '5x7': [5, 20, 35], '8x10': [7, 30, 50], '11x14': [10, 40, 70], '12x18': [13, 50, 85], '16x20': [20, 60, 100], '18x24': [24, 75, 120], '20x30': [32, 125, 220], '24x36': [40, 160, 280] };
    const posterPub = (await (await fetch(`${BASE}/api/print-catalog`)).json()).families.find(f => f.key === 'posters');
    assert.deepStrictEqual(posterPub.products[0].sizes.map(s => s.id), Object.keys(POSTERS), 'exactly the eight poster sizes, in order');
    for (const [sizeId, prices] of Object.entries(POSTERS)) {
      for (const [i, qty] of [1, 5, 10].entries()) {
        const res = await estimate({ family: 'posters', productId: 'poster', sizeId, qty });
        assert.strictEqual(res.body.estimate.total, prices[i], `${qty} × ${sizeId} posters is $${prices[i]}`);
      }
    }
    r = await estimate({ family: 'posters', productId: 'poster', sizeId: '24x36', qty: 10 });
    assert.strictEqual(r.body.estimate.printOrder.unitPrice, 28, '24×36 × 10: $28.00 each');
    await saveCatalog(test);
    console.log('  ok: poster prices match the price table for every size and quantity');

    // ---- 4) mylar: base price straight from the table (quantity × sides × finish) ----
    const MYLAR = {
      'single|unlaminated': [15, 30, 50, 70, 120, 210, 380], 'single|laminated': [55, 70, 90, 110, 160, 250, 420],
      'double|unlaminated': [20, 40, 70, 90, 160, 300, 560], 'double|laminated': [60, 80, 110, 130, 200, 340, 600],
    };
    const myl = (qty, sides, lamination, more) => ({ family: 'mylar', productId: 'myl-std', sizeId: '3.5', qty, options: { sides, lamination }, ...more });
    for (const [key, prices] of Object.entries(MYLAR)) {
      const [sides, lamination] = key.split('|');
      for (const [i, qty] of [1, 8, 16, 32, 64, 128, 256].entries()) {
        const res = await estimate(myl(qty, sides, lamination));
        assert.strictEqual(res.body.estimate.total, prices[i], `${qty} ${sides} ${lamination} packs is $${prices[i]}`);
        assert.strictEqual(res.body.estimate.addonLines.length, 0, 'sides and lamination are in the base price, never an extra line');
      }
    }
    r = await estimate({ family: 'mylar', productId: 'myl-std', sizeId: '3.5', qty: 32 });
    assert.strictEqual(r.body.estimate.total, 70, 'with nothing chosen yet: single-sided, unlaminated');
    r = await estimate(myl(32, 'double', 'laminated'));
    assert.strictEqual(r.body.estimate.printOrder.unitPrice, 4.0625, '$130 / 32 = $4.06 each');
    assert.deepStrictEqual(r.body.estimate.printOrder.canvas, { width: 3.625, height: 4.7, unit: 'in', background: '#FFFFFF' }, 'the 3.5 pack label is the print canvas');
    console.log('  ok: mylar prices match the price table for every quantity, side and finish');

    // ---- 4b) bag color: black and white included, any other color +$0.25 a pack, on top of the base ----
    r = await estimate(myl(32, 'double', 'laminated', { options: { sides: 'double', lamination: 'laminated', color: 'purple' } }));
    assert.strictEqual(r.body.estimate.baseLineTotal, 130);
    assert.strictEqual(r.body.estimate.total, 138, '32 purple packs: $130 base + $8.00 color upgrade');
    r = await estimate(myl(128, 'double', 'laminated', { options: { sides: 'double', lamination: 'laminated', color: 'holographic' } }));
    assert.strictEqual(r.body.estimate.total, 372, '128 double laminated $340 + $32 color upgrade');
    r = await estimate(myl(128, 'double', 'laminated', { options: { sides: 'double', lamination: 'laminated', color: 'white' } }));
    assert.strictEqual(r.body.estimate.total, 340, 'white bags are standard');
    assert.strictEqual((await estimate(myl(32, 'double', 'laminated', { options: { color: 'plaid' } }))).status, 400, 'an unknown choice is rejected');
    console.log('  ok: bag color surcharge is added on top of the base price');

    // ---- 4c) pound bag: $30 alone, $20 with 64 packs or more ----
    r = await estimate({ family: 'mylar', productId: 'myl-pound', sizeId: 'pound', qty: 1 });
    assert.strictEqual(r.body.estimate.total, 30, 'a pound bag on its own is $30');
    r = await estimate(myl(64, 'single', 'unlaminated', { addonIds: ['pound-bag'] }));
    assert.strictEqual(r.body.estimate.total, 140, '64 packs $120 + matching pound bag $20');
    assert.strictEqual((await estimate(myl(32, 'single', 'unlaminated', { addonIds: ['pound-bag'] }))).status, 400, 'the $20 pound bag needs 64 packs or more');
    assert.strictEqual((await estimate(myl(64, 'single', 'unlaminated', { addonIds: ['nope'] }))).status, 400, 'an unknown add-on is rejected');
    console.log('  ok: pound bag pricing follows the half-pound rule');

    // ---- 4d) order insurance (5% of the order, only when kept ticked) and the misprints preference ----
    r = await estimate(myl(64, 'single', 'unlaminated'));
    assert.strictEqual(r.body.estimate.total, 120, 'no insurance unless the customer keeps it selected');
    r = await estimate(myl(64, 'single', 'unlaminated', { insurance: true }));
    assert.strictEqual(r.body.estimate.total, 126, '5% insurance on a $120 order is $6');
    assert.strictEqual(r.body.estimate.printOrder.breakdown.insurance, 6);
    r = await estimate(myl(64, 'single', 'unlaminated', { insurance: true, options: { sides: 'single', lamination: 'unlaminated', color: 'purple' } }));
    assert.strictEqual(r.body.estimate.total, 142.8, 'insurance covers the color upgrade too: ($120 + $16) × 1.05');
    assert.deepStrictEqual(r.body.estimate.printOrder.breakdown, { products: 120, options: 16, design: 0, addons: 0, insurance: 6.8 });
    r = await estimate({ ...{ family: 'stickers', productId: 'stk-gloss', sizeId: '3x3', qty: 50 }, insurance: true });
    assert.strictEqual(r.body.estimate.total, 65, 'insurance is only charged where the product offers it');
    r = await estimate(myl(64, 'single', 'unlaminated', { includeMisprints: true }));
    assert.strictEqual(r.body.estimate.total, 120, 'including misprints is a preference, not a charge');
    assert.strictEqual(r.body.estimate.printOrder.includeMisprints, true);
    console.log('  ok: order insurance and the misprints preference');

    // ---- 4e) one price for every screen: the estimate also carries rush, shipping and tax ----
    const full = await (await fetch(`${BASE}/api/estimate`, json({ printSelection: myl(64, 'single', 'unlaminated'), rush: true, fulfillmentMethod: 'shipping' }))).json();
    assert.strictEqual(full.checkout.rushFee, 24, 'rush is 20% of the $120 order');
    assert.strictEqual(full.checkout.shippingFee, 11.99);
    assert.strictEqual(full.checkout.grandTotal, Math.round((120 + 24 + full.checkout.taxAmount + 11.99) * 100) / 100);
    console.log('  ok: the estimate includes rush, shipping and tax');

    // ---- 5) only listed products / sizes, and only switched-on types ----
    assert.strictEqual((await estimate({ ...stk, qty: 10 })).status, 400, 'a quantity below the smallest listed one is rejected');
    assert.strictEqual((await estimate({ ...stk, qty: 501 })).status, 400, 'a quantity over the product maximum is rejected');
    assert.strictEqual((await estimate({ ...stk, sizeId: 'nope' })).status, 400, 'an unknown size is rejected');
    assert.strictEqual((await estimate({ ...stk, productId: 'nope' })).status, 400, 'an unknown product is rejected');
    assert.strictEqual((await estimate({ family: 'mylar', productId: 'myl-zip', sizeId: 'zip', qty: 8 })).status, 400, 'a product that is not on sale cannot be priced');
    assert.strictEqual((await estimate({ family: 'posters', productId: 'poster', sizeId: '11x14', qty: 1 })).status, 400, 'a switched-off type cannot be priced');
    assert.strictEqual((await estimate({ family: 'nope' })).status, 400, 'an unknown type is rejected');
    console.log('  ok: unlisted selections and switched-off types are rejected');

    // ---- 5b) custom quantities: the per-piece rate of the listed quantity below, capped at the next one up ----
    r = await estimate({ ...stk, qty: 30 });
    assert.strictEqual(r.body.estimate.total, 54, '30 stickers at the 25 rate ($1.80 each)');
    r = await estimate({ ...stk, qty: 49 });
    assert.strictEqual(r.body.estimate.total, 65, '49 stickers never cost more than 50');
    r = await estimate({ ...stk, qty: 200 });
    assert.strictEqual(r.body.estimate.total, 210, 'above the largest listed quantity uses its per-piece rate ($1.05)');
    r = await estimate(myl(100, 'double', 'laminated'));
    assert.strictEqual(r.body.estimate.total, 312.5, '100 double laminated packs at the 64 rate ($3.125 each)');
    console.log('  ok: custom quantities use the nearest lower rate, capped at the next listed price');

    // ---- 5c) custom sizes: priced as the smallest listed size they fit inside ----
    r = await estimate({ family: 'stickers', productId: 'stk-gloss', customSize: { w: 2.5, h: 3 }, qty: 50 });
    assert.strictEqual(r.body.estimate.total, 65, 'a 2.5×3 sticker is priced as 3×3');
    assert.strictEqual(r.body.estimate.printOrder.pricedAsSize, '3×3 in');
    assert.deepStrictEqual([r.body.estimate.printOrder.canvas.width, r.body.estimate.printOrder.canvas.height], [2.5, 3], 'a custom size is its own print canvas');
    assert.strictEqual((await estimate({ family: 'stickers', productId: 'stk-gloss', customSize: { w: 9, h: 3 }, qty: 25 })).status, 400, 'a size larger than any listed size is rejected');
    assert.strictEqual((await estimate({ family: 'mylar', productId: 'myl-std', customSize: { w: 2, h: 2 }, qty: 64 })).status, 400, 'custom sizes are rejected when the product does not allow them');
    console.log('  ok: custom sizes are priced as the next listed size up');

    // ---- 5d) yard signs: per-piece double-sided upcharge ----
    r = await estimate({ family: 'yardsigns', productId: 'yard-sign', sizeId: '18x24', qty: 5, options: { sides: 'double' }, backArtwork: 'different' });
    assert.strictEqual(r.body.estimate.total, 200, '5 signs at $30 + $10 each double-sided');
    assert.strictEqual(r.body.estimate.printOrder.backArtwork, 'different');
    console.log('  ok: per-piece options are added on top of the base price');

    // ---- 5e) design help: $50 design fee when 3T creates the artwork, $50 more for a logo ----
    const plain = myl(64, 'double', 'unlaminated');
    r = await estimate({ ...plain, design: { method: 'custom', logo: 'design', brief: { designName: 'Blue Razz', style: 'Bold', junk: 'x' } } });
    assert.strictEqual(r.body.estimate.total, 160 + 50 + 50, 'design fee $50 plus logo design $50');
    assert.deepStrictEqual(r.body.estimate.printOrder.design.brief, { designName: 'Blue Razz', style: 'Bold' }, 'only known brief fields are kept');
    r = await estimate({ ...plain, design: { method: 'custom', logo: 'upload' } });
    assert.strictEqual(r.body.estimate.total, 210, 'design fee alone when the customer has a logo');
    r = await estimate({ ...plain, design: { method: 'premade', logo: 'upload', templateId: 't1' } });
    assert.strictEqual(r.body.estimate.total, 160, 'a premade design with the customer logo is free');
    assert.strictEqual(r.body.estimate.printOrder.design.templateName, 'Template One');
    assert.strictEqual(r.body.estimate.printOrder.design.templateCategory, 'signature');
    r = await estimate({ ...plain, design: { method: 'premade', logo: 'design', templateId: 't1' } });
    assert.strictEqual(r.body.estimate.total, 210, 'a premade design with a logo made by the shop adds the $50 logo fee');
    r = await estimate({ ...plain, design: { method: 'upload', logo: 'design' } });
    assert.strictEqual(r.body.estimate.total, 160, 'uploading finished artwork never adds a fee');
    r = await estimate({ ...stk, design: { method: 'custom', logo: 'text' } });
    assert.strictEqual(r.body.estimate.total, 115, 'stickers: $65 + $50 design fee');
    assert.strictEqual((await estimate({ ...stk, design: { method: 'premade' } })).status, 400, 'premade designs are only offered where the product has them');
    console.log('  ok: design fees follow the chosen design method');

    // ---- 6) a print order is an ordinary quote, with the configuration stored as structured values ----
    const order = myl(128, 'double', 'laminated', {
      options: { sides: 'double', lamination: 'laminated', color: 'purple' },
      orientation: 'sideways', border: 0.05, artworkConfirmed: true,
      placements: { front: { scale: 0.91, xPercent: 50, yPercent: 50, rotation: 30 }, back: { scale: 0.88, xPercent: 50, yPercent: 48 }, junk: { scale: 1 } },
    });
    const code = await createQuote(order, { rush: true });
    let q = await (await fetch(`${BASE}/api/quotes/${code}`)).json();
    assert.strictEqual(q.pricing.baseLineTotal, 340);
    assert.strictEqual(q.pricing.total, 372, 'base $340 + $32 color upgrade');
    const po = q.pricing.printOrder;
    assert.strictEqual(po.productName, '3.5 Pack');
    assert.deepStrictEqual(po.options.map(o => `${o.groupId}:${o.choiceId}`), ['color:purple', 'sides:double', 'lamination:laminated']);
    assert.strictEqual(po.artworkConfirmed, true, 'the artwork confirmation is stored on the order');
    assert.strictEqual(po.orientation, null, 'an invalid orientation is not stored');
    assert.deepStrictEqual(po.placements, {
      front: { scale: 0.91, xPercent: 50, yPercent: 50, rotation: 0 }, back: { scale: 0.88, xPercent: 50, yPercent: 48, rotation: 0 },
    }, 'artwork placement is stored per side, separate from the files');
    assert.strictEqual(q.items.length, 1);
    assert.strictEqual(q.items[0].quantity, 128);
    assert.strictEqual(q.printLocations.length, 0);
    assert.strictEqual(q.checkout.rushFee, 74.4, 'rush is its own line: 20% of the order');
    assert.strictEqual(q.checkout.shippingFee, 0, 'local pickup has no shipping charge');
    const adminQuote = await (await fetch(`${BASE}/api/admin/quotes/${code}`, { headers: { Cookie: cookie } })).json();
    assert.strictEqual(adminQuote.pricing.total, 372, 'the order opens in the admin like any other quote');
    const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
    assert(!garments.some(g => g.id === adminQuote.quote.garment_id), 'the stand-in garment behind a print order never shows in the apparel builder');
    console.log('  ok: a print order is stored and shown as a normal quote');

    // ---- 6b) flat ground shipping: once per order, only when shipped ----
    const shippedCode = await createQuote(stk, { fulfillmentMethod: 'shipping', shippingAddress: { line1: '1 Main St', city: 'Macon', state: 'GA', zip: '31201' } });
    q = await (await fetch(`${BASE}/api/quotes/${shippedCode}`)).json();
    assert.strictEqual(q.checkout.shippingFee, 11.99, 'a shipped order carries the flat ground rate');
    assert.strictEqual(q.checkout.grandTotal, Math.round((65 + q.checkout.taxAmount + 11.99) * 100) / 100, 'order + tax + shipping; shipping is not taxed');
    const info = await (await fetch(`${BASE}/api/business-info`)).json();
    assert.strictEqual(info.shippingFlatRate, 11.99, 'the builders are told the flat rate');
    console.log('  ok: flat ground shipping is added once to shipped orders');

    // ---- 7) a quote keeps the price it was quoted at ----
    const pricier = JSON.parse(JSON.stringify(test));
    pricier.families.find(f => f.key === 'mylar').products[0].sizes[0].tables.find(t => t.key === 'double|laminated').packs.find(k => k.qty === 128).price = 999;
    await saveCatalog(pricier);
    assert.strictEqual((await estimate(order)).body.estimate.total, 1031, 'new estimates use the new catalog price');
    const checkoutResp = await fetch(`${BASE}/api/quotes/${code}/checkout`, json({ termsAccepted: true }));
    assert(checkoutResp.ok, 'checkout starts for a print quote');
    q = await (await fetch(`${BASE}/api/quotes/${code}`)).json();
    assert.strictEqual(q.pricing.total, 372, 'checkout honors the price the quote was generated at');
    await saveCatalog(test);
    console.log('  ok: checkout honors the quoted price after a catalog change');

    // ---- 8) discount codes work on a print quote ----
    const code2 = await createQuote(stk);
    const discountCode = 'PRINT' + Date.now();
    const mk = await fetch(`${BASE}/api/admin/discount-codes`, json({ code: discountCode, type: 'percent', value: 10, active: true }, cookie));
    assert(mk.ok, 'test discount code is created');
    const applied = await (await fetch(`${BASE}/api/quotes/${code2}/apply-discount`, json({ code: discountCode }))).json();
    assert.strictEqual(applied.pricing.total, 58.5, '10% off the $65 order');
    const removed = await (await fetch(`${BASE}/api/quotes/${code2}/remove-discount`, json({}))).json();
    assert.strictEqual(removed.pricing.total, 65);
    console.log('  ok: discount codes apply to and come off a print quote');

    // ---- 9) owner price override (per piece) ----
    const override = await fetch(`${BASE}/api/admin/quotes/${code2}/override`, json({ overrideUnitPrice: 1, confirmedBelowFloor: true, note: 'test' }, cookie));
    assert(override.ok, 'the owner can override a print quote');
    q = await (await fetch(`${BASE}/api/quotes/${code2}`)).json();
    assert.strictEqual(q.pricing.total, 50, '50 stickers at an owner price of $1.00 each');
    assert.strictEqual(q.pricing.printOrder.qty, 50, 'the override keeps the print order details');
    console.log('  ok: owner override reprices a print quote');

    // ---- 10) apparel pricing is untouched ----
    const tee = garments.find(g => !g.isOther);
    const apparel = await fetch(`${BASE}/api/estimate`, json({
      garmentId: tee.id, printLocationIds: [],
      colorSelections: [{ colorName: tee.colors[0].name, colorHex: tee.colors[0].hex, sizes: [{ label: tee.sizes[0].label, qty: 12 }] }],
    }));
    const apparelBody = await apparel.json();
    assert(apparel.ok && apparelBody.estimate.total > 0 && apparelBody.estimate.printOrder === null, 'an apparel estimate still prices from the garment tables');
    console.log('  ok: apparel estimates are unaffected');
  } finally {
    await saveCatalog(original);
  }

  console.log('ALL PRINT PRODUCT CHECKS PASSED');
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
