// server/services/shopifyOrders.js
//
// Orders placed straight on the Shopify store (DTF transfers and anything
// else sold there) come into the admin as ordinary orders, tagged Shopify,
// so they show on the Production Board, Orders, search, alerts and the daily
// summary next to calculator orders.
//
//  - Each Shopify order becomes ONE quotes row, coded SH-<Shopify number>,
//    found again by its Shopify id. Orders that started in the calculator
//    (their checkout carries a quote_id) are never imported a second time.
//  - Only paid orders come in; an unpaid one comes in when it's paid.
//  - Shopify's own totals (tax, shipping, total) are kept as they are
//    (pricing_snapshot.fixedTotals, see server/checkoutRules.js).
//  - Ways in: the orders/* webhooks (server/routes/webhooks.js), a check
//    every 15 minutes for anything a webhook missed, and the admin's
//    "Import open Shopify orders" button.
//  - Two-way: when an order with a Shopify id is marked shipped or picked
//    up in the admin, it is marked fulfilled in Shopify (no Shopify email;
//    the customer already gets this app's status email).

const db = require('../db');
const { getSetting } = require('../pricingEngine');

const API_VERSION = '2024-10';
const PAID_STATES = ['paid', 'partially_paid', 'authorized'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const gidOf = (id) => `gid://shopify/Order/${id}`;

function credentials() {
  const shopDomain = getSetting('shopify_shop_domain', '') || process.env.SHOPIFY_SHOP_DOMAIN || '';
  const clientId = getSetting('shopify_client_id', '') || process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = getSetting('shopify_client_secret', '') || process.env.SHOPIFY_CLIENT_SECRET || '';
  return shopDomain && clientId && clientSecret ? { shopDomain, clientId, clientSecret } : null;
}

/** One Shopify Admin REST call. Returns { json, link } or throws a readable error. */
async function shopify(path, { method = 'GET', body } = {}) {
  const c = credentials();
  if (!c) throw new Error('Shopify is not connected yet (Settings > Payment).');
  const token = await require('./paymentService').getShopifyAccessToken(c.shopDomain, c.clientId, c.clientSecret);
  const url = /^https:/.test(path) ? path : `https://${c.shopDomain}/admin/api/${API_VERSION}/${path.replace(/^\//, '')}`;
  const resp = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = json.errors ? (typeof json.errors === 'string' ? json.errors : JSON.stringify(json.errors)) : resp.statusText;
    const err = new Error(resp.status === 403
      ? `Shopify said no (403): your Shopify app is missing a permission. ${detail}`
      : `Shopify error ${resp.status}: ${detail}`);
    err.status = resp.status;
    throw err;
  }
  return { json, link: resp.headers.get('link') || '' };
}

// ----------------------------------------------------------------- reading
/** True for an order that came from the calculator's own checkout (it carries the 3T order number). */
function isCalculatorOrder(order) {
  const attrs = order.note_attributes || [];
  if (attrs.some(a => a && ['quote_id', 'quote_ids'].includes(a.name))) return true;
  return /^3T (Quote|cart of)/.test(String(order.note || ''));
}
const isPaid = (order) => PAID_STATES.includes(order.financial_status);

/** Pickup when the shipping method says so (Shopify local pickup), otherwise shipping if there's an address. */
function fulfillmentOf(order) {
  const lines = order.shipping_lines || [];
  if (lines.some(l => /pick ?up|local/i.test(`${l.title || ''} ${l.code || ''} ${l.source || ''}`))) return 'pickup';
  return order.shipping_address ? 'shipping' : 'pickup';
}

function itemsOf(order) {
  return (order.line_items || []).map(li => ({
    title: li.title || li.name || 'Item', variant: li.variant_title || '', sku: li.sku || '',
    qty: Number(li.quantity) || 0, price: round2(li.price), requiresShipping: li.requires_shipping !== false,
    // Upload apps and product options put the customer's choices and file links here.
    properties: (li.properties || []).filter(p => p && p.name && p.value !== '' && p.value != null).map(p => ({ name: String(p.name), value: String(p.value) })),
  }));
}

