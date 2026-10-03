// server/services/emailService.js
//
// Email abstraction. The mock provider (default) "sends" by logging the
// email to the database (visible in the admin under Quotes > Emails) and to
// the console, plus writing a .html copy to /data/emails for inspection.
// Swap in a real provider (Postmark, SendGrid, SES, SMTP...) by implementing
// sendViaRealProvider() and flipping the `email_provider` setting.

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const db = require('./../db');
const { getSetting } = require('../pricingEngine');

const EMAIL_DIR = path.join(require('../dataDir').DATA_DIR, 'emails');
if (!fs.existsSync(EMAIL_DIR)) fs.mkdirSync(EMAIL_DIR, { recursive: true });

// ------------------------------------------------------------- gmail (SMTP)
// Real delivery via a personal/workspace Gmail account, authenticated with
// an "app password" (Settings > Email in the admin) rather than full OAuth —
// simpler to set up for a single-store business like this and doesn't
// require registering an OAuth app with Google. See README > Email setup.
let gmailTransportFactory = (gmailAddress, gmailAppPassword) =>
  nodemailer.createTransport({ service: 'gmail', auth: { user: gmailAddress, pass: gmailAppPassword } });
let cachedTransporter = null;
let cachedTransporterKey = null;

function getGmailTransporter(gmailAddress, gmailAppPassword) {
  const key = `${gmailAddress}:${gmailAppPassword}`;
  if (cachedTransporter && cachedTransporterKey === key) return cachedTransporter;
  cachedTransporter = gmailTransportFactory(gmailAddress, gmailAppPassword);
  cachedTransporterKey = key;
  return cachedTransporter;
}

// Test-only hooks (mirrors paymentService.js's pattern for Shopify) so unit
// tests can fake the transporter instead of hitting real Gmail servers.
function _setGmailTransportFactoryForTests(factory) {
  gmailTransportFactory = factory;
  cachedTransporter = null;
  cachedTransporterKey = null;
}
function _resetGmailTransportForTests() {
  gmailTransportFactory = (gmailAddress, gmailAppPassword) =>
    nodemailer.createTransport({ service: 'gmail', auth: { user: gmailAddress, pass: gmailAppPassword } });
  cachedTransporter = null;
  cachedTransporterKey = null;
}

