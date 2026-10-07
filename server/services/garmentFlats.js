// server/services/garmentFlats.js
//
// Built-in garment flats: a clean front or back outline of a garment, filled
// with the chosen color. They stand in whenever a garment color has no
// supplier photo, so every garment and every color can be mocked up.
//
// A flat is addressed as /flats/<type>-<view>-<hex>.svg, for example
// /flats/tee-front-1e3a8a.svg. Every flat is drawn on the same 1000 x 1200
// canvas with the body in the same place, so the print area lands on the
// chest exactly as it does on a supplier photo.

const TYPES = ['tee', 'longsleeve', 'sweatshirt', 'hoodie', 'polo', 'hat', 'tote'];
const WIDTH = 1000, HEIGHT = 1200;
const FLAT_RE = /^\/flats\/([a-z]+)-(front|back)-([0-9a-f]{6})\.svg$/i;

function shade(hex, amount) {
  // amount < 0 darkens, > 0 lightens
  const n = parseInt(hex, 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)));
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(v => ch(v).toString(16).padStart(2, '0')).join('');
}
function luminance(hex) { const n = parseInt(hex, 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; }

/** The SVG for one flat. Unknown types fall back to a tee. */
function svg(type, view, hex) {
  const kind = TYPES.includes(type) ? type : 'tee';
  const back = view === 'back';
  const color = /^[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : 'd9d9d9';
  const fill = '#' + color;
  const light = luminance(color) > 0.55;
  const line = light ? shade(color, -0.32) : shade(color, 0.3);   // seams and edges that show on any color
  const soft = light ? shade(color, -0.1) : shade(color, 0.12);   // ribbing, inner collar
  const S = `stroke="${line}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"`;
  const seam = `fill="none" stroke="${line}" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 9"`;
  const parts = [];

  if (kind === 'hat') {
    parts.push(`<path d="M250 640 C250 400 380 300 500 300 C620 300 750 400 750 640 Z" fill="${fill}" ${S}/>`);
    if (!back) parts.push(`<path d="M250 640 C330 600 670 600 750 640 C780 700 720 760 500 760 C280 760 220 700 250 640 Z" fill="${soft}" ${S}/>`);
    else parts.push(`<path d="M400 640 C400 580 600 580 600 640" fill="${soft}" ${S}/><rect x="440" y="628" width="120" height="26" rx="6" fill="${line}"/>`);
    parts.push(`<path d="M500 300 L500 ${back ? 600 : 620}" ${seam}/><circle cx="500" cy="298" r="14" fill="${soft}" ${S}/>`);
  } else if (kind === 'tote') {
    parts.push(`<path d="M360 330 C360 120 640 120 640 330" fill="none" stroke="${line}" stroke-width="26" stroke-linecap="round"/>`);
    parts.push(`<path d="M360 330 C360 120 640 120 640 330" fill="none" stroke="${fill}" stroke-width="16" stroke-linecap="round"/>`);
    parts.push(`<rect x="230" y="320" width="540" height="640" rx="10" fill="${fill}" ${S}/><path d="M230 372 L770 372" ${seam}/>`);
  } else {
    const long = kind === 'longsleeve' || kind === 'sweatshirt' || kind === 'hoodie';
    const heavy = kind === 'sweatshirt' || kind === 'hoodie';
    // sleeves (drawn first, under the body)
    if (long) {
      parts.push(`<path d="M262 178 L150 250 L62 900 L150 922 L262 470 Z" fill="${fill}" ${S}/>`);
      parts.push(`<path d="M738 178 L850 250 L938 900 L850 922 L738 470 Z" fill="${fill}" ${S}/>`);
      if (heavy) parts.push(`<path d="M62 900 L150 922 L143 962 L55 940 Z" fill="${soft}" ${S}/><path d="M938 900 L850 922 L857 962 L945 940 Z" fill="${soft}" ${S}/>`);
    } else {
      parts.push(`<path d="M262 178 L96 300 L168 428 L262 372 Z" fill="${fill}" ${S}/>`);
      parts.push(`<path d="M738 178 L904 300 L832 428 L738 372 Z" fill="${fill}" ${S}/>`);
      parts.push(`<path d="M110 322 L182 446" ${seam}/><path d="M890 322 L818 446" ${seam}/>`);
    }
    // hood behind the shoulders
    if (kind === 'hoodie') parts.push(`<path d="M372 168 C340 40 660 40 628 168 C600 120 400 120 372 168 Z" fill="${back ? fill : soft}" ${S}/>`);
    // body
    const hem = heavy ? 1030 : 1070;
    parts.push(`<path d="M262 178 L390 140 C430 ${back ? 160 : 190} 570 ${back ? 160 : 190} 610 140 L738 178 L738 ${hem} L262 ${hem} Z" fill="${fill}" ${S}/>`);
    if (heavy) parts.push(`<path d="M262 ${hem} L738 ${hem} L730 ${hem + 44} L270 ${hem + 44} Z" fill="${soft}" ${S}/>`);
    else parts.push(`<path d="M262 ${hem - 26} L738 ${hem - 26}" ${seam}/>`);
    parts.push(`<path d="M262 178 L262 372" ${seam}/><path d="M738 178 L738 372" ${seam}/>`);
    // neckline
    if (back) {
      parts.push(`<path d="M390 140 C440 172 560 172 610 140 C560 152 440 152 390 140 Z" fill="${soft}" ${S}/>`);
    } else if (kind === 'polo') {
      parts.push(`<path d="M390 140 C430 196 570 196 610 140 L640 196 L548 250 L500 206 L452 250 L360 196 Z" fill="${soft}" ${S}/>`);
      parts.push(`<path d="M484 206 L484 330 L516 330 L516 206" fill="${soft}" ${S}/><circle cx="500" cy="262" r="5" fill="${line}"/><circle cx="500" cy="302" r="5" fill="${line}"/>`);
    } else if (kind === 'hoodie') {
      parts.push(`<path d="M390 140 C420 250 580 250 610 140 C570 200 430 200 390 140 Z" fill="${soft}" ${S}/>`);
      parts.push(`<path d="M452 214 L446 330" fill="none" ${S}/><path d="M548 214 L554 330" fill="none" ${S}/>`);
      parts.push(`<path d="M350 800 L650 800 L690 960 L310 960 Z" fill="${fill}" ${S}/>`);
    } else {
      parts.push(`<path d="M390 140 C430 212 570 212 610 140 C570 176 430 176 390 140 Z" fill="${soft}" ${S}/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="#f1f1f1"/>${parts.join('')}</svg>`;
}

/** The SVG for a /flats/... address, or null when the address is not a flat. */
function fromUrl(url) {
  const m = FLAT_RE.exec(String(url || ''));
  return m ? svg(m[1].toLowerCase(), m[2].toLowerCase(), m[3]) : null;
}
function handler(req, res) {
  const out = fromUrl(req.path.startsWith('/flats/') ? req.path : '/flats' + req.path);
  if (!out) return res.status(404).type('text/plain').send('Not found.');
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.send(out);
}

module.exports = { svg, fromUrl, handler, TYPES, WIDTH, HEIGHT, FLAT_RE };
