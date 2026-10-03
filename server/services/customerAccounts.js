// server/services/customerAccounts.js
//
// Optional customer logins. An account is a password on top of an existing
// customer record (matched by email), so orders placed as a guest with the
// same email show up once the account is verified. Ordering never needs one.
//
//  - Passwords are stored only as bcrypt hashes; nobody, admin included, can read one.
//  - A new account cannot log in until its email is verified, which is what
//    stops someone from signing up with another person's address to see
//    that person's orders.
//  - Verification and reset links carry a random token; only its SHA-256
//    hash is stored.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const emailService = require('./emailService');

const VERIFY_HOURS = 48;
const RESET_HOURS = 2;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

const DUMMY_HASH = bcrypt.hashSync('no-such-account', 10);

class AccountError extends Error {}

const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const normalizeEmail = (v) => text(v, 200).toLowerCase();
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
function newToken() { const token = crypto.randomBytes(32).toString('hex'); return { token, hash: hashToken(token) }; }
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new AccountError('Choose a password with at least 8 characters.');
  if (password.length > 200) throw new AccountError('That password is too long.');
}

function accountById(id) { return db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(id); }
function accountByEmail(email) { return db.prepare('SELECT * FROM customer_accounts WHERE email = ?').get(normalizeEmail(email)); }

// ------------------------------------------------------------------ emails
function shell(heading, bodyHtml) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <div style="background:#000;color:#CCFF00;padding:24px 28px;font-weight:800;font-size:20px;">3T PRINT SOLUTIONS</div>
    <div style="padding:28px;border:1px solid #E5E5E5;border-top:none;background:#fff;">
      <h2 style="margin-top:0;">${heading}</h2>
      ${bodyHtml}
      <p style="font-size:12px;color:#777;margin-top:24px;">If you did not ask for this, you can ignore this email.</p>
    </div>
  </div>`;
}
const button = (url, label) => `<a href="${url}" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin:16px 0;">${label}</a>`;
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendVerification(account, baseUrl, toEmail) {
  const { token, hash } = newToken();
  db.prepare('UPDATE customer_accounts SET verify_token_hash = ?, verify_expires = ? WHERE id = ?').run(hash, hoursFromNow(VERIFY_HOURS), account.id);
  const customer = db.prepare('SELECT first_name FROM customers WHERE id = ?').get(account.customer_id);
  const url = `${baseUrl}/verify-email?token=${token}`;
  return emailService.send({
    to: toEmail || account.email, subject: 'Verify your email for 3T Print Solutions',
    html: shell('Verify your email', `<p>Hi ${escHtml(customer && customer.first_name)}, confirm this email address to finish setting up your account.</p>${button(url, 'VERIFY MY EMAIL')}<p style="font-size:13px;color:#555;">This link works for ${VERIFY_HOURS} hours.</p>`),
  });
}
async function sendReset(account, baseUrl) {
  const { token, hash } = newToken();
  db.prepare('UPDATE customer_accounts SET reset_token_hash = ?, reset_expires = ? WHERE id = ?').run(hash, hoursFromNow(RESET_HOURS), account.id);
  const customer = db.prepare('SELECT first_name FROM customers WHERE id = ?').get(account.customer_id);
  const url = `${baseUrl}/reset-password.html?token=${token}`;
  return emailService.send({
    to: account.email, subject: 'Reset your 3T Print Solutions password',
    html: shell('Reset your password', `<p>Hi ${escHtml(customer && customer.first_name)}, use the button below to choose a new password.</p>${button(url, 'CHOOSE A NEW PASSWORD')}<p style="font-size:13px;color:#555;">This link works for ${RESET_HOURS} hours and can be used once.</p>`),
  });
}

