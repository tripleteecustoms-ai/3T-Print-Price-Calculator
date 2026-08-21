// server/middleware/rateLimit.js
// Minimal in-memory rate limiter — no new npm dependency needed for the
// generous limits this app requires (a handful of sensitive POST routes:
// admin login, quote creation, artwork upload). Fixed-window counter keyed
// by client IP + route. NOT suitable for a multi-process/horizontally-scaled
// deployment (state lives in this process's memory only) — fine for this
// app's current single-instance setup; revisit if that ever changes.

const buckets = new Map(); // "ip:route" -> { count, windowStart }

function rateLimit({ windowMs, max, message }) {
  return function (req, res, next) {
    const key = `${req.ip}:${req.method}:${req.baseUrl || ''}${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((windowMs - (now - bucket.windowStart)) / 1000));
      return res.status(429).json({ error: message || 'Too many requests. Please try again in a few minutes.' });
    }
    next();
  };
}

module.exports = { rateLimit };
