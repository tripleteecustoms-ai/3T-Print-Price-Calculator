// server/routes/webhooks.js
// Shopify and Square tell the app about payments, refunds, cancellations and
// shipments here, so an order updates as it happens instead of waiting for
// the next check. Mounted at /api/webhooks.
//
//  - Every delivery is verified with the provider's signature before anything
//    is read from it. An unsigned or wrongly signed request is rejected.
//  - Each delivery's event id is stored (webhook_events). A repeat delivery
//    is acknowledged and ignored, so nothing is recorded or emailed twice.
//  - Both providers update the ONE internal order (the quotes row); neither
//    creates a second order.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { getSetting } = require('../pricingEngine');
const paymentService = require('../services/paymentService');
const emailService = require('../services/emailService');
const realtime = require('../services/realtime');

const router = express.Router();

const ORDER_CODE_RE = /3T-(?:\d{6}-\d{4,5}|\d{5})(?!\d)/i;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const baseUrlOf = (req) => process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/** True the first time an event id is seen; false for a repeat delivery. */
function firstDelivery(provider, eventId, topic) {
  if (!eventId) return true; // nothing to de-duplicate on; the handlers below are safe to repeat anyway
  const result = db.prepare('INSERT INTO webhook_events (provider, event_id, topic, received_at) VALUES (?,?,?,?) ON CONFLICT(provider, event_id) DO NOTHING')
    .run(provider, String(eventId), topic || null, new Date().toISOString());
  return result.changes > 0;
}
function logEvent(quoteId, type, detail) {
  db.prepare('INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?,?,?)').run(quoteId, type, detail);
}
function announce(quote, message) {
  realtime.publish({ type: 'order', orderNumber: quote.quote_code, message: `#${quote.quote_code}: ${message}` });
}
function setStatus(quote, status, detail, req, { email = true } = {}) {
  if (quote.status === status) return false;
  db.prepare('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), quote.id);
  logEvent(quote.id, 'status_change', `${quote.status} -> ${status} (${detail})`);
  if (email) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(quote.customer_id);
    if (customer && customer.email) {
      emailService.sendStatusUpdateEmail({ ...quote, status }, customer, baseUrlOf(req), status).catch(err => console.error('Status email failed:', err.message));
    }
  }
  return true;
}

// ================================================================== Shopify
function shopifySecret() { return getSetting('shopify_client_secret', '') || process.env.SHOPIFY_CLIENT_SECRET || ''; }
const shopifyGid = (id) => `gid://shopify/Order/${id}`;

/** The internal order a Shopify order belongs to: by its stored Shopify id, else by the order number written on the checkout. */
function quoteForShopifyOrder(order) {
  if (!order) return null;
  const gid = order.admin_graphql_api_id || (order.id ? shopifyGid(order.id) : null);
  if (gid) {
    const byId = db.prepare('SELECT * FROM quotes WHERE shopify_order_id = ?').get(gid);
    if (byId) return byId;
  }
  const attribute = (order.note_attributes || []).find(a => a && a.name === 'quote_id');
  const code = (attribute && attribute.value) || (String(order.note || '').match(ORDER_CODE_RE) || [])[0];
  return code ? db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(String(code).toUpperCase()) : null;
}
function rememberShopifyIds(quote, order) {
  const gid = order.admin_graphql_api_id || shopifyGid(order.id);
  db.prepare('UPDATE quotes SET shopify_order_id = COALESCE(shopify_order_id, ?), shopify_order_number = ?, shopify_customer_id = COALESCE(?, shopify_customer_id) WHERE id = ?')
    .run(gid, order.name || (order.order_number ? `#${order.order_number}` : null), order.customer && order.customer.id ? String(order.customer.id) : null, quote.id);
}

