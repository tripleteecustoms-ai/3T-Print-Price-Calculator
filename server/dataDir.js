// server/dataDir.js
// Where everything the app writes at runtime lives: the SQLite file,
// uploaded artwork/mockups/garment images, and mock email copies.
//
// On Render the persistent disk is mounted at /data (outside the repo), so
// production sets DATA_DIR=/data. Without it, the app falls back to the
// repo's own data/ folder, which is fine locally but is wiped on every
// Render deploy.

const path = require('path');
const fs = require('fs');

const REPO_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : REPO_DATA_DIR;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = { DATA_DIR, REPO_DATA_DIR };