// ------------------------------------------------------------------ sign up, verify, log in
/** Creates an unverified account and emails the verification link. */
async function register({ firstName, lastName, email, password }, baseUrl) {
  const first = text(firstName, 80), last = text(lastName, 80), mail = normalizeEmail(email);
  if (!first || !last) throw new AccountError('Enter your first and last name.');
  if (!EMAIL_RE.test(mail)) throw new AccountError('That email address does not look right.');
  checkPassword(password);

  const existing = accountByEmail(mail);
  if (existing) {
    // Never say whether an address already has an account. An unverified one gets a fresh link.
    if (!existing.email_verified_at) await sendVerification(existing, baseUrl);
    return { ok: true };
  }
  let customer = db.prepare('SELECT * FROM customers WHERE LOWER(email) = ? ORDER BY id LIMIT 1').get(mail);
  if (!customer) {
    const id = db.prepare('INSERT INTO customers (first_name,last_name,email,phone) VALUES (?,?,?,?)').run(first, last, mail, '').lastInsertRowid;
    customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  }
  const accountId = db.prepare('INSERT INTO customer_accounts (customer_id, email, password_hash, created_at) VALUES (?,?,?,?)')
    .run(customer.id, mail, bcrypt.hashSync(password, 10), new Date().toISOString()).lastInsertRowid;
  await sendVerification(accountById(accountId), baseUrl);
  return { ok: true };
}

/** Confirms an email from its link. Returns the account, or null for a bad or expired link. */
function verify(token) {
  const account = db.prepare('SELECT * FROM customer_accounts WHERE verify_token_hash = ?').get(hashToken(token || ''));
  if (!account || !account.verify_expires || new Date(account.verify_expires).getTime() < Date.now()) return null;
  const now = new Date().toISOString();
  if (account.pending_email) {
    // An email change: the new address replaces the old one on the account and the customer record.
    const taken = db.prepare('SELECT id FROM customer_accounts WHERE email = ? AND id != ?').get(account.pending_email, account.id);
    if (taken) return null;
    db.prepare('UPDATE customer_accounts SET email = ?, pending_email = NULL, email_verified_at = ?, verify_token_hash = NULL, verify_expires = NULL WHERE id = ?').run(account.pending_email, now, account.id);
    db.prepare('UPDATE customers SET email = ? WHERE id = ?').run(account.pending_email, account.customer_id);
  } else {
    db.prepare('UPDATE customer_accounts SET email_verified_at = COALESCE(email_verified_at, ?), verify_token_hash = NULL, verify_expires = NULL WHERE id = ?').run(now, account.id);
  }
  return accountById(account.id);
}