async function handleShopify(topic, payload, req) {
  if (topic.startsWith('orders/')) {
    let quote = quoteForShopifyOrder(payload);
    if (!quote) return 'no matching order';
    rememberShopifyIds(quote, payload);
    if (topic === 'orders/cancelled' || payload.cancelled_at) {
      if (setStatus(quote, 'cancelled', 'cancelled in Shopify', req)) announce(quote, 'cancelled in Shopify');
      return 'cancelled';
    }
    const paidStates = ['paid', 'partially_paid', 'authorized'];
    if (!quote.paid_at && paidStates.includes(payload.financial_status)) {
      // Shopify is asked for the amount actually received (the same check the
      // app already runs on a timer), so the two paths can never disagree.
      let updated = await paymentService.syncShopifyPayment(quote, { force: true, baseUrl: baseUrlOf(req) });
      if (!updated) updated = recordPayment(quote, { provider: 'shopify', amount: Number(payload.total_price) - Number(payload.total_outstanding || 0), reference: payload.name, paidAt: payload.processed_at, req });
      if (updated) announce(updated, `payment received through Shopify ($${Number(updated.amount_paid).toFixed(2)})`);
      return 'paid';
    }
    if (payload.financial_status === 'refunded' && quote.status !== 'refunded') {
      if (setStatus(quote, 'refunded', 'refunded in Shopify', req)) announce(quote, 'refunded in Shopify');
      return 'refunded';
    }
    return 'updated';
  }

  if (topic === 'refunds/create') {
    const quote = payload.order_id ? db.prepare('SELECT * FROM quotes WHERE shopify_order_id = ?').get(shopifyGid(payload.order_id)) : null;
    if (!quote) return 'no matching order';
    const amount = round2((payload.transactions || []).filter(t => t.kind === 'refund' && t.status === 'success').reduce((s, t) => s + Number(t.amount || 0), 0));
    return recordRefund(quote, amount, 'Shopify', req);
  }

  if (topic === 'fulfillments/create' || topic === 'fulfillments/update') {
    const quote = payload.order_id ? db.prepare('SELECT * FROM quotes WHERE shopify_order_id = ?').get(shopifyGid(payload.order_id)) : null;
    if (!quote) return 'no matching order';
    const tracking = [payload.tracking_company, payload.tracking_number].filter(Boolean).join(' ');
    db.prepare('UPDATE quotes SET tracking_carrier = ?, tracking_number = ?, tracking_url = ? WHERE id = ?')
      .run(payload.tracking_company || null, payload.tracking_number || null, payload.tracking_url || (payload.tracking_urls || [])[0] || null, quote.id);
    logEvent(quote.id, 'fulfillment', `Shopify fulfillment ${payload.status || 'updated'}${tracking ? `: ${tracking}` : ''}`);
    if (payload.status === 'success' && quote.fulfillment_method === 'shipping' && !['shipped', 'completed', 'cancelled', 'refunded'].includes(quote.status)) {
      setStatus(quote, 'shipped', 'fulfilled in Shopify', req);
    }
    announce(quote, `shipment ${payload.status || 'updated'} in Shopify`);
    return 'fulfillment';
  }

  if (topic === 'order_transactions/create') {
    if (payload.status !== 'failure' && payload.status !== 'error') return 'ignored';
    const quote = payload.order_id ? db.prepare('SELECT * FROM quotes WHERE shopify_order_id = ?').get(shopifyGid(payload.order_id)) : null;
    if (!quote) return 'no matching order';
    logEvent(quote.id, 'payment_failed', `Shopify payment failed${payload.message ? `: ${payload.message}` : ''}`);
    announce(quote, 'a Shopify payment failed');
    return 'payment failed';
  }
  return 'ignored';
}

router.post('/shopify', async (req, res) => {
  const secret = shopifySecret();
  if (!secret || !req.rawBody) return res.status(401).json({ error: 'Not configured.' });
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
  if (!safeEqual(expected, req.get('x-shopify-hmac-sha256'))) return res.status(401).json({ error: 'Bad signature.' });
  const topic = String(req.get('x-shopify-topic') || '');
  if (!firstDelivery('shopify', req.get('x-shopify-event-id') || req.get('x-shopify-webhook-id'), topic)) return res.json({ ok: true, duplicate: true });
  try {
    const result = await handleShopify(topic, req.body || {}, req);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[webhooks] Shopify', topic, err);
    res.json({ ok: true, result: 'error logged' }); // acknowledged: a retry would hit the same error
  }
});

