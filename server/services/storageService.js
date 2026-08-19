// server/services/storageService.js
//
// Local-disk file storage for uploaded artwork. Files are saved under
// /uploads with randomized names (never the customer's original filename)
// so URLs aren't guessable. Swap this module for an S3/GCS client later —
// callers only depend on saveFile()/fileUrl(), not the disk layout.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Nested under data/ (not a sibling top-level folder) so a single hosting
// disk/volume mounted at "data" covers both the SQLite file and uploaded
// artwork — see README > Deploying for why this matters.
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'application/pdf', 'image/svg+xml',
]);

function isAllowed(mimetype) {
  return ALLOWED_MIME.has(mimetype);
}

function storedFilenameFor(originalName) {
  const ext = path.extname(originalName || '').slice(0, 10);
  return `${crypto.randomUUID()}${ext}`;
}

function fileUrl(storedFilename) {
  return `/uploads/${storedFilename}`;
}

module.exports = { UPLOAD_DIR, ALLOWED_MIME, isAllowed, storedFilenameFor, fileUrl };