/** Returns the account for a correct email + password. Throws AccountError otherwise. */
function login(email, password) {
  const account = accountByEmail(email);
  // Compare against a dummy hash when there is no account, so timing does not reveal which emails exist.
  const hash = account ? account.password_hash : DUMMY_HASH;
  const ok = bcrypt.compareSync(String(password || ''), hash);
  if (!account || !ok) throw new AccountError('That email and password do not match.');
  if (account.disabled) throw new AccountError('This account is turned off. Contact us for help.');
  if (!account.email_verified_at) { const e = new AccountError('Verify your email first. Check your inbox for the link, or ask for a new one below.'); e.unverified = true; throw e; }
  db.prepare('UPDATE customer_accounts SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), account.id);
  return account;
}

/** Always resolves the same way, whether or not the address has an account. */
async function requestReset(email, baseUrl) {
  const account = accountByEmail(email);
  if (account && !account.disabled) await sendReset(account, baseUrl);
  return { ok: true };
}
async function resendVerification(email, baseUrl) {
  const account = accountByEmail(email);
  if (account && !account.email_verified_at) await sendVerification(account, baseUrl);
  return { ok: true };
}
function resetPassword(token, password) {
  checkPassword(password);
  const account = db.prepare('SELECT * FROM customer_accounts WHERE reset_token_hash = ?').get(hashToken(token || ''));
  if (!account || !account.reset_expires || new Date(account.reset_expires).getTime() < Date.now()) throw new AccountError('That reset link has expired. Ask for a new one.');
  // Using the emailed link also proves the address, so it counts as verification.
  db.prepare('UPDATE customer_accounts SET password_hash = ?, reset_token_hash = NULL, reset_expires = NULL, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), new Date().toISOString(), account.id);
  return accountById(account.id);
}
function changePassword(accountId, current, next) {
  const account = accountById(accountId);
  if (!account || !bcrypt.compareSync(String(current || ''), account.password_hash)) throw new AccountError('Your current password is not right.');
  checkPassword(next);
  db.prepare('UPDATE customer_accounts SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), account.id);
}

// ------------------------------------------------------------------ profile
function parseJson(raw, fallback) { try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; } }
function profileOf(account) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(account.customer_id);
  return {
    firstName: c.first_name, lastName: c.last_name, email: account.email, pendingEmail: account.pending_email || null,
    phone: c.phone || '', businessName: c.business_name || '', birthday: c.birthday || '', occupation: c.occupation || '', bio: c.bio || '',
    avatarUrl: c.avatar_url || '', address: parseJson(c.address_json, { line1: '', line2: '', city: '', state: '', zip: '' }),
    marketingOptOut: !!c.marketing_opt_out, memberSince: account.created_at,
  };
}
/** Saves the editable profile fields. A new email only takes effect after it is verified. */
async function updateProfile(accountId, input, baseUrl) {
  const account = accountById(accountId);
  if (!account) throw new AccountError('Log in again.');
  const first = text(input.firstName, 80), last = text(input.lastName, 80);
  if (!first || !last) throw new AccountError('Enter your first and last name.');
  const birthday = text(input.birthday, 10);
  if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) throw new AccountError('Enter your birthday as a date.');
  const a = (input.address && typeof input.address === 'object') ? input.address : {};
  const address = { line1: text(a.line1, 120), line2: text(a.line2, 120), city: text(a.city, 80), state: text(a.state, 40), zip: text(a.zip, 20) };
  db.prepare(`UPDATE customers SET first_name=?, last_name=?, phone=?, business_name=?, birthday=?, occupation=?, bio=?, address_json=?, marketing_opt_out=? WHERE id=?`)
    .run(first, last, text(input.phone, 40), text(input.businessName, 120) || null, birthday || null, text(input.occupation, 120) || null, text(input.bio, 1000) || null,
      JSON.stringify(address), input.marketingOptOut ? 1 : 0, account.customer_id);

  let emailChange = null;
  const mail = normalizeEmail(input.email);
  if (mail && mail !== account.email) {
    if (!EMAIL_RE.test(mail)) throw new AccountError('That email address does not look right.');
    if (accountByEmail(mail)) throw new AccountError('That email is already used by another account.');
    db.prepare('UPDATE customer_accounts SET pending_email = ? WHERE id = ?').run(mail, account.id);
    await sendVerification(accountById(account.id), baseUrl, mail);
    emailChange = mail;
  }
  return { profile: profileOf(accountById(account.id)), emailChange };
}
function setAvatar(accountId, url) {
  const account = accountById(accountId);
  db.prepare('UPDATE customers SET avatar_url = ? WHERE id = ?').run(url, account.customer_id);
}