function renderQuoteEmail(quote, customer, baseUrl) {
  const snapshot = JSON.parse(quote.pricing_snapshot);
  const quoteUrl = `${baseUrl}/quote.html?id=${encodeURIComponent(quote.quote_code)}`;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <div style="background:#000;color:#CCFF00;padding:24px 28px;font-weight:800;font-size:20px;">3T PRINT SOLUTIONS</div>
    <div style="padding:28px;border:1px solid #E5E5E5;border-top:none;">
      <h2 style="margin-top:0;">Your quote is ready — #${quote.quote_code}</h2>
      <p>Hi ${customer.first_name}, thanks for building your order with 3T Print Solutions! Here's a quick summary:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#555;">${itemLabel(snapshot)}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${garmentLabel(quote, snapshot)}</td></tr>
        <tr><td style="padding:6px 0;color:#555;">Quantity</td><td style="padding:6px 0;text-align:right;font-weight:600;">${snapshot.totalQty}</td></tr>
        ${orderDetailRows(quote, snapshot)}
        <tr><td style="padding:10px 0;color:#555;border-top:1px solid #eee;font-size:18px;">Order Total</td><td style="padding:10px 0;text-align:right;font-weight:800;font-size:18px;border-top:1px solid #eee;">$${snapshot.total.toFixed(2)}</td></tr>
      </table>
      <p style="font-size:13px;color:#555;margin:0 0 14px;">Before sales tax${quote.rush ? ' and the rush fee' : ''}. Your quote page shows the full breakdown and your design preview.</p>
      <a href="${quoteUrl}" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin-bottom:10px;">CONFIRM ORDER</a>
      <a href="${quoteUrl}" style="display:block;text-align:center;background:#fff;color:#000;border:1px solid #000;text-decoration:none;font-weight:700;padding:12px;border-radius:8px;margin-bottom:10px;">Edit Order</a>
      <a href="${quoteUrl}#review" style="display:block;text-align:center;color:#555;text-decoration:underline;font-size:13px;padding:8px;">Request a review before paying</a>
      <p style="font-size:12px;color:#777;margin-top:24px;">This quote is valid for ${getSetting('quote_expiration_days','7')} days. Questions? Just reply to this email.</p>
    </div>
  </div>`;
}

// The order's details as table rows for the quote and new-order emails:
// colors and sizes, each print location with the design size and where the
// customer placed it, rush, and design notes.
function orderDetailRows(quote, snapshot) {
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = (label, value) => value ? `<tr><td style="padding:6px 0;color:#555;vertical-align:top;">${label}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${value}</td></tr>` : '';
  const inches = (v) => `${Math.round(Number(v) * 4) / 4} in`;
  // Sticker / poster / mylar orders: a size and any add-ons, no colors or print locations.
  if (snapshot.printOrder) {
    const p = snapshot.printOrder;
    const options = [
      ...(p.options || []).map(o => `${e(o.group)}: ${e(o.choice)}`),
      ...p.addons.map(a => e(a.name)),
    ].join('<br>');
    const design = p.design ? e(p.design.methodLabel) + (p.design.templateName ? `: ${e(p.design.templateName)}` : '')
      + (p.design.logoLabel ? `<br><span style="font-weight:400;">Logo: ${e(p.design.logoLabel)}</span>` : '') : '';
    // what the customer saw on the review screen: the approved mockup and the full total
    const mockup = quote.id ? db.prepare("SELECT stored_filename FROM artwork_files WHERE quote_id = ? AND location_name = 'Approved Mockup' ORDER BY id DESC").get(quote.id) : null;
    const base = process.env.RENDER_EXTERNAL_URL || '';
    const mockupRow = mockup ? row('Approved mockup', `<a href="${base}/uploads/${e(mockup.stored_filename)}" style="color:#111;">View Approved Mockup</a>`) : '';
    const money = (n) => `$${Number(n).toFixed(2)}`;
    const checkout = require('../checkoutRules').computeCheckout(snapshot.total, { rush: !!quote.rush, paymentOption: quote.payment_option, shipping: quote.fulfillment_method === 'shipping' });
    const lines = (snapshot.addonLines || []).map(l => row(e(l.name), money(l.total))).join('');
    const totals = row('Subtotal', money(snapshot.subtotal))
      + (snapshot.discount ? row(`Discount (${e(snapshot.discount.code)})`, `-${money(snapshot.discountAmount)}`) : '')
      + (checkout.rushFee > 0 ? row('Rush', money(checkout.rushFee)) : '')
      + row('Shipping', checkout.shippingFee > 0 ? money(checkout.shippingFee) : 'Local pickup')
      + row('Estimated tax', money(checkout.taxAmount))
      + row('Estimated total', `<strong>${money(checkout.grandTotal)}</strong>`);
    return row('Size', e(p.sizeLabel)) + row('Options', options) + row('Design', design) + mockupRow
      + (p.includeMisprints ? row('Misprints', 'Include if available') : '') + lines + totals
      + row('Rush', quote.rush ? 'Yes' : '') + row('Artwork', quote.artwork_pending ? 'To be sent later' : '')
      + row('Design notes', e(quote.design_notes));
  }
  const byColor = {};
  for (const l of snapshot.lines || []) (byColor[l.colorName] = byColor[l.colorName] || []).push(`${e(l.sizeLabel)} x ${l.quantity}`);
  const colors = Object.entries(byColor).map(([name, sizes]) => `${e(name)}: ${sizes.join(', ')}`).join('<br>');
  let placements = [];
  try { placements = quote.placements_json ? JSON.parse(quote.placements_json) : []; } catch (err) { placements = []; }
  const sizeLabel = { chest: 'Left Chest size', large: 'Large Graphic', oversized: 'Oversized' };
  const locations = (snapshot.printLocations || []).map(p => {
    const pl = placements.find(x => x.locationName === p.name);
    return `${e(p.name)}${sizeLabel[p.designSize] ? ` (${sizeLabel[p.designSize]})` : ''}`
      + (pl ? `<br><span style="font-weight:400;">Design ${inches(pl.widthIn)} wide x ${inches(pl.heightIn)} tall${pl.fileName ? `, ${e(pl.fileName)}` : ''}</span>` : '');
  }).join('<br>');
  return row('Colors &amp; sizes', colors) + row('Print locations', locations)
    + row('Rush', quote.rush ? 'Yes' : '') + row('Artwork', quote.artwork_pending ? 'To be sent later' : '')
    + row('Design notes', e(quote.design_notes));
}

// "Garment" for apparel orders, "Product" for sticker / poster / mylar orders.
function itemLabel(snapshot) { return snapshot.printOrder ? 'Product' : 'Garment'; }

// Garment line for emails: "Other / Not Listed" shows what the customer
// described, and customer-supplied garments are noted.
function garmentLabel(quote, snapshot) {
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let label = e(snapshot.printOrder ? snapshot.printOrder.productName : snapshot.garment.name);
  if (quote && quote.custom_garment_description) label += `<br><span style="font-weight:400;">${e(quote.custom_garment_description)}</span>`;
  if (quote && quote.customer_supplied_garment) label += '<br><span style="font-weight:400;">(customer-supplied)</span>';
  return label;
}

async function sendQuoteEmail(quote, customer, baseUrl) {
  const subject = `Your 3T Print Solutions Quote - #${quote.quote_code}`;
  const html = renderQuoteEmail(quote, customer, baseUrl);
  return send({ quoteId: quote.id, to: customer.email, subject, html, bcc: ordersCopyAddress(customer.email) });
}

