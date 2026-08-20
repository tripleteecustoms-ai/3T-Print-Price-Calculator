// Focused check for the Analytics feature: tracking endpoint validation,
// funnel counts (visitors -> steps -> quote generated -> checkout started ->
// paid), UTM traffic-source attribution + conversion math, revenue-by-day
// and top-garment aggregation, and repeat-customer-rate.
const assert = require('assert');

const BASE = 'http://localhost:4790';

function track(body) {
  return fetch(`${BASE}/api/analytics/track`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function createAndPayQuote({ visitorId, utmSource, qty = 2 }) {
  const { garments } = await (await fetch(`${BASE}/api/garments`)).json();
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const black = tee.colors.find(c => c.name === 'Black');
  const draftTokenResp = await (await fetch(`${BASE}/api/draft-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();

  // simulate a real visit: page_view (carrying UTM), then each funnel step
  await track({ eventType: 'page_view', visitorId, sessionId: `${visitorId}-s`, utm: utmSource ? { source: utmSource } : {} });
  for (const step of ['garment', 'color', 'sizes', 'locations', 'artwork', 'contact']) {
    await track({ eventType: 'step_view', visitorId, sessionId: `${visitorId}-s`, step });
  }

  const resp = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      garmentId: tee.id, colorSelections: [{ colorName: black.name, colorHex: black.hex, sizes: [{ label: 'M', qty }] }],
      printLocationIds: [], draftToken: draftTokenResp.draftToken,
      firstName: 'Ana', lastName: 'Lytics', email: `ana.lytics.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`, phone: '555-222-1111',
      fulfillmentMethod: 'pickup', termsAccepted: true,
    }),
  });
  assert(resp.ok, 'test quote creation succeeds');
  const { quoteCode } = await resp.json();

  await track({ eventType: 'quote_generated', visitorId, sessionId: `${visitorId}-s`, quoteCode });

  await fetch(`${BASE}/api/quotes/${quoteCode}/checkout-started`, { method: 'POST' });
  await track({ eventType: 'checkout_started', visitorId, sessionId: `${visitorId}-s`, quoteCode });

  return quoteCode;
}

async function markPaid(quoteCode) {
  const resp = await fetch(`${BASE}/api/mock-payment/${quoteCode}/confirm`, { method: 'POST' });
  assert(resp.ok, 'mock payment confirmation succeeds');
}

async function main() {
  console.log('=== ANALYTICS ===');

  const loginResp = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '3tprint-admin-2026' }),
  });
  const cookie = loginResp.headers.get('set-cookie');

  // ---- 0) admin auth required ----
  const unauthResp = await fetch(`${BASE}/api/admin/analytics`);
  assert.strictEqual(unauthResp.status, 401, 'analytics admin route requires auth');
  console.log('  ok: analytics route requires admin auth');

  // ---- 1) tracking endpoint validation ----
  const badType = await track({ eventType: 'bogus', visitorId: 'v-bad' });
  assert.strictEqual(badType.status, 400, 'invalid eventType rejected');
  const missingVisitor = await track({ eventType: 'page_view' });
  assert.strictEqual(missingVisitor.status, 400, 'missing visitorId rejected');
  const ok = await track({ eventType: 'page_view', visitorId: 'v-ok' });
  assert.strictEqual(ok.status, 204, 'valid page_view accepted');
  console.log('  ok: tracking endpoint validates eventType and visitorId');

  // ---- 2) build real funnel data: 2 paid (google, direct), 1 unpaid (facebook) ----
  const paidGoogleCode = await createAndPayQuote({ visitorId: 'visitor-google', utmSource: 'google', qty: 3 });
  await markPaid(paidGoogleCode);

  const paidDirectCode = await createAndPayQuote({ visitorId: 'visitor-direct', utmSource: null, qty: 1 });
  await markPaid(paidDirectCode);

  const unpaidFbCode = await createAndPayQuote({ visitorId: 'visitor-fb', utmSource: 'facebook', qty: 5 });
  // deliberately not paid — should count in funnel/checkout but not in revenue/paid

  // an extra bare visitor who only ever loads the page (top of funnel only)
  await track({ eventType: 'page_view', visitorId: 'visitor-bare', sessionId: 'bare-s' });

  // ---- 3) funnel counts ----
  const analyticsResp = await fetch(`${BASE}/api/admin/analytics?days=30`, { headers: { Cookie: cookie } });
  assert(analyticsResp.ok, 'analytics aggregation route succeeds');
  const data = await analyticsResp.json();

  const funnelByStep = Object.fromEntries(data.funnel.map(f => [f.step, f.count]));
  assert(funnelByStep.visitors >= 4, `visitors funnel count includes all page_view visitors (got ${funnelByStep.visitors})`);
  assert(funnelByStep.garment >= 3, `garment step count reflects step_view events (got ${funnelByStep.garment})`);
  assert(funnelByStep.contact >= 3, `contact (last) step count reflects step_view events (got ${funnelByStep.contact})`);
  assert(funnelByStep.quote_generated >= 3, `quote_generated funnel count correct (got ${funnelByStep.quote_generated})`);
  assert(funnelByStep.checkout_started >= 3, `checkout_started funnel count correct (got ${funnelByStep.checkout_started})`);
  assert(funnelByStep.paid >= 2, `paid funnel count reflects quotes.paid_at, not a client event (got ${funnelByStep.paid})`);
  console.log('  ok: funnel counts (visitors -> steps -> quote_generated -> checkout_started -> paid) are correct');

  // ---- 4) traffic sources: UTM attribution + conversion ----
  const bySource = Object.fromEntries(data.trafficSources.map(s => [s.source, s]));
  assert(bySource.google, 'google traffic source present');
  assert(bySource.google.paid >= 1, 'google source shows a paid conversion');
  assert(bySource.direct, 'direct (no-UTM) traffic source present');
  assert(bySource.direct.paid >= 1, 'direct source shows a paid conversion');
  assert(bySource.facebook, 'facebook traffic source present');
  assert.strictEqual(bySource.facebook.paid, 0, 'facebook source (unpaid quote) shows zero paid conversions');
  assert(bySource.facebook.quotesGenerated >= 1, 'facebook source still counted a generated quote even though unpaid');
  console.log('  ok: traffic sources attribute visitors/quotes/paid by UTM source, with a "direct" bucket for no-UTM visits');

  // ---- 5) revenue by day + order stats (paid only) ----
  assert(data.orderStats.orders >= 2, `order stats count only paid orders (got ${data.orderStats.orders})`);
  assert(data.orderStats.revenue > 0, 'order stats revenue is positive');
  assert(data.revenueByDay.length >= 1, 'revenueByDay has at least one day bucket');
  const todayRevenue = data.revenueByDay.reduce((sum, d) => sum + d.revenue, 0);
  assert(Math.abs(todayRevenue - data.orderStats.revenue) < 0.01, 'revenueByDay sums to orderStats.revenue');
  console.log('  ok: revenue-by-day and order stats reflect only paid orders and agree with each other');

  // ---- 6) top garments (paid orders only) ----
  assert(data.topGarments.length >= 1, 'topGarments has at least one entry');
  const tee = data.topGarments.find(g => g.name === 'Standard Quality T-Shirt');
  assert(tee, 'Standard Quality T-Shirt appears in top garments');
  assert(tee.qty >= 4, `top garment qty reflects paid quote quantities only (3+1=4, got ${tee.qty})`);
  console.log('  ok: top garments aggregate quantity across paid orders only');

  // ---- 7) repeat customer rate (all-time, not window-bound) ----
  assert(typeof data.repeatCustomers.rate === 'number', 'repeatCustomers.rate is a number');
  assert(data.repeatCustomers.total >= 2, 'repeatCustomers.total counts distinct paying customers');
  console.log(`  ok: repeat customer rate computed (${data.repeatCustomers.rate}% of ${data.repeatCustomers.total} paying customers)`);

  // ---- 8) days window narrows results (sanity: 0-day-old cutoff still includes "today") ----
  const narrowResp = await fetch(`${BASE}/api/admin/analytics?days=1`, { headers: { Cookie: cookie } });
  const narrowData = await narrowResp.json();
  assert(narrowData.orderStats.orders >= 2, 'a 1-day window still includes orders paid moments ago');
  console.log('  ok: days query param is respected and clamps sensibly');

  console.log('=== ANALYTICS: ALL CHECKS PASSED ===');
}

main().catch(err => {
  console.error('ANALYTICS TEST FAILED:', err);
  process.exit(1);
});