// ------------------------------------------------------------------ dashboard
const OPEN_STATUSES = ['draft', 'quote_generated', 'quote_viewed', 'checkout_started', 'needs_review'];
const DONE_STATUSES = ['completed', 'cancelled', 'refunded'];
const STATUS_TEXT = {
  quote_generated: 'Quote ready', quote_viewed: 'Quote ready', checkout_started: 'Checkout started', needs_review: 'Being reviewed',
  deposit_paid: 'Deposit paid', paid: 'Paid', artwork_issue: 'Artwork needs attention', awaiting_customer: 'Waiting on you',
  approved: 'Approved', in_production: 'In production', ready_for_pickup: 'Ready for pickup', shipped: 'Shipped',
  completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded', draft: 'Draft',
};
function dashboard(accountId) {
  const account = accountById(accountId);
  const quotes = db.prepare('SELECT * FROM quotes WHERE customer_id = ? ORDER BY created_at DESC LIMIT 300').all(account.customer_id);
  const byId = new Map(quotes.map(q => [q.id, q]));
  const rows = quotes.map(q => {
    const snap = parseJson(q.pricing_snapshot, {});
    const source = q.reorder_source_quote_id ? db.prepare('SELECT quote_code FROM quotes WHERE id = ?').get(q.reorder_source_quote_id) : null;
    return {
      orderNumber: q.quote_code, createdAt: q.created_at, paidAt: q.paid_at, status: q.status, statusText: STATUS_TEXT[q.status] || q.status.replace(/_/g, ' '),
      item: (snap.garment && snap.garment.name) || 'Order', quantity: snap.totalQty || 0,
      total: q.grand_total != null ? q.grand_total : snap.total, balanceDue: q.paid_at ? Number(q.balance_due) || 0 : 0,
      reorderOf: source ? source.quote_code : null,
      canReorder: !!q.paid_at && !['cancelled', 'refunded'].includes(q.status),
    };
  });
  const isQuote = (r) => !r.paidAt && OPEN_STATUSES.includes(r.status);
  const files = quotes.length ? db.prepare(`SELECT * FROM artwork_files WHERE quote_id IN (${quotes.map(() => '?').join(',')}) ORDER BY id DESC`).all(...quotes.map(q => q.id)) : [];
  const fileRow = (f) => ({
    id: f.id, name: f.original_filename, label: f.location_name || 'Artwork', url: `/uploads/${f.stored_filename}`, isImage: /^image\//.test(f.mime_type || ''),
    status: f.status, orderNumber: byId.get(f.quote_id).quote_code, uploadedAt: f.uploaded_at,
    canReorder: !!byId.get(f.quote_id).paid_at && !['cancelled', 'refunded'].includes(byId.get(f.quote_id).status),
  });
  const isProof = (f) => /Approved Mockup$/.test(f.location_name || '');
  const artwork = files.filter(f => !isProof(f) && f.location_name !== 'Reference').map(fileRow);
  const sentMockups = quotes.length ? db.prepare(`SELECT * FROM mockups WHERE status = 'approved' AND quote_id IN (${quotes.map(() => '?').join(',')}) ORDER BY id DESC`).all(...quotes.map(q => q.id)) : [];
  return {
    profile: profileOf(account),
    currentOrders: rows.filter(r => r.paidAt && !DONE_STATUSES.includes(r.status)),
    pastOrders: rows.filter(r => r.paidAt && DONE_STATUSES.includes(r.status)),
    quotes: rows.filter(isQuote),
    artwork,
    // Saved designs: artwork the shop approved, with the order it was used on.
    designs: artwork.filter(f => ['approved', 'production_ready'].includes(f.status)),
    mockups: [
      ...files.filter(isProof).map(fileRow),
      ...sentMockups.map(m => ({ id: 'm' + m.id, name: m.original_filename, label: 'Approved Mockup', url: `/uploads/${m.stored_filename}`, isImage: true, status: 'approved', orderNumber: byId.get(m.quote_id).quote_code, uploadedAt: m.uploaded_at })),
    ],
  };
}

// ------------------------------------------------------------------ reorder
/**
 * Everything needed to place a past order again as a NEW order request: the
 * same selections, the customer's contact details, and a fresh draft token
 * holding copies of the original artwork records. The old order is untouched.
 */
function reorderPackage(accountId, orderNumber) {
  const account = accountById(accountId);
  const quote = db.prepare('SELECT * FROM quotes WHERE quote_code = ? AND customer_id = ?').get(String(orderNumber || ''), account.customer_id);
  if (!quote) throw new AccountError('That order was not found on your account.');
  if (!quote.paid_at || ['cancelled', 'refunded'].includes(quote.status)) throw new AccountError('Only orders that were placed can be reordered.');
  const snap = parseJson(quote.pricing_snapshot, {});
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(account.customer_id);

  // Copies of the artwork records (the files themselves are shared, not duplicated).
  const draftToken = crypto.randomUUID();
  const files = db.prepare("SELECT * FROM artwork_files WHERE quote_id = ? ORDER BY id").all(quote.id);
  const copy = db.prepare(`INSERT INTO artwork_files (quote_id, draft_token, print_location_id, location_name, original_filename, stored_filename, mime_type, size_bytes, status)
    VALUES (NULL,?,?,?,?,?,?,?,?)`);
  const copied = files.map(f => ({
    id: copy.run(draftToken, f.print_location_id, f.location_name, f.original_filename, f.stored_filename, f.mime_type, f.size_bytes,
      ['approved', 'production_ready'].includes(f.status) ? 'approved' : 'pending_review').lastInsertRowid,
    locationName: f.location_name, printLocationId: f.print_location_id, filename: f.original_filename, url: `/uploads/${f.stored_filename}`, sizeBytes: f.size_bytes, mimeType: f.mime_type,
  }));

  const items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ?').all(quote.id);
  const byColor = {};
  for (const it of items) {
    byColor[it.color_name] = byColor[it.color_name] || { colorName: it.color_name, colorHex: it.color_hex, sizes: [] };
    byColor[it.color_name].sizes.push({ label: it.size_label, qty: it.quantity });
  }
  const locations = db.prepare('SELECT print_location_id, design_size FROM quote_print_locations WHERE quote_id = ?').all(quote.id);
  const isPrint = !!snap.printSelection;
  return {
    orderNumber: quote.quote_code,
    kind: isPrint ? 'print' : 'apparel',
    family: isPrint ? snap.printSelection.family : null,
    summary: { item: (snap.garment && snap.garment.name) || 'Order', quantity: snap.totalQty || 0 },
    artwork: copied,
    // The body for POST /api/quotes. Prices are always worked out fresh by the server.
    payload: {
      reorderOf: quote.quote_code,
      draftToken,
      firstName: customer.first_name, lastName: customer.last_name, email: account.email, phone: customer.phone || '', businessName: customer.business_name || '',
      ...(isPrint
        ? { printSelection: snap.printSelection }
        : { garmentId: snap.garment && snap.garment.id, colorSelections: Object.values(byColor),
          printLocationIds: locations.map(l => ({ id: l.print_location_id, designSize: l.design_size || 'standard' })),
          decoration: snap.decoration ? snap.decoration.method : undefined,
          placements: parseJson(quote.placements_json, []),
          customGarmentDescription: quote.custom_garment_description || undefined, customerSuppliedGarment: !!quote.customer_supplied_garment }),
      fulfillmentMethod: quote.fulfillment_method, shippingAddress: parseJson(quote.shipping_address, undefined),
      orderPurpose: quote.event_name || undefined, designNotes: quote.design_notes || undefined,
      artworkPending: !copied.some(f => f.locationName !== 'Reference' && !/Approved Mockup$/.test(f.locationName || '')),
    },
  };
}

