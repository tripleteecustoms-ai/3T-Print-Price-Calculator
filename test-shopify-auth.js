// Standalone unit test for the Shopify Client Credentials Grant logic added
// to server/services/paymentService.js. Doesn't need a running server or
// real Shopify credentials — it boots the db module directly and fakes the
// global fetch() so we can verify: token caching/reuse, automatic refresh
// once the cached token expires, the correct header being sent on the real
// draftOrderCreate call, and the "credentials not configured" guard.
const assert = require('assert');

async function main() {
  const db = require('./server/db');
  await db.ready;

  // Wipe + seed just the settings this test needs (fast, isolated — doesn't
  // touch garments/pricing/etc.)
  const upsert = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  upsert.run('shopify_shop_domain', 'test-shop.myshopify.com');
  upsert.run('shopify_client_id', 'fake_client_id');
  upsert.run('shopify_client_secret', 'fake_client_secret');

  const paymentService = require('./server/services/paymentService');
  // Production uses a 60s refresh buffer (sensible against a real 24h token);
  // shrink it here so a short-lived fake token still lets us test "still
  // cached" vs. "needs refresh" quickly instead of waiting a full minute.
  paymentService._setTokenRefreshBufferMsForTests(200);

  let tokenCalls = 0;
  let draftOrderCalls = 0;
  let lastAuthHeaderSeen = null;
  const TOKEN_TTL_SECONDS = 2; // short-lived so the test doesn't need to wait 24h to see a refresh

  global.fetch = async (url, opts) => {
    if (url.includes('/admin/oauth/access_token')) {
      tokenCalls++;
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.grant_type, 'client_credentials', 'token request uses client_credentials grant');
      assert.strictEqual(body.client_id, 'fake_client_id', 'token request sends the configured client id');
      assert.strictEqual(body.client_secret, 'fake_client_secret', 'token request sends the configured client secret');
      return {
        ok: true,
        json: async () => ({ access_token: `fake_token_${tokenCalls}`, expires_in: TOKEN_TTL_SECONDS }),
      };
    }
    if (url.includes('/admin/api/') && url.includes('graphql.json')) {
      draftOrderCalls++;
      lastAuthHeaderSeen = opts.headers['X-Shopify-Access-Token'];
      return {
        ok: true,
        json: async () => ({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/1', invoiceUrl: 'https://test-shop.myshopify.com/invoice/1', name: '#D1' }, userErrors: [] } } }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const fakeQuote = {
    id: 1, quote_code: '3T-TEST-0001', fulfillment_method: 'pickup', artwork_status: 'pending_review',
    pricing_snapshot: JSON.stringify({ garment: { name: 'Test Tee' }, totalQty: 12, total: 240 }),
  };
  const fakeCustomer = { email: 'test@example.com' };

  console.log('=== SHOPIFY CLIENT CREDENTIALS GRANT ===');

  // 1) First call fetches a token and uses it on the draft order call.
  const r1 = await paymentService.createShopifyDraftOrder(fakeQuote, fakeCustomer);
  assert.strictEqual(tokenCalls, 1, `first draft order call fetches exactly one token (got ${tokenCalls})`);
  assert.strictEqual(lastAuthHeaderSeen, 'fake_token_1', 'draft order call uses the freshly-fetched token');
  assert.strictEqual(r1.provider, 'shopify', 'createShopifyDraftOrder reports provider=shopify');
  console.log('  ok: first call fetches a token and uses it');

  // 2) Second call within the token's lifetime reuses the cached token — no new fetch.
  await paymentService.createShopifyDraftOrder(fakeQuote, fakeCustomer);
  assert.strictEqual(tokenCalls, 1, `second call within token lifetime reuses cache, no new token fetch (got ${tokenCalls})`);
  assert.strictEqual(lastAuthHeaderSeen, 'fake_token_1', 'second call still uses the same cached token');
  console.log('  ok: cached token reused within its lifetime — no redundant token fetch');

  // 3) After the token expires, the next call transparently fetches a fresh one.
  await new Promise(r => setTimeout(r, (TOKEN_TTL_SECONDS * 1000) + 200));
  await paymentService.createShopifyDraftOrder(fakeQuote, fakeCustomer);
  assert.strictEqual(tokenCalls, 2, `call after expiry fetches a new token (got ${tokenCalls} total)`);
  assert.strictEqual(lastAuthHeaderSeen, 'fake_token_2', 'call after expiry uses the newly-fetched token');
  console.log('  ok: expired token automatically refreshed, transparently, with no caller-side change needed');

  assert.strictEqual(draftOrderCalls, 3, `all three draft order calls actually reached Shopify's GraphQL endpoint (got ${draftOrderCalls})`);

  // 4) Missing credentials should fail clearly (and createCheckoutForQuote should fall back to mock rather than crash).
  upsert.run('shopify_client_secret', '');
  paymentService._resetShopifyTokenCacheForTests();
  await assert.rejects(
    () => paymentService.createShopifyDraftOrder(fakeQuote, fakeCustomer),
    /Shopify credentials are not configured/,
    'missing client secret throws a clear configuration error'
  );
  console.log('  ok: missing credentials fail with a clear error instead of a confusing crash');

  upsert.run('payment_provider', 'shopify');
  const fallback = await paymentService.createCheckoutForQuote(fakeQuote, fakeCustomer);
  assert.strictEqual(fallback.provider, 'mock', 'createCheckoutForQuote falls back to mock when Shopify creds are missing, instead of failing checkout entirely');
  console.log('  ok: checkout still works end-to-end (falls back to mock) when Shopify isn\'t fully configured');

  // cleanup so this doesn't leave the app pointed at "shopify" with no creds
  upsert.run('payment_provider', 'mock');
  upsert.run('shopify_shop_domain', '');
  upsert.run('shopify_client_id', '');
  upsert.run('shopify_client_secret', '');

  console.log('\n=== SHOPIFY AUTH CHECKS PASSED ===');
  process.exit(0);
}

main().catch(err => { console.error('FAIL:', err); process.exit(1); });