// ------------------------------------------------- owner "new order" notice
// Sent to the business on EVERY quote submission, paid or not, so a new
// lead is never missed. Goes only to the orders inbox (Settings > Email, the
// same address that gets a copy of every customer email). If that is left
// blank it falls back to the Business Email and the connected Gmail address.
function ownerRecipients() {
  const orders = String(getSetting('orders_copy_email', DEFAULT_ORDERS_COPY_EMAIL) || '').trim();
  if (orders) return [orders];
  const seen = new Set();
  return [getSetting('business_email', ''), getSetting('gmail_address', '')]
    .map(a => String(a || '').trim())
    .filter(a => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
}
function renderOrderNotificationEmail(quote, customer, baseUrl, reviewReasons) {
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const snapshot = JSON.parse(quote.pricing_snapshot);
  const row = (label, value) => value ? `<tr><td style="padding:6px 0;color:#555;vertical-align:top;">${label}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${value}</td></tr>` : '';
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <div style="background:#000;color:#CCFF00;padding:24px 28px;font-weight:800;font-size:20px;">3T PRINT SOLUTIONS</div>
    <div style="padding:28px;border:1px solid #E5E5E5;border-top:none;">
      <h2 style="margin-top:0;">New order submitted — #${e(quote.quote_code)}</h2>
      <p>${e(customer.first_name)} ${e(customer.last_name)} just submitted an order. It has not been paid yet.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        ${row('Customer', `${e(customer.first_name)} ${e(customer.last_name)}`)}
        ${row('Business', e(customer.business_name))}
        ${row('Email', `<a href="mailto:${e(customer.email)}">${e(customer.email)}</a>`)}
        ${row('Phone', e(customer.phone))}
        ${row(itemLabel(snapshot), garmentLabel(quote, snapshot))}
        ${row('Quantity', e(snapshot.totalQty))}
        ${orderDetailRows(quote, snapshot)}
        ${row('Fulfillment', quote.fulfillment_method === 'shipping' ? 'Shipping' : 'Pickup')}
        ${row('Needed by', e(quote.needed_by_date))}
        ${row('Notes', e(quote.notes))}
        ${row('Needs review', (reviewReasons || []).length ? e(reviewReasons.join(', ').replace(/_/g, ' ')) : '')}
        <tr><td style="padding:10px 0;color:#555;border-top:1px solid #eee;font-size:18px;">Order Total</td><td style="padding:10px 0;text-align:right;font-weight:800;font-size:18px;border-top:1px solid #eee;">$${snapshot.total.toFixed(2)}</td></tr>
      </table>
      <a href="${baseUrl}/admin/dashboard.html" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin-bottom:10px;">OPEN ADMIN</a>
      <a href="${baseUrl}/quote.html?id=${encodeURIComponent(quote.quote_code)}" style="display:block;text-align:center;color:#555;text-decoration:underline;font-size:13px;padding:8px;">View the customer's quote page</a>
      <p style="font-size:12px;color:#777;margin-top:24px;">Reply to this email to write back to the customer.</p>
    </div>
  </div>`;
}
async function sendOrderNotification(quote, customer, baseUrl, reviewReasons) {
  const recipients = ownerRecipients();
  if (!recipients.length) return { skipped: true };
  const subject = `New Order Submitted - #${quote.quote_code} - ${customer.first_name} ${customer.last_name} ($${JSON.parse(quote.pricing_snapshot).total.toFixed(2)})`;
  const html = renderOrderNotificationEmail(quote, customer, baseUrl, reviewReasons);
  // One email per inbox, so one bad address never stops the other.
  const results = await Promise.allSettled(recipients.map(to => send({ quoteId: quote.id, to, subject, html, replyTo: customer.email })));
  results.forEach((r, i) => { if (r.status === 'rejected') console.error(`Order notification to ${recipients[i]} failed:`, r.reason && r.reason.message); });
  return { recipients };
}

// ---------------------------------------------------------- manual reminder
// Triggered by the admin's "Send Reminder" button (any unpaid order,
// repeatable — not tied to a status change). Reuses the same itemized-quote
// layout as the original quote email so the customer sees the exact same
// breakdown, just with reminder-specific framing.
function renderReminderEmail(quote, customer, baseUrl) {
  const snapshot = JSON.parse(quote.pricing_snapshot);
  const quoteUrl = `${baseUrl}/quote.html?id=${encodeURIComponent(quote.quote_code)}`;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <div style="background:#000;color:#CCFF00;padding:24px 28px;font-weight:800;font-size:20px;">3T PRINT SOLUTIONS</div>
    <div style="padding:28px;border:1px solid #E5E5E5;border-top:none;">
      <h2 style="margin-top:0;">Reminder: Your order is waiting — #${quote.quote_code}</h2>
      <p>Hi ${customer.first_name}, just a friendly reminder that your order with 3T Print Solutions hasn't been placed yet. Here's a quick summary:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#555;">${itemLabel(snapshot)}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${garmentLabel(quote, snapshot)}</td></tr>
        <tr><td style="padding:6px 0;color:#555;">Quantity</td><td style="padding:6px 0;text-align:right;font-weight:600;">${snapshot.totalQty}</td></tr>
        <tr><td style="padding:10px 0;color:#555;border-top:1px solid #eee;font-size:18px;">Order Total</td><td style="padding:10px 0;text-align:right;font-weight:800;font-size:18px;border-top:1px solid #eee;">$${snapshot.total.toFixed(2)}</td></tr>
      </table>
      <a href="${quoteUrl}" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin-bottom:10px;">CONFIRM ORDER</a>
      <a href="${quoteUrl}" style="display:block;text-align:center;background:#fff;color:#000;border:1px solid #000;text-decoration:none;font-weight:700;padding:12px;border-radius:8px;margin-bottom:10px;">Edit Order</a>
      <p style="font-size:12px;color:#777;margin-top:24px;">Questions? Just reply to this email.</p>
    </div>
  </div>`;
}

async function sendReminderEmail(quote, customer, baseUrl) {
  const subject = `Reminder: Your 3T Print Solutions order is waiting - #${quote.quote_code}`;
  const html = renderReminderEmail(quote, customer, baseUrl);
  const result = await send({ quoteId: quote.id, to: customer.email, subject, html, bcc: ordersCopyAddress(customer.email) });
  db.prepare(`INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'reminder_sent', ?)`)
    .run(quote.id, `Reminder emailed to ${customer.email}`);
  return result;
}

// ---------------------------------------------------------- mockup approval
function renderMockupApprovalEmail(quote, customer, baseUrl, mockup) {
  const imageUrl = `${baseUrl}${mockup.imageUrl}`;
  const approveUrl = `${baseUrl}/mockup-approval.html?token=${encodeURIComponent(mockup.approvalToken)}&action=approve`;
  const changesUrl = `${baseUrl}/mockup-approval.html?token=${encodeURIComponent(mockup.approvalToken)}`;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <div style="background:#000;color:#CCFF00;padding:24px 28px;font-weight:800;font-size:20px;">3T PRINT SOLUTIONS</div>
    <div style="padding:28px;border:1px solid #E5E5E5;border-top:none;">
      <h2 style="margin-top:0;">Your mockup is ready for approval — #${quote.quote_code}</h2>
      <p>Hi ${customer.first_name}, take a look at the design mockup for your order below. Once it looks good, approve it and we'll move forward with production — or let us know if you'd like changes.</p>
      <a href="${imageUrl}" target="_blank"><img src="${imageUrl}" alt="Design mockup" style="width:100%;border-radius:8px;border:1px solid #E5E5E5;margin:12px 0;"></a>
      <a href="${approveUrl}" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin-bottom:10px;">APPROVE MOCKUP</a>
      <a href="${changesUrl}" style="display:block;text-align:center;background:#fff;color:#000;border:1px solid #000;text-decoration:none;font-weight:700;padding:12px;border-radius:8px;margin-bottom:10px;">Request Changes</a>
      <p style="font-size:12px;color:#777;margin-top:24px;">Questions? Just reply to this email.</p>
    </div>
  </div>`;
}

async function sendMockupApprovalEmail(quote, customer, baseUrl, mockup) {
  const subject = `Your mockup is ready for approval - #${quote.quote_code}`;
  const html = renderMockupApprovalEmail(quote, customer, baseUrl, mockup);
  return send({ quoteId: quote.id, to: customer.email, subject, html, bcc: ordersCopyAddress(customer.email) });
}

/** Quick internal notification to the business owner when a customer responds to a mockup. */
async function sendMockupResponseNotification(quote, mockup) {
  const to = getSetting('business_email', '');
  if (!to) return { skipped: true };
  const approved = mockup.status === 'approved';
  const subject = `Mockup ${approved ? 'approved' : 'needs changes'} - #${quote.quote_code}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <h2>${approved ? 'Mockup approved!' : 'Customer requested changes'} — #${quote.quote_code}</h2>
    <p>${approved ? 'The customer approved their mockup. It is ready to move to production.' : `The customer requested changes${mockup.customerNote ? `: "${mockup.customerNote}"` : '.'}`}</p>
  </div>`;
  return send({ quoteId: quote.id, to, subject, html });
}

// Friendly customer-facing copy for the order statuses worth emailing about.
// Any status not listed here (draft, quote_generated, quote_viewed,
// checkout_started, ...) is a purely internal/automatic transition and does
// NOT trigger an email — those either already have their own email (the
// initial quote) or would be spammy/premature to notify a customer about.
const STATUS_EMAIL_COPY = {
  paid: {
    subject: 'Thank you for your order!',
    heading: 'Thank you for your order!',
    message: "We've received your payment and your order is confirmed. We'll keep you posted as it moves through production.",
  },
  needs_review: {
    subject: 'Your order needs a quick review',
    heading: "We're taking a closer look",
    message: "Your order needs a quick review from our team before it moves forward. No action is needed from you right now — we'll follow up shortly.",
  },
  artwork_issue: {
    subject: 'A quick question about your artwork',
    heading: 'Your artwork needs attention',
    message: "We ran into an issue with the artwork on your order and may need a revised file or a bit more info from you. We'll reach out with details shortly.",
  },
  awaiting_customer: {
    subject: "We're waiting to hear from you",
    heading: 'We need a bit more from you',
    message: "Your order is on hold until we hear back from you. Just reply to this email (or give us a call) so we can keep things moving.",
  },
  approved: {
    subject: 'Your order has been approved',
    heading: 'Order approved!',
    message: 'Good news — your order and artwork have been approved and are headed to production.',
  },
  in_production: {
    subject: 'Your order is in production',
    heading: "We're printing your order",
    message: "Your order is officially in production. We'll let you know the moment it's ready.",
  },
  ready_for_pickup: {
    subject: 'Your order is ready for pickup',
    heading: 'Ready for pickup!',
    message: "Your order is printed and ready to go — come by whenever works for you.",
  },
  shipped: {
    subject: 'Your order has shipped',
    heading: "It's on the way!",
    message: 'Your order has shipped and is on its way to you.',
  },
  completed: {
    subject: 'Your order is complete',
    heading: 'All done — thank you!',
    message: 'Your order is complete. Thanks so much for choosing 3T Print Solutions!',
  },
  cancelled: {
    subject: 'Your order has been cancelled',
    heading: 'Order cancelled',
    message: "Your order has been cancelled. If this doesn't look right or you have questions, just reply to this email.",
  },
  refunded: {
    subject: "You've been refunded",
    heading: 'Refund processed',
    message: 'Your refund has been processed. Depending on your bank, it may take a few business days to show up.',
  },
};

function renderStatusEmail(quote, customer, baseUrl, status) {
  const copy = STATUS_EMAIL_COPY[status];
  const snapshot = JSON.parse(quote.pricing_snapshot);
  const quoteUrl = `${baseUrl}/quote.html?id=${encodeURIComponent(quote.quote_code)}`;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <div style="background:#000;color:#CCFF00;padding:24px 28px;font-weight:800;font-size:20px;">3T PRINT SOLUTIONS</div>
    <div style="padding:28px;border:1px solid #E5E5E5;border-top:none;">
      <h2 style="margin-top:0;">${copy.heading} — #${quote.quote_code}</h2>
      <p>Hi ${customer.first_name}, ${copy.message}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#555;">${itemLabel(snapshot)}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${garmentLabel(quote, snapshot)}</td></tr>
        <tr><td style="padding:6px 0;color:#555;">Quantity</td><td style="padding:6px 0;text-align:right;font-weight:600;">${snapshot.totalQty}</td></tr>
        <tr><td style="padding:10px 0;color:#555;border-top:1px solid #eee;font-size:18px;">Order Total</td><td style="padding:10px 0;text-align:right;font-weight:800;font-size:18px;border-top:1px solid #eee;">$${snapshot.total.toFixed(2)}</td></tr>
      </table>
      <a href="${quoteUrl}" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin-bottom:10px;">VIEW MY ORDER</a>
      <p style="font-size:12px;color:#777;margin-top:24px;">Questions? Just reply to this email.</p>
    </div>
  </div>`;
}

/**
 * Sends a customer-facing email for an order status change, if that status
 * has copy defined. Returns { skipped: true } for internal statuses that
 * shouldn't email the customer, so callers can invoke this unconditionally
 * on every status change without checking first.
 */
async function sendStatusUpdateEmail(quote, customer, baseUrl, status) {
  const copy = STATUS_EMAIL_COPY[status];
  if (!copy) return { skipped: true };
  const html = renderStatusEmail(quote, customer, baseUrl, status);
  return send({ quoteId: quote.id, to: customer.email, subject: copy.subject, html, bcc: ordersCopyAddress(customer.email) });
}

// Every email to a customer is blind-copied to the shop's orders inbox
// (Settings > Email; blank turns it off), so the shop has its own copy of
// exactly what the customer received. The copy is recorded in emails_sent.
const DEFAULT_ORDERS_COPY_EMAIL = 'tripleteeorders@gmail.com';
function ordersCopyAddress(to) {
  const copy = String(getSetting('orders_copy_email', DEFAULT_ORDERS_COPY_EMAIL) || '').trim();
  return copy && copy.toLowerCase() !== String(to || '').trim().toLowerCase() ? copy : null;
}

async function send({ quoteId, to, subject, html, replyTo, bcc }) {
  const provider = getSetting('email_provider', 'mock');

  if (provider === 'mock') {
    db.prepare(`INSERT INTO emails_sent (quote_id, to_email, bcc_email, subject, body_html, provider) VALUES (?,?,?,?,?,'mock')`)
      .run(quoteId || null, to, bcc || null, subject, html);
    const filename = `${Date.now()}_${(to || 'unknown').replace(/[^a-z0-9]/gi, '_')}.html`;
    fs.writeFileSync(path.join(EMAIL_DIR, filename), html, 'utf8');
    console.log(`[emailService:MOCK] "${subject}" -> ${to} (saved to data/emails/${filename})`);
    return { provider: 'mock', delivered: true };
  }

  if (provider === 'gmail') {
    const gmailAddress = getSetting('gmail_address', '');
    const gmailAppPassword = getSetting('gmail_app_password', '');
    if (!gmailAddress || !gmailAppPassword) {
      throw new Error('Gmail is not connected yet — add your Gmail address and app password in Settings > Email.');
    }
    const transporter = getGmailTransporter(gmailAddress, gmailAppPassword);
    await transporter.sendMail({
      from: `"${getSetting('business_name', '3T Print Solutions')}" <${gmailAddress}>`,
      to, subject, html, ...(replyTo ? { replyTo } : {}), ...(bcc ? { bcc } : {}),
    });
    db.prepare(`INSERT INTO emails_sent (quote_id, to_email, bcc_email, subject, body_html, provider) VALUES (?,?,?,?,?,'gmail')`)
      .run(quoteId || null, to, bcc || null, subject, html);
    console.log(`[emailService:GMAIL] "${subject}" -> ${to}${bcc ? ` (bcc ${bcc})` : ''}`);
    return { provider: 'gmail', delivered: true };
  }

  // Other real provider integration points (Postmark/SendGrid/SES/etc.) would go here.
  throw new Error(`Email provider "${provider}" is not yet implemented.`);
}

module.exports = {
  sendQuoteEmail, sendStatusUpdateEmail, sendReminderEmail, sendOrderNotification,
  sendMockupApprovalEmail, sendMockupResponseNotification, send,
  _setGmailTransportFactoryForTests, _resetGmailTransportForTests, DEFAULT_ORDERS_COPY_EMAIL,
};
