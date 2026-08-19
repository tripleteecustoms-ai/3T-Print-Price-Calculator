// server/idGen.js
// Human-readable quote codes: 3T-YYMMDD-#### (never expose the raw DB id).
const db = require('./db');

function generateQuoteCode() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePart = `${yy}${mm}${dd}`;

  for (let attempt = 0; attempt < 25; attempt++) {
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const code = `3T-${datePart}-${suffix}`;
    const exists = db.prepare('SELECT id FROM quotes WHERE quote_code = ?').get(code);
    if (!exists) return code;
  }
  // astronomically unlikely fallback
  return `3T-${datePart}-${Date.now() % 100000}`;
}

module.exports = { generateQuoteCode };
