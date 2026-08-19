// server/services/paymentService.js
//
// Payment provider abstraction. Shopify is the default/preferred provider;
// Square is stubbed for later. If no live Shopify Admin API credentials are
// configured, the app automatically falls back to a clearly-labeled MOCK
// checkout so the full quote -> checkout -> paid flow can be demoed and
// tested end to end without faking real payment functionality.
//
// IMPORTANT: this module never trusts a price from the caller beyond what
// routes/customer.js has already recalculated server-side from the DB.

const { getSetting } = require('../pricingEngine');
const db = require('../db');

/**
 * Create a Shopify Draft Order via the Admin GraphQL API and return its
 * invoice/checkout URL. Requires shopify_shop_domain + shopify_admin_token
 * to be configured in Settings (or SHOPIFY_SHOP_DOMAIN / SHOPIFY_ADMIN_TOKEN
 * env vars). This function is real/functional — it is simply never invoked
 * unless those credentials exist (see createCheckoutForQuote below).
 */
async function createShopifyDraftOrder(quote, customer) {
  const shopDomain = getSetting('shopify_shop_domain', '') || process.env.SHOPIFY_SHOP_DOMAIN || '';
  const adminToken = getSetting('shopify_admin_token', '') || process.env.SHOPIFY_ADMIN_TOKEN || '';
  if (!shopDomain || !adminToken) {
    throw new Error('Shopify credentials are not configured.');
  }

  const snapshot = JSON.parse(quote.pricing_snapshot);
  const lineItems = [
    {
      title: `${snapshot.garment.name} — Custom Order (${snapshot.totalQty} pcs)`,
      quantity: 1,
      originalUnitPrice: snapshot.total.toFixed(2),
      requiresShipping: quote.fulfillment_method === 'shipping',
      taxable: true,
    },
  ];

  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl name }
        userErrors { field message }
      }
    }`;

  const variables = {
    input: {
      lineItems,
      email: customer.email,
      note: `3T Quote ${quote.quote_code} | Garment: ${snapshot.garment.name} | Qty: ${snapshot.totalQty} | Fulfillment: ${quote.fulfillment_method}`,
      customAttributes: [
        { key: 'quote_id', value: quote.quote_code },
        { key: 'fulfillment_method', value: quote.fulfillment_method },
        { key: 'artwork_status', value: quote.artwork_status },
      ],
      useCustomerDefaultAddress: false,
    },
  };

  const resp = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  if (!resp.ok) throw new Error(`Shopify API error: ${resp.status}`);
  const json = await resp.json();
  const errors = json?.data?.draftOrderCreate?.userErrors;
  if (errors && errors.length) throw new Error('Shopify: ' + errors.map(e => e.message).join('; '));

  const draftOrder = json?.data?.draftOrderCreate?.draftOrder;
  if (!draftOrder) throw new Error('Shopify did not return a draft order.');

  return {
    provider: 'shopify',
    providerRef: draftOrder.id,
    checkoutUrl: draftOrder.invoiceUrl,
  };
}

/**
 * Mock provider: simulates the Shopify handoff so the full funnel is
 * testable without live credentials. Clearly labeled as a mock in the UI.
 */
function createMockCheckout(quote) {
  const snapshot = JSON.parse(quote.pricing_snapshot);
  const token = Buffer.from(`${quote.quote_code}:${Date.now()}`).toString('base64url');
  return {
    provider: 'mock',
    providerRef: token,
    checkoutUrl: `/checkout-mock.html?quote=${encodeURIComponent(quote.quote_code)}&token=${token}&amount=${snapshot.total.toFixed(2)}`,
  };
}

/** Square stub — same shape, ready to implement when enabled. */
async function createSquareCheckout(/* quote, customer */) {
  throw new Error('Square is not yet configured. Enable it in Settings once credentials are available.');
}

/**
 * Entry point used by routes. Picks the provider from Settings, with a safe
 * fallback to mock if the preferred provider isn't actually configured.
 */
async function createCheckoutForQuote(quote, customer) {
  const provider = getSetting('payment_provider', 'mock');

  if (provider === 'shopify') {
    try {
      return await createShopifyDraftOrder(quote, customer);
    } catch (err) {
      console.warn('[paymentService] Shopify checkout unavailable, falling back to mock:', err.message);
      return createMockCheckout(quote);
    }
  }
  if (provider === 'square') {
    try {
      return await createSquareCheckout(quote, customer);
    } catch (err) {
      console.warn('[paymentService] Square checkout unavailable, falling back to mock:', err.message);
      return createMockCheckout(quote);
    }
  }
  return createMockCheckout(quote);
}

/** Called when the mock checkout page "completes payment". */
function confirmMockPayment(quoteCode) {
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(quoteCode);
  if (!quote) throw new Error('Quote not found.');
  const snapshot = JSON.parse(quote.pricing_snapshot);
  const now = new Date().toISOString();
  db.prepare(`UPDATE quotes SET status='paid', paid_at=?, amount_paid=?, payment_provider='mock',
    payment_reference=?, updated_at=? WHERE id=?`)
    .run(now, snapshot.total, `mock_${Date.now()}`, now, quote.id);
  db.prepare('INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?,?,?)')
    .run(quote.id, 'paid', 'Mock payment confirmed.');
  return db.prepare('SELECT * FROM quotes WHERE id = ?').get(quote.id);
}

module.exports = { createCheckoutForQuote, confirmMockPayment, createShopifyDraftOrder, createMockCheckout };