// ------------------------------------------------------------------ admin (User Access)
function adminList(search) {
  const q = text(search, 80).toLowerCase();
  const rows = db.prepare(`SELECT a.id, a.email, a.email_verified_at, a.created_at, a.last_login_at, a.pending_email, COALESCE(a.disabled,0) AS disabled,
      c.id AS customer_id, c.first_name, c.last_name, c.business_name
    FROM customer_accounts a JOIN customers c ON c.id = a.customer_id ORDER BY a.id DESC LIMIT 1000`).all();
  return rows.filter(r => !q || `${r.first_name} ${r.last_name} ${r.business_name || ''} ${r.email}`.toLowerCase().includes(q)).map(r => ({
    id: r.id, customerId: r.customer_id, name: `${r.first_name} ${r.last_name}`.trim(), businessName: r.business_name || '', email: r.email,
    verified: !!r.email_verified_at, pendingEmail: r.pending_email || null, createdAt: r.created_at, lastLoginAt: r.last_login_at, disabled: !!r.disabled,
  }));
}
/** What the admin customer profile shows about the login. Never includes the password hash. */
function adminSummary(customerId) {
  const a = db.prepare('SELECT * FROM customer_accounts WHERE customer_id = ?').get(customerId);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  const profile = c ? {
    birthday: c.birthday || '', occupation: c.occupation || '', bio: c.bio || '', avatarUrl: c.avatar_url || '',
    address: parseJson(c.address_json, null), marketingOptOut: !!c.marketing_opt_out,
  } : null;
  return {
    hasAccount: !!a, profile,
    ...(a ? { accountId: a.id, email: a.email, verified: !!a.email_verified_at, pendingEmail: a.pending_email || null, createdAt: a.created_at, lastLoginAt: a.last_login_at, disabled: !!a.disabled } : {}),
  };
}
/** Sends a reset or verification email to each selected account. Returns how many went out. */
async function adminSend(kind, accountIds, baseUrl) {
  let sent = 0;
  const skipped = [];
  for (const id of (Array.isArray(accountIds) ? accountIds : []).slice(0, 200)) {
    const account = accountById(Number(id));
    if (!account) continue;
    if (kind === 'verification' && account.email_verified_at && !account.pending_email) { skipped.push(account.email); continue; }
    if (kind === 'reset') await sendReset(account, baseUrl);
    else await sendVerification(account, baseUrl, account.pending_email || account.email);
    sent++;
  }
  return { sent, skipped };
}

module.exports = {
  AccountError, register, verify, login, requestReset, resendVerification, resetPassword, changePassword,
  accountById, profileOf, updateProfile, setAvatar, dashboard, reorderPackage, adminList, adminSummary, adminSend,
};
