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

const EMAIL_DIR = path.join(__dirname, '..', '..', 'data', 'emails');
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
        <tr><td style="padding:6px 0;color:#555;">Garment</td><td style="padding:6px 0;text-align:right;font-weight:600;">${snapshot.garment.name}</td></tr>
        <tr><td style="padding:6px 0;color:#555;">Quantity</td><td style="padding:6px 0;text-align:right;font-weight:600;">${snapshot.totalQty}</td></tr>
        <tr><td style="padding:10px 0;color:#555;border-top:1px solid #eee;font-size:18px;">Order Total</td><td style="padding:10px 0;text-align:right;font-weight:800;font-size:18px;border-top:1px solid #eee;">$${snapshot.total.toFixed(2)}</td></tr>
      </table>
      <a href="${quoteUrl}" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin-bottom:10px;">CONFIRM ORDER</a>
      <a href="${quoteUrl}" style="display:block;text-align:center;background:#fff;color:#000;border:1px solid #000;text-decoration:none;font-weight:700;padding:12px;border-radius:8px;margin-bottom:10px;">Edit Order</a>
      <a href="${quoteUrl}#review" style="display:block;text-align:center;color:#555;text-decoration:underline;font-size:13px;padding:8px;">Request a review before paying</a>
      <p style="font-size:12px;color:#777;margin-top:24px;">This quote is valid for ${getSetting('quote_expiration_days','7')} days. Questions? Just reply to this email.</p>
    </div>
  </div>`;
}

async function sendQuoteEmail(quote, customer, baseUrl) {
  const subject = `Your 3T Print Solutions Quote - #${quote.quote_code}`;
  const html = renderQuoteEmail(quote, customer, baseUrl);
  return send({ quoteId: quote.id, to: customer.email, subject, html });
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
        <tr><td style="padding:6px 0;color:#555;">Garment</td><td style="padding:6px 0;text-align:right;font-weight:600;">${snapshot.garment.name}</td></tr>
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
  const result = await send({ quoteId: quote.id, to: customer.email, subject, html });
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
  return send({ quoteId: quote.id, to: customer.email, subject, html });
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
        <tr><td style="padding:6px 0;color:#555;">Garment</td><td style="padding:6px 0;text-align:right;font-weight:600;">${snapshot.garment.name}</td></tr>
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
  return send({ quoteId: quote.id, to: customer.email, subject: copy.subject, html });
}

async function send({ quoteId, to, subject, html }) {
  const provider = getSetting('email_provider', 'mock');

  if (provider === 'mock') {
    db.prepare(`INSERT INTO emails_sent (quote_id, to_email, subject, body_html, provider) VALUES (?,?,?,?,'mock')`)
      .run(quoteId || null, to, subject, html);
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
      to, subject, html,
    });
    db.prepare(`INSERT INTO emails_sent (quote_id, to_email, subject, body_html, provider) VALUES (?,?,?,?,'gmail')`)
      .run(quoteId || null, to, subject, html);
    console.log(`[emailService:GMAIL] "${subject}" -> ${to}`);
    return { provider: 'gmail', delivered: true };
  }

  // Other real provider integration points (Postmark/SendGrid/SES/etc.) would go here.
  throw new Error(`Email provider "${provider}" is not yet implemented.`);
}

module.exports = {
  sendQuoteEmail, sendStatusUpdateEmail, sendReminderEmail,
  sendMockupApprovalEmail, sendMockupResponseNotification, send,
  _setGmailTransportFactoryForTests, _resetGmailTransportForTests,
};