/** The pricing snapshot an imported order is stored with. */
function snapshotOf(order) {
  const items = itemsOf(order);
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const summary = items.length ? `${items[0].title}${items[0].variant ? ` (${items[0].variant})` : ''}${items.length > 1 ? ` + ${items.length - 1} more` : ''}` : 'Shopify order';
  const shipping = round2((order.shipping_lines || []).reduce((s, l) => s + Number(l.discounted_price ?? l.price ?? 0), 0));
  return {
    source: 'shopify',
    garment: { name: summary }, totalQty, total: round2(order.subtotal_price), rushRule: null, lines: [],
    fixedTotals: { subtotal: round2(order.subtotal_price), tax: round2(order.total_tax), shipping, grandTotal: round2(order.total_price), outstanding: round2(order.total_outstanding || 0) },
    shopifyOrder: {
      id: String(order.id), gid: order.admin_graphql_api_id || gidOf(order.id), name: order.name || `#${order.order_number}`,
      adminUrl: credentials() ? `https://${credentials().shopDomain}/admin/orders/${order.id}` : null,
      statusUrl: order.order_status_url || null, createdAt: order.created_at, items,
      shippingMethod: (order.shipping_lines || []).map(l => l.title).filter(Boolean).join(', '),
      discountCodes: (order.discount_codes || []).map(d => d.code).filter(Boolean), tags: order.tags || '',
      financialStatus: order.financial_status || null, fulfillmentStatus: order.fulfillment_status || null,
    },
  };
}

function storeGarmentId() {
  const marker = 'SHOPIFY:store';
  const row = db.prepare('SELECT id FROM garments WHERE style_number = ? AND archived = 1').get(marker);
  if (row) return row.id;
  const id = db.prepare(`INSERT INTO garments (name, brand, style_number, description, image_url, internal_cost, customer_price_adjustment, active, sort_order)
    VALUES (?,?,?,?,?,?,?,0,?)`).run('Shopify store order', '', marker, 'Stand-in for orders imported from the Shopify store.', '', 0, 0, 9999).lastInsertRowid;
  db.prepare('UPDATE garments SET archived = 1 WHERE id = ?').run(id);
  return id;
}

