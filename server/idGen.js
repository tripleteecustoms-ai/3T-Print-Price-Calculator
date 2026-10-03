// server/idGen.js
// Customer-facing order numbers: 3T-##### (exactly five digits). The number
// is only a label: the database's own id stays the primary key, and orders
// made before this format keep the number they were given (3T-YYMMDD-####).
const crypto = require('crypto');
const db = require('./db');

function generateQuoteCode() {
  const taken = db.prepare('SELECT id FROM quotes WHERE quote_code = ?');
  // Picked at random (not counted up), so a number says nothing about how many orders there are.
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = `3T-${String(crypto.randomInt(1, 100000)).padStart(5, '0')}`;
    if (!taken.get(code)) return code;
  }
  // Random picks kept colliding (the range is nearly full): take the first free number.
  for (let n = 1; n < 100000; n++) {
    const code = `3T-${String(n).padStart(5, '0')}`;
    if (!taken.get(code)) return code;
  }
  throw new Error('All 3T-##### order numbers are in use.');
}

module.exports = { generateQuoteCode };
