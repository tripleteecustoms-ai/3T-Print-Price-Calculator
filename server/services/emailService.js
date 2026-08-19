// server/services/emailService.js
//
// Email abstraction. The mock provider (default) "sends" by logging the
// email to the database (visible in the admin under Quotes > Emails) and to
// the console, plus writing a .html copy to /data/emails for inspection.
// Swap in a real provider (Postmark, SendGrid, SES, SMTP...) by implementing
// sendViaRealProvider() and flipping the `email_provider` setting.

const fs = require('fs');
const path = require('path');
const db = require('./../db');
const { getSetting } = require('../pricingEngine');

const EMAIL_DIR = path.join(__dirname, '..', '..', 'data', 'emails');
if (!fs.existsSync(EMAIL_DIR)) fs.mkdirSync(EMAIL_DIR, { recursive: true });

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
      <a href="${quoteUrl}" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin-bottom:10px;">PAY &amp; PLACE ORDER</a>
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

  // Real provider integration point (SMTP/Postmark/SendGrid/etc.) goes here.
  throw new Error(`Email provider "${provider}" is not yet implemented.`);
}

module.exports = { sendQuoteEmail, send };