// =================================================================== Square
function quoteForSquare({ paymentId, orderId, text }) {
  if (paymentId) { const q = db.prepare('SELECT * FROM quotes WHERE square_payment_id = ?').get(paymentId); if (q) return q; }
  if (orderId) { const q = db.prepare('SELECT * FROM quotes WHERE square_order_id = ?').get(orderId); if (q) return q; }
  const code = (String(text || '').match(ORDER_CODE_RE) || [])[0];
  return code ? db.prepare('SELECT * FROM quotes WHERE quote_code = ?').get(code.toUpperCase()) : null;
}
const cents = (money) => round2(Number(money && money.amount || 0) / 100);

function handleSquare(event, req) {
  const type = String(event.type || '');
  const object = (event.data && event.data.object) || {};

  if (type === 'payment.created' || type === 'payment.updated') {
    const p = object.payment || {};
    const quote = quoteForSquare({ paymentId: p.id, orderId: p.order_id, text: `${p.reference_id || ''} ${p.note || ''}` });
    if (!quote) return 'no matching order';
    db.prepare('UPDATE quotes SET square_payment_id = ?, square_order_id = COALESCE(?, square_order_id), square_customer_id = COALESCE(?, square_customer_id) WHERE id = ?')
      .run(p.id, p.order_id || null, p.customer_id || null, quote.id);
    if (p.status === 'COMPLETED') {
      if (quote.paid_at) { logEvent(quote.id, 'payment_note', `Square payment ${p.id} completed; this order was already marked paid.`); return 'already paid'; }
      const updated = recordPayment(quote, { provider: 'square', amount: cents(p.total_money || p.amount_money), reference: p.receipt_number || p.id, paidAt: p.updated_at, req });
      if (updated) announce(updated, `payment received through Square ($${Number(updated.amount_paid).toFixed(2)})`);
      return 'paid';
    }
    if (p.status === 'FAILED' || p.status === 'CANCELED') {
      logEvent(quote.id, 'payment_failed', `Square payment ${p.status.toLowerCase()}`);
      announce(quote, `a Square payment ${p.status.toLowerCase()}`);
      return 'payment failed';
    }
    return 'payment pending';
  }

  if (type === 'refund.created' || type === 'refund.updated') {
    const r = object.refund || {};
    if (r.status !== 'COMPLETED') return 'refund pending';
    const quote = quoteForSquare({ paymentId: r.payment_id, orderId: r.order_id });
    if (!quote) return 'no matching order';
    return recordRefund(quote, cents(r.amount_money), 'Square', req);
  }

  if (type === 'order.updated' || type === 'order.created') {
    const o = object.order_updated || object.order_created || {};
    const quote = quoteForSquare({ orderId: o.order_id });
    if (!quote) return 'no matching order';
    if (o.state === 'CANCELED') { if (setStatus(quote, 'cancelled', 'cancelled in Square', req)) announce(quote, 'cancelled in Square'); return 'cancelled'; }
    logEvent(quote.id, 'payment_note', `Square order ${o.state ? o.state.toLowerCase() : 'updated'}`);
    return 'order updated';
  }
  return 'ignored';
}

router.post('/square', (req, res) => {
  const key = getSetting('square_webhook_signature_key', '') || process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
  if (!key || !req.rawBody) return res.status(401).json({ error: 'Not configured.' });
  // Square signs the exact notification URL it was given plus the body.
  const url = getSetting('square_webhook_url', '') || `${baseUrlOf(req)}/api/webhooks/square`;
  const expected = crypto.createHmac('sha256', key).update(url + req.rawBody.toString('utf8')).digest('base64');
  if (!safeEqual(expected, req.get('x-square-hmacsha256-signature'))) return res.status(401).json({ error: 'Bad signature.' });
  const event = req.body || {};
  if (!firstDelivery('square', event.event_id, event.type)) return res.json({ ok: true, duplicate: true });
  try {
    res.json({ ok: true, result: handleSquare(event, req) });
  } catch (err) {
    console.error('[webhooks] Square', event.type, err);
    res.json({ ok: true, result: 'error logged' });
  }
});