function customerFor(order) {
  const c = order.customer || {};
  const addr = order.shipping_address || order.billing_address || {};
  const email = String(order.email || order.contact_email || c.email || '').trim().toLowerCase();
  const first = c.first_name || addr.first_name || 'Shopify';
  const last = c.last_name || addr.last_name || 'Customer';
  const phone = String(order.phone || c.phone || addr.phone || '').trim();
  if (email) {
    const found = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
    if (found) return found;
  }
  const id = db.prepare('INSERT INTO customers (first_name,last_name,email,phone,business_name) VALUES (?,?,?,?,?)')
    .run(first, last, email, phone, addr.company || null).lastInsertRowid;
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

// ----------------------------------------------------------------- importing
/**
 * Brings one Shopify order into the admin (or refreshes it if it's already
 * here). Returns { quote, created } or null when it isn't one to import.
 */
function importOrder(order, { notify = false, baseUrl = '' } = {}) {
  if (!order || !order.id || isCalculatorOrder(order)) return null;
  const gid = order.admin_graphql_api_id || gidOf(order.id);
  const existing = db.prepare('SELECT * FROM quotes WHERE shopify_order_id = ?').get(gid);
  const snapshot = snapshotOf(order);
  const paidAmount = round2(Number(order.total_price) - Number(order.total_outstanding || 0));
  if (existing) {
    // keep items and money in step with edits made in Shopify
    if (String(existing.quote_code).startsWith('SH-')) {
      db.prepare('UPDATE quotes SET pricing_snapshot=?, subtotal=?, total=?, amount_paid=COALESCE(?, amount_paid), balance_due=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(snapshot), snapshot.total, snapshot.total, existing.paid_at ? paidAmount : null, snapshot.fixedTotals.outstanding, new Date().toISOString(), existing.id);
    }
    return { quote: db.prepare('SELECT * FROM quotes WHERE id = ?').get(existing.id), created: false };
  }
  if (!isPaid(order) || order.cancelled_at) return null;

  const customer = customerFor(order);
  const number = String(order.order_number || String(order.name || '').replace(/\D/g, '') || order.id);
  let code = `SH-${number}`;
  if (db.prepare('SELECT 1 FROM quotes WHERE quote_code = ?').get(code)) code = `SH-${number}-${String(order.id).slice(-4)}`;
  const finished = order.fulfillment_status === 'fulfilled';
  const status = finished ? 'completed' : snapshot.fixedTotals.outstanding > 0.009 ? 'deposit_paid' : 'paid';
  const ship = order.shipping_address;
  const now = new Date().toISOString();
  const id = db.prepare(`INSERT INTO quotes (quote_code, customer_id, status, garment_id, fulfillment_method, pricing_snapshot, subtotal, total, expires_at,
      paid_at, amount_paid, balance_due, payment_provider, payment_reference, shopify_order_id, shopify_order_number, notes, shipping_address,
      artwork_pending, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    code, customer.id, status, storeGarmentId(), fulfillmentOf(order), JSON.stringify(snapshot), snapshot.total, snapshot.total, order.created_at || now,
    order.processed_at || order.created_at || now, paidAmount, snapshot.fixedTotals.outstanding, 'shopify', order.name || null, gid, order.name || null,
    order.note || null, ship ? JSON.stringify({ line1: ship.address1 || '', line2: ship.address2 || '', city: ship.city || '', state: ship.province_code || ship.province || '', zip: ship.zip || '' }) : null,
    0, order.created_at || now, now).lastInsertRowid;
  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'generated', ?)`)
    .run(id, `Imported from Shopify order ${order.name || number}: ${snapshot.totalQty} item${snapshot.totalQty === 1 ? '' : 's'}, $${snapshot.fixedTotals.grandTotal.toFixed(2)}.`);
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  if (notify) {
    require('./emailService').sendShopifyOrderAlert(quote, customer, snapshot, baseUrl).catch(err => console.error('Shopify order alert failed:', err.message));
    require('./realtime').publish({ type: 'order', orderNumber: code, message: `New Shopify order ${order.name || code} from ${customer.first_name} ${customer.last_name}` });
  }
  return { quote, created: true };
}

/** Every page of a Shopify orders listing (follows the Link header). */
async function listOrders(query) {
  const all = [];
  let next = `orders.json?${query}`;
  for (let page = 0; next && page < 20; page++) {
    const { json, link } = await shopify(next);
    all.push(...(json.orders || []));
    const m = /<([^>]+)>;\s*rel="next"/.exec(link);
    next = m ? m[1] : null;
  }
  return all;
}

/** "Import open Shopify orders": every paid, not yet fulfilled store order. No alert emails. */
async function importOpenOrders() {
  const orders = await listOrders('status=open&fulfillment_status=unfulfilled&limit=250');
  let imported = 0, alreadyHere = 0, skipped = 0;
  for (const o of orders) {
    const r = importOrder(o);
    if (!r) skipped++; else if (r.created) imported++; else alreadyHere++;
  }
  setLastSync(new Date().toISOString());
  return { found: orders.length, imported, alreadyHere, skipped };
}

/** Every 15 minutes: anything paid or changed since the last check (a safety net for missed webhooks). */
async function syncRecent(baseUrl) {
  if (!credentials()) return null;
  const since = getSetting('shopify_orders_synced_at', '') || new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const started = new Date().toISOString();
  const orders = await listOrders(`status=any&updated_at_min=${encodeURIComponent(since)}&limit=250`);
  let imported = 0;
  for (const o of orders) { const r = importOrder(o, { notify: true, baseUrl }); if (r && r.created) imported++; }
  setLastSync(started);
  return { checked: orders.length, imported };
}
function setLastSync(at) {
  db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('shopify_orders_synced_at',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(at, at);
}

// ----------------------------------------------------------------- fulfilling
/**
 * Marks the Shopify order behind an admin order fulfilled (everything still
 * open on it), with tracking if the admin order has it. Shopify does not
 * email the customer; this app's own status email covers that.
 * Returns a short result line; never throws.
 */
async function fulfillInShopify(quote) {
  if (!quote || !quote.shopify_order_id || !credentials()) return { ok: false, skipped: true };
  const orderId = String(quote.shopify_order_id).split('/').pop();
  try {
    const { json } = await shopify(`orders/${orderId}/fulfillment_orders.json`);
    const open = (json.fulfillment_orders || []).filter(fo => ['open', 'in_progress', 'scheduled'].includes(fo.status)
      && (!fo.supported_actions || fo.supported_actions.includes('create_fulfillment')));
    if (!open.length) return { ok: true, message: 'already fulfilled in Shopify' };
    const tracking = quote.tracking_number ? { number: quote.tracking_number, company: quote.tracking_carrier || undefined, url: quote.tracking_url || undefined } : undefined;
    await shopify('fulfillments.json', { method: 'POST', body: { fulfillment: {
      line_items_by_fulfillment_order: open.map(fo => ({ fulfillment_order_id: fo.id })), notify_customer: false, ...(tracking ? { tracking_info: tracking } : {}),
    } } });
    return { ok: true, message: 'marked fulfilled in Shopify' };
  } catch (err) {
    const hint = err.status === 403 ? ' In the Shopify Dev Dashboard, give your app the "write_merchant_managed_fulfillment_orders" access, release a new version and install it again.' : '';
    return { ok: false, message: `couldn't mark it fulfilled in Shopify: ${err.message}${hint}` };
  }
}

module.exports = { importOrder, importOpenOrders, syncRecent, fulfillInShopify, isCalculatorOrder, snapshotOf, credentials };
