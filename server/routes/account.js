// server/routes/account.js
// Customer accounts (optional: guests can always order without one).
// Mounted at /api/account. See server/services/customerAccounts.js.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const accounts = require('../services/customerAccounts');
const storage = require('../services/storageService');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const { AccountError } = accounts;

// Sign-in and email-sending endpoints are limited per device.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many attempts. Please wait a few minutes and try again.' });
const mailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: 'Too many requests. Please wait a few minutes and try again.' });

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(file.mimetype)),
});

const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
function requireCustomer(req, res, next) {
  const account = req.session && req.session.customerAccountId ? accounts.accountById(req.session.customerAccountId) : null;
  if (!account || account.disabled || !account.email_verified_at) return res.status(401).json({ error: 'Please log in.' });
  req.account = account;
  next();
}
// Turns the service's "this is the customer's mistake" errors into a 400 with the message.
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof AccountError) return res.status(400).json({ error: err.message, unverified: !!err.unverified });
    console.error('[account]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

router.post('/register', mailLimiter, handle(async (req, res) => {
  await accounts.register(req.body || {}, baseUrlOf(req));
  res.json({ ok: true, message: 'Check your email for a link to verify your address. You can log in once it is verified.' });
}));

router.post('/login', authLimiter, handle(async (req, res) => {
  const account = accounts.login((req.body || {}).email, (req.body || {}).password);
  req.session.customerAccountId = account.id;
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  // Only the customer login is cleared: an admin signed in on the same browser stays signed in.
  if (req.session) delete req.session.customerAccountId;
  res.json({ ok: true });
});

router.post('/resend-verification', mailLimiter, handle(async (req, res) => {
  await accounts.resendVerification((req.body || {}).email, baseUrlOf(req));
  res.json({ ok: true, message: 'If that address has an account waiting to be verified, a new link is on its way.' });
}));

router.post('/forgot-password', mailLimiter, handle(async (req, res) => {
  await accounts.requestReset((req.body || {}).email, baseUrlOf(req));
  res.json({ ok: true, message: 'If that address has an account, a reset link is on its way.' });
}));

router.post('/reset-password', authLimiter, handle(async (req, res) => {
  accounts.resetPassword((req.body || {}).token, (req.body || {}).password);
  res.json({ ok: true });
}));

// Who is logged in, for the header link and for filling in the order forms.
router.get('/me', (req, res) => {
  const account = req.session && req.session.customerAccountId ? accounts.accountById(req.session.customerAccountId) : null;
  if (!account || account.disabled || !account.email_verified_at) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, profile: accounts.profileOf(account) });
});

router.get('/dashboard', requireCustomer, handle(async (req, res) => {
  res.json(accounts.dashboard(req.account.id));
}));

router.put('/profile', requireCustomer, handle(async (req, res) => {
  res.json(await accounts.updateProfile(req.account.id, req.body || {}, baseUrlOf(req)));
}));

router.post('/profile/picture', requireCustomer, avatarUpload.single('image'), handle(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PNG, JPG or WEBP image under 5 MB.' });
  const storedFilename = storage.storedFilenameFor(req.file.originalname);
  fs.writeFileSync(path.join(storage.UPLOAD_DIR, storedFilename), req.file.buffer);
  const url = storage.fileUrl(storedFilename);
  accounts.setAvatar(req.account.id, url);
  res.json({ ok: true, avatarUrl: url });
}));

router.post('/change-password', requireCustomer, authLimiter, handle(async (req, res) => {
  accounts.changePassword(req.account.id, (req.body || {}).currentPassword, (req.body || {}).newPassword);
  res.json({ ok: true });
}));

// Everything needed to place a past order again as a new order request.
router.post('/orders/:code/reorder', requireCustomer, handle(async (req, res) => {
  res.json(accounts.reorderPackage(req.account.id, req.params.code));
}));

module.exports = router;
