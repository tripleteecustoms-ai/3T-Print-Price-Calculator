// server/services/productionPacket.js
//
// Two different downloads for an order, built fresh every time:
//
//   Production PDF   the job packet: order details, every item and print slot,
//                    then the mockups, then PREVIEWS of the artwork. It is a
//                    reference sheet. It never replaces the print-ready files.
//   Files ZIP        the actual assets in their original formats, untouched:
//                    Production-PDF/, Mockups/, Print-Ready/, Customer-Uploads/.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const production = require('./productionAssets');

const PAGE = { w: 612, h: 792, margin: 40 };
const INK = rgb(0.07, 0.07, 0.07), SOFT = rgb(0.42, 0.42, 0.42), LINE = rgb(0.85, 0.85, 0.85), LIME = rgb(0.8, 1, 0), RED = rgb(0.75, 0.16, 0.05);

// The built-in PDF fonts only cover Latin-1, so anything else is swapped for a plain equivalent.
function clean(value) {
  return String(value == null ? '' : value)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/→/g, '->').replace(/…/g, '...').replace(/•/g, '-')
    .replace(/\r/g, '').replace(/[^\n\x20-\x7E\xA0-\xFF]/g, '?');
}
function shopTime(stamp) {
  if (!stamp) return '';
  const s = String(stamp);
  const d = new Date(/T/.test(s) ? s : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00Z' : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
    : d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function buildPdf(quote) {
  const t = await production.ticket(quote, { withPaths: true });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const generated = shopTime(new Date().toISOString());
  const title = `${t.orderNumber ? `Order ${t.orderNumber} · ` : ''}Quote ${t.quoteCode}`;
  doc.setTitle(clean(`Production sheet: ${title}`));
  doc.setSubject(clean(`Revision ${t.revision}, generated ${generated}`));

  let page, y;
  const width = PAGE.w - PAGE.margin * 2;
  const newPage = () => { page = doc.addPage([PAGE.w, PAGE.h]); y = PAGE.h - PAGE.margin; return page; };
  const need = (h) => { if (y - h < PAGE.margin + 24) newPage(); };
  const wrap = (text, f, size, max) => {
    const out = [];
    for (const para of clean(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const probe = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(probe, size) <= max || !line) line = probe;
        else { out.push(line); line = word; }
        // a single token longer than the line is cut, so it can never run off the page
        while (f.widthOfTextAtSize(line, size) > max && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && f.widthOfTextAtSize(line.slice(0, cut), size) > max) cut--;
          out.push(line.slice(0, cut)); line = line.slice(cut);
        }
      }
      out.push(line);
    }
    return out;
  };
  const text = (value, { x = PAGE.margin, size = 10, f = font, color = INK, max = width, gap = 3 } = {}) => {
    for (const line of wrap(value, f, size, max)) { need(size + gap); page.drawText(line, { x, y: y - size, size, font: f, color }); y -= size + gap; }
  };
  const rule = () => { need(10); page.drawLine({ start: { x: PAGE.margin, y: y - 4 }, end: { x: PAGE.w - PAGE.margin, y: y - 4 }, thickness: 0.7, color: LINE }); y -= 10; };
  const heading = (value) => { need(30); y -= 8; page.drawRectangle({ x: PAGE.margin, y: y - 18, width, height: 18, color: rgb(0.07, 0.07, 0.07) }); page.drawText(clean(value).toUpperCase(), { x: PAGE.margin + 8, y: y - 13, size: 9.5, font: bold, color: rgb(1, 1, 1) }); y -= 26; };
  // label / value pairs in two columns
  const fields = (pairs) => {
    const col = width / 2;
    for (let i = 0; i < pairs.length; i += 2) {
      const rows = [pairs[i], pairs[i + 1]].filter(Boolean).map(([label, value], k) => ({ label, lines: wrap(value || '-', bold, 10, col - 16), x: PAGE.margin + k * col }));
      const h = Math.max(...rows.map(r => 12 + r.lines.length * 13)) + 4;
      need(h);
      for (const r of rows) {
        page.drawText(clean(r.label).toUpperCase(), { x: r.x, y: y - 8, size: 7.5, font, color: SOFT });
        r.lines.forEach((line, n) => page.drawText(line, { x: r.x, y: y - 21 - n * 13, size: 10, font: bold, color: INK }));
      }
      y -= h;
    }
  };

  // ---------------------------------------------------------------- page 1: the job
  newPage();
  page.drawRectangle({ x: 0, y: PAGE.h - 74, width: PAGE.w, height: 74, color: rgb(0, 0, 0) });
  page.drawRectangle({ x: PAGE.margin, y: PAGE.h - 46, width: 9, height: 9, color: LIME });
  page.drawText('PRODUCTION SHEET', { x: PAGE.margin + 16, y: PAGE.h - 46, size: 15, font: bold, color: rgb(1, 1, 1) });
  page.drawText(clean(title), { x: PAGE.margin, y: PAGE.h - 63, size: 10, font, color: rgb(0.8, 0.8, 0.8) });
  const stamp = clean(`Revision ${t.revision} · generated ${generated}`);
  page.drawText(stamp, { x: PAGE.w - PAGE.margin - font.widthOfTextAtSize(stamp, 9), y: PAGE.h - 46, size: 9, font, color: LIME });
  const internal = 'Internal use. Print from the Print Ready files, not from this sheet.';
  page.drawText(internal, { x: PAGE.w - PAGE.margin - font.widthOfTextAtSize(internal, 8), y: PAGE.h - 63, size: 8, font, color: rgb(0.8, 0.8, 0.8) });
  y = PAGE.h - 90;

  fields([
    ['Order number', t.orderNumber || 'Not in Shopify yet'], ['Quote ID', t.quoteCode],
    ['Customer', t.customer.name + (t.customer.business ? ` (${t.customer.business})` : '')], ['Phone / email', [t.customer.phone, t.customer.email].filter(Boolean).join('  ·  ')],
    ['Order date', shopTime(t.orderDate)], ['Due date', t.dueDate ? shopTime(t.dueDate) : 'None given'],
    ['Pickup / shipping', t.fulfillment], ['Rush', t.rush ? 'YES - RUSH ORDER' : 'No'],
    ['Payment status', t.paymentStatus], ['Production status', t.production.label + (t.production.declinedArtwork ? `  (${t.production.declinedArtwork} artwork file${t.production.declinedArtwork === 1 ? '' : 's'} declined)` : '')],
  ]);
  const notes = [['Production notes', t.productionNotes], ['Customer notes', t.customerNotes], ['Design notes', t.designNotes], ['Order is for', t.orderPurpose], ['Reorder of', t.reorderOf ? `#${t.reorderOf}` : '']].filter(([, v]) => v);
  if (notes.length) {
    rule();
    for (const [label, value] of notes) { text(label.toUpperCase(), { size: 7.5, color: SOFT, gap: 2 }); text(value, { size: 10, gap: 3 }); y -= 4; }
  }

  // ---------------------------------------------------------------- every item and print slot
  t.items.forEach((item, i) => {
    heading(`Item ${i + 1} of ${t.items.length}: ${item.label}`);
    fields([
      ['Product / garment', item.product || item.label], ['Brand / style', item.brandStyle || '-'],
      ['Color', item.colors.length ? item.colors.join(', ') : '-'], ['Quantity', `${item.quantity} ${item.unit}${item.quantity === 1 ? '' : 's'}`],
      ['Size breakdown', item.sizeBreakdown || '-'], ['Print method', item.printMethod],
    ]);
    if (item.details.length) { text(item.details.join('  ·  '), { size: 9, color: SOFT }); y -= 2; }
    if (item.designBrief) { text('DESIGN BRIEF', { size: 7.5, color: SOFT, gap: 2 }); text(Object.entries(item.designBrief).map(([k, v]) => `${k}: ${v}`).join('\n'), { size: 9 }); }
    for (const slot of item.slots) {
      need(64);
      y -= 4;
      page.drawRectangle({ x: PAGE.margin, y: y - 15, width: 3, height: 15, color: rgb(0, 0, 0) });
      page.drawText(clean(slot.label).toUpperCase(), { x: PAGE.margin + 9, y: y - 11, size: 10.5, font: bold, color: INK });
      y -= 20;
      const row = (label, value, color = INK) => {
        const lines = wrap(value, font, 9.5, width - 130);
        need(lines.length * 12 + 2);
        page.drawText(label, { x: PAGE.margin + 9, y: y - 9, size: 8.5, font, color: SOFT });
        lines.forEach((line, n) => page.drawText(line, { x: PAGE.margin + 120, y: y - 9 - n * 12, size: 9.5, font, color }));
        y -= lines.length * 12 + 2;
      };
      row('Print dimensions', slot.dimensions || '-');
      row('Customer artwork', slot.customerArtwork.length ? slot.customerArtwork.map(f => `${f.name} (${f.status === 'declined' ? 'DECLINED' : String(f.status || '').replace(/_/g, ' ')})`).join(', ') : 'None uploaded');
      row('Print ready file', slot.printReady ? slot.printReady.name : 'NOT UPLOADED YET', slot.printReady ? INK : RED);
      row('Mockup', slot.mockups.length ? slot.mockups.map(m => m.name).join(', ') : 'None');
      if (slot.note) row('Production notes', slot.note);
      y -= 4;
    }
  });

  // ---------------------------------------------------------------- images
  // A PNG/JPG is embedded as is; an SVG or WEBP goes in as its PNG preview; a
  // PDF's first page is embedded as a page. Anything else gets a note saying
  // where the real file is.
  const drawable = async (ref, kind) => {
    if (!ref || !ref.path || !fs.existsSync(ref.path)) return null;
    if (ref.mime === 'application/pdf') {
      try { const [first] = await doc.embedPdf(fs.readFileSync(ref.path), [0]); return { embedded: first, w: first.width, h: first.height, isPage: true }; } catch (e) { return null; }
    }
    if (kind === 'sent') {
      const bytes = fs.readFileSync(ref.path);
      try { const img = ref.mime === 'image/png' ? await doc.embedPng(bytes) : ['image/jpeg', 'image/jpg'].includes(ref.mime) ? await doc.embedJpg(bytes) : null; if (img) return { embedded: img, w: img.width, h: img.height }; } catch (e) { /* fall through to no preview */ }
      return null;
    }
    const preview = await production.previewOf(kind, ref.id, ref.path, ref.mime);
    if (!preview) return null;
    const img = await doc.embedPng(fs.readFileSync(preview.path));
    return { embedded: img, w: img.width, h: img.height };
  };
  const imagePage = async (section, caption, lines, ref, kind) => {
    newPage();
    page.drawText(clean(section).toUpperCase(), { x: PAGE.margin, y: y - 9, size: 8.5, font: bold, color: SOFT });
    y -= 16;
    text(caption, { size: 14, f: bold, gap: 4 });
    for (const line of lines) text(line.text, { size: 9.5, color: line.color || SOFT, f: line.bold ? bold : font, gap: 3 });
    y -= 8;
    const boxH = y - PAGE.margin - 24;
    const d = await drawable(ref, kind);
    if (!d) {
      page.drawRectangle({ x: PAGE.margin, y: y - 120, width, height: 120, borderColor: LINE, borderWidth: 1 });
      page.drawText(clean(`No preview for this format. Open the file itself: ${ref ? ref.name : ''}`), { x: PAGE.margin + 14, y: y - 64, size: 10, font, color: SOFT });
      return;
    }
    const scale = Math.min(width / d.w, boxH / d.h, d.isPage ? 1 : 4);
    const w = d.w * scale, h = d.h * scale;
    // a light checker would be ideal for transparent art; a hairline frame keeps white-on-white artwork visible
    page.drawRectangle({ x: PAGE.margin + (width - w) / 2 - 1, y: y - h - 1, width: w + 2, height: h + 2, borderColor: LINE, borderWidth: 0.7, color: rgb(0.97, 0.97, 0.97) });
    if (d.isPage) page.drawPage(d.embedded, { x: PAGE.margin + (width - w) / 2, y: y - h, width: w, height: h });
    else page.drawImage(d.embedded, { x: PAGE.margin + (width - w) / 2, y: y - h, width: w, height: h });
  };

  for (const item of t.items) for (const slot of item.slots) for (const m of slot.mockups) {
    await imagePage('Mockup', slot.fullLabel, [{ text: `${m.sourceLabel || 'Mockup'} · ${m.name}` }, { text: `Print dimensions: ${slot.dimensions || '-'}` }], m, String(m.id).startsWith('sent-') ? 'sent' : (m.source ? 'asset' : 'artwork'));
  }
  for (const m of t.orderMockups) await imagePage('Mockup', 'Whole order', [{ text: `${m.sourceLabel} · ${m.name}` }, ...(m.customerNote ? [{ text: `Customer note: ${m.customerNote}` }] : [])], m, 'sent');

  for (const item of t.items) for (const slot of item.slots) {
    if (slot.printReady) {
      await imagePage('Print ready artwork (preview)', slot.fullLabel, [
        { text: `Master file: ${slot.printReady.name}`, color: INK, bold: true },
        { text: 'This is a preview. Print from the master file, which is kept separately in its original format.' },
        { text: `Print dimensions: ${slot.dimensions || '-'}` },
      ], slot.printReady, 'asset');
    }
    for (const f of slot.customerArtwork) {
      if (slot.printReady && slot.customerArtwork.length > 3) continue; // keep long orders readable once a print-ready file exists
      await imagePage(slot.printReady ? 'Customer artwork (original, for reference)' : 'Customer artwork (preview)', slot.fullLabel, [
        { text: `Customer file: ${f.name} · ${String(f.status || '').replace(/_/g, ' ')}`, color: INK, bold: true },
        ...(slot.printReady ? [] : [{ text: 'NO PRINT READY FILE HAS BEEN UPLOADED FOR THIS LOCATION YET.', color: RED, bold: true }]),
        { text: `Print dimensions: ${slot.dimensions || '-'}` },
      ], f, 'artwork');
    }
  }

  // ---------------------------------------------------------------- footer on every page
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const left = clean(`${title} · Revision ${t.revision} · generated ${generated}`);
    const right = `Page ${i + 1} of ${pages.length}`;
    p.drawLine({ start: { x: PAGE.margin, y: PAGE.margin + 10 }, end: { x: PAGE.w - PAGE.margin, y: PAGE.margin + 10 }, thickness: 0.5, color: LINE });
    p.drawText(left, { x: PAGE.margin, y: PAGE.margin - 2, size: 8, font, color: SOFT });
    p.drawText(right, { x: PAGE.w - PAGE.margin - font.widthOfTextAtSize(right, 8), y: PAGE.margin - 2, size: 8, font, color: SOFT });
  });

  return { filename: `${t.fileBase}_Production.pdf`, bytes: Buffer.from(await doc.save()), revision: t.revision, pages: pages.length, ticket: t };
}

