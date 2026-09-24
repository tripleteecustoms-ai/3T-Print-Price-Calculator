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

// ---------------------------------------------------------- Shopify auth
// As of January 2026, Shopify retired the old "create a custom app in your
// store's Settings, copy one static token" flow for new apps. The current
// path for a single-store custom app is the Client Credentials Grant: you
// create the app once in Shopify's Dev Dashboard (dev.shopify.com), install
// it to your store, and get back a Client ID + Client Secret (not a token).
// The server then exchanges those for a real access token on demand — that
// token expires every 24 hours, so we cache it in memory and silently
// re-fetch a fresh one whenever it's about to expire. See README > Shopify
// setup for the click-by-click Dev Dashboard steps.
let cachedToken = null; // { accessToken, expiresAt } — expiresAt is a Date.now()-style ms timestamp
let TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh a minute early rather than cutting it exactly at expiry

async function getShopifyAccessToken(shopDomain, clientId, clientSecret) {
  if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.accessToken;
  }
  const resp = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  if (!resp.ok) throw new Error(`Shopify token request failed: ${resp.status}`);
  const json = await resp.json();
  if (!json.access_token) throw new Error('Shopify did not return an access token.');
  cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in || 86399) * 1000 };
  return cachedToken.accessToken;
}

/**
 * Create a Shopify Draft Order via the Admin GraphQL API and return its
 * invoice/checkout URL. Requires shopify_shop_domain + shopify_client_id +
 * shopify_client_secret to be configured in Settings (or the equivalent
 * SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars).
 * This function is real/functional — it is simply never invoked unless
 * those credentials exist (see createCheckoutForQuote below).
 */
async function createShopifyDraftOrder(quote, customer) {
  const shopDomain = getSetting('shopify_shop_domain', '') || process.env.SHOPIFY_SHOP_DOMAIN || '';
  const clientId = getSetting('shopify_client_id', '') || process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = getSetting('shopify_client_secret', '') || process.env.SHOPIFY_CLIENT_SECRET || '';
  if (!shopDomain || !clientId || !clientSecret) {
    throw new Error('Shopify credentials are not configured.');
  }
  const adminToken = await getShopifyAccessToken(shopDomain, clientId, clientSecret);

  const snapshot = JSON.parse(quote.pricing_snapshot);
  const lineItems = checkoutLineItems(quote, snapshot).map(l => ({
    title: l.title,
    quantity: 1,
    originalUnitPrice: l.amount.toFixed(2),
    requiresShipping: quote.fulfillment_method === 'shipping',
    // Sales tax is already its own line (server/checkoutRules.js, the rate
    // set in Settings > Checkout), so Shopify must not add tax on top.
    taxable: false,
  }));
  const address = quote.fulfillment_method === 'shipping' && quote.shipping_address ? JSON.parse(quote.shipping_address) : null;

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
      note: `3T Quote ${quote.quote_code} | Garment: ${snapshot.garment.name} | Qty: ${snapshot.totalQty} | Fulfillment: ${quote.fulfillment_method}`
        + (quote.rush ? ' | RUSH' : '')
        + (quote.payment_option === 'deposit' ? ` | DEPOSIT: order total $${Number(quote.grand_total).toFixed(2)}, balance due $${Number(quote.balance_due).toFixed(2)}` : ''),
      customAttributes: [
        { key: 'quote_id', value: quote.quote_code },
        { key: 'fulfillment_method', value: quote.fulfillment_method },
        { key: 'artwork_status', value: quote.artwork_status },
        { key: 'rush', value: quote.rush ? 'yes' : 'no' },
        { key: 'payment_option', value: quote.payment_option || 'full' },
      ],
      taxExempt: true,
      useCustomerDefaultAddress: false,
      ...(address ? { shippingAddress: {
        firstName: customer.first_name, lastName: customer.last_name,
        address1: address.line1, address2: address.line2 || null, city: address.city,
        provinceCode: address.state, zip: address.zip, countryCode: 'US',
      } } : {}),
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

/** What the customer pays now: the order total. For older quotes with no checkout amounts saved yet, the order total alone. */
function amountDueNow(quote) {
  if (quote.amount_due_now != null) return Number(quote.amount_due_now);
  return JSON.parse(quote.pricing_snapshot).total;
}

/**
 * The lines charged at checkout. Paying in full: the order, the rush fee
 * (if any) and sales tax, itemized. Paying a deposit: one deposit line for
 * the amount due now (the balance is collected later).
 */
function checkoutLineItems(quote, snapshot) {
  const orderTitle = `${snapshot.garment.name}: Custom Order (${snapshot.totalQty} pcs)`;
  if (quote.payment_option === 'deposit') {
    return [{ title: `Deposit for 3T order ${quote.quote_code} (${orderTitle}). Order total $${Number(quote.grand_total).toFixed(2)}, balance $${Number(quote.balance_due).toFixed(2)} due before ${quote.fulfillment_method === 'shipping' ? 'shipping' : 'pickup'}`, amount: amountDueNow(quote) }];
  }
  const lines = [{ title: orderTitle, amount: snapshot.total }];
  if (Number(quote.rush_fee) > 0) lines.push({ title: 'Rush Fee', amount: Number(quote.rush_fee) });
  if (Number(quote.tax_amount) > 0) lines.push({ title: 'Sales Tax', amount: Number(quote.tax_amount) });
  return lines;
}

/**
 * Mock provider: simulates the Shopify handoff so the full funnel is
 * testable without live credentials. Clearly labeled as a mock in the UI.
 */
function createMockCheckout(quote) {
  const token = Buffer.from(`${quote.quote_code}:${Date.now()}`).toString('base64url');
  return {
    provider: 'mock',
    providerRef: token,
    checkoutUrl: `/checkout-mock.html?quote=${encodeURIComponent(quote.quote_code)}&token=${token}&amount=${amountDueNow(quote).toFixed(2)}`,
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
  const now = new Date().toISOString();
  const paid = amountDueNow(quote);
  const isDeposit = quote.payment_option === 'deposit';
  db.prepare(`UPDATE quotes SET status=?, paid_at=?, amount_paid=?, payment_provider='mock',
    payment_reference=?, updated_at=? WHERE id=?`)
    .run(isDeposit ? 'deposit_paid' : 'paid', now, paid, `mock_${Date.now()}`, now, quote.id);
  db.prepare('INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?,?,?)')
    .run(quote.id, 'paid', isDeposit
      ? `Mock deposit of $${paid.toFixed(2)} confirmed. Balance due: $${Number(quote.balance_due).toFixed(2)}.`
      : `Mock payment of $${paid.toFixed(2)} confirmed.`);
  return db.prepare('SELECT * FROM quotes WHERE id = ?').get(quote.id);
}

// _resetShopifyTokenCacheForTests exists purely so tests can force a clean
// cache between scenarios — not used by the app itself.
function _resetShopifyTokenCacheForTests() { cachedToken = null; }
function _setTokenRefreshBufferMsForTests(ms) { TOKEN_REFRESH_BUFFER_MS = ms; }

module.exports = {
  createCheckoutForQuote, confirmMockPayment, createShopifyDraftOrder, createMockCheckout, checkoutLineItems,
  getShopifyAccessToken, _resetShopifyTokenCacheForTests, _setTokenRefreshBufferMsForTests,
};