// ================================================================== shared
/** Marks an unpaid order paid, once. Returns the updated order, or null if it was already paid. */
function recordPayment(quote, { provider, amount, reference, paidAt, req }) {
  const paid = round2(amount);
  if (!(paid > 0)) return null;
  const grand = quote.grand_total != null ? Number(quote.grand_total) : null;
  const balance = grand != null ? Math.max(0, round2(grand - paid)) : 0;
  const status = balance > 0.009 ? 'deposit_paid' : 'paid';
  const now = new Date().toISOString();
  // paid_at IS NULL guard: whichever of Shopify, Square or the timer gets there first records it, once.
  const result = db.prepare(`UPDATE quotes SET status = ?, paid_at = ?, amount_paid = ?, balance_due = ?, payment_provider = ?, payment_reference = ?, updated_at = ?
    WHERE id = ? AND paid_at IS NULL`).run(status, paidAt || now, paid, balance, provider, reference || null, now, quote.id);
  if (!result.changes) return null;
  const name = provider === 'square' ? 'Square' : 'Shopify';
  logEvent(quote.id, 'paid', `${name} payment ${reference || ''} received: $${paid.toFixed(2)}${balance > 0.009 ? ` (balance $${balance.toFixed(2)})` : ''}.`);
  logEvent(quote.id, 'status_change', `${quote.status} -> ${status} (${name} payment)`);
  const updated = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quote.id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(updated.customer_id);
  if (customer && customer.email) emailService.sendStatusUpdateEmail(updated, customer, baseUrlOf(req), 'paid').catch(err => console.error('Paid email failed:', err.message));
  return updated;
}
function recordRefund(quote, amount, providerName, req) {
  if (!(amount > 0)) return 'refund ignored';
  const total = round2(Number(quote.amount_refunded || 0) + amount);
  db.prepare('UPDATE quotes SET amount_refunded = ?, updated_at = ? WHERE id = ?').run(total, new Date().toISOString(), quote.id);
  logEvent(quote.id, 'refund', `${providerName} refund of $${amount.toFixed(2)} (refunded so far: $${total.toFixed(2)})`);
  const full = quote.amount_paid != null && total >= Number(quote.amount_paid) - 0.009;
  if (full) setStatus(quote, 'refunded', `fully refunded in ${providerName}`, req);
  announce(quote, `${full ? 'fully' : 'partly'} refunded in ${providerName} ($${amount.toFixed(2)})`);
  return full ? 'refunded' : 'partial refund';
}

// ---------------------------------------------- registering with Shopify
const SHOPIFY_TOPICS = ['ORDERS_CREATE', 'ORDERS_PAID', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE', 'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE', 'ORDER_TRANSACTIONS_CREATE'];
/** Asks Shopify to send the events above to this app. Returns one line per topic saying what happened. */
async function registerShopifyWebhooks(baseUrl) {
  const shopDomain = getSetting('shopify_shop_domain', '') || process.env.SHOPIFY_SHOP_DOMAIN || '';
  const clientId = getSetting('shopify_client_id', '') || process.env.SHOPIFY_CLIENT_ID || '';
  const secret = shopifySecret();
  if (!shopDomain || !clientId || !secret) throw new Error('Add your Shopify shop domain, client ID and client secret first.');
  const token = await paymentService.getShopifyAccessToken(shopDomain, clientId, secret);
  const callbackUrl = `${baseUrl.replace(/\/+$/, '')}/api/webhooks/shopify`;
  const mutation = `mutation register($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
  }`;
  const results = [];
  for (const topic of SHOPIFY_TOPICS) {
    try {
      const resp = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: mutation, variables: { topic, sub: { callbackUrl, format: 'JSON' } } }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await resp.json();
      const out = json && json.data && json.data.webhookSubscriptionCreate;
      const errors = [...((out && out.userErrors) || []), ...((json && json.errors) || [])].map(e => e.message);
      const already = errors.some(m => /already been taken|already exists/i.test(m));
      results.push({ topic, ok: !!(out && out.webhookSubscription) || already, message: out && out.webhookSubscription ? 'registered' : already ? 'already registered' : errors.join('; ') || `HTTP ${resp.status}` });
    } catch (err) {
      results.push({ topic, ok: false, message: err.message });
    }
  }
  return { callbackUrl, results };
}

module.exports = router;
module.exports.registerShopifyWebhooks = registerShopifyWebhooks;
module.exports.recordPayment = recordPayment;