// ------------------------------------------------------------------ ZIP (stored, not recompressed: images and PDFs are already compressed)
const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zip(entries) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12); entry.writeUInt16LE(date, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** Every production asset of the order in its ORIGINAL format, plus a freshly generated Production PDF. */
async function buildZip(quote) {
  const pdf = await buildPdf(quote);
  const t = pdf.ticket;
  const entries = [{ name: `Production-PDF/${pdf.filename}`, data: pdf.bytes }];
  const used = new Set();
  const add = (folder, base, ref) => {
    if (!ref || !ref.path || !fs.existsSync(ref.path)) return;
    const ext = path.extname(ref.name || ref.path) || path.extname(ref.path);
    let name = `${folder}/${base}${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${folder}/${base}-${n}${ext}`;
    used.add(name.toLowerCase());
    entries.push({ name, data: fs.readFileSync(ref.path) });
  };
  const multi = t.items.length > 1;
  t.items.forEach((item) => {
    const prefix = multi ? `${production.slug(item.label)}_` : '';
    for (const slot of item.slots) {
      const base = `${prefix}${production.slug(slot.label)}`;
      slot.mockups.forEach(m => add('Mockups', `${base}-Mockup`, m));
      add('Print-Ready', `${base}-Print-Ready`, slot.printReady);
      slot.customerArtwork.forEach(f => add('Customer-Uploads', `${base}-Original`, f));
    }
  });
  t.orderMockups.forEach(m => add('Mockups', 'Order-Mockup', m));
  t.references.forEach(f => add('Customer-Uploads', 'Reference', f));
  return { filename: `${t.fileBase}_Files.zip`, bytes: zip(entries), names: entries.map(e => e.name) };
}

module.exports = { buildPdf, buildZip };
