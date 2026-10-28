// server/services/dailyDigest.js
//
// The daily orders summary: once a morning (Eastern time) the order alert
// inboxes get one email listing every open order by stage, what is late or
// due soon, new requests and payments from the last day, and balances
// still owed. It gives the shop (and the 3T OS agents reading that inbox) a
// full picture without opening the admin. Settings > Email turns it on/off
// and picks the hour. Checked hourly from server/index.js; sends at most
// once per Eastern calendar day.

const db = require('../db');
const { getSetting } = require('../pricingEngine');
const emailService = require('./emailService');

const TZ = 'America/New_York';
const STAGES = [
  ['To check and approve', ['paid', 'deposit_paid', 'needs_review'], true],
  ['Waiting on the customer', ['artwork_issue', 'awaiting_customer'], true],
  ['Approved, not started', ['approved'], true],
  ['In production', ['in_production'], true],
  ['Ready for pickup', ['ready_for_pickup'], true],
];

function easternParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(date).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

function money(n) { return `$${(Number(n) || 0).toFixed(2)}`; }
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Everything the summary reports, as plain data (also used by tests). */
function collect(now = new Date()) {
  const today = easternParts(now).day;
  const soon = easternParts(new Date(now.getTime() + 3 * 86400000)).day;
  const since = new Date(now.getTime() - 86400000).toISOString();
  const rows = db.prepare(`SELECT q.quote_code, q.status, q.needed_by_date, q.rush, q.artwork_pending, q.balance_due, q.amount_paid, q.paid_at, q.created_at,
      c.first_name, c.last_name, q.pricing_snapshot
    FROM quotes q JOIN customers c ON c.id = q.customer_id`).all().map(({ pricing_snapshot, ...q }) => {
      let snap = {};
      try { snap = JSON.parse(pricing_snapshot) || {}; } catch (e) { /* old row */ }
      return { ...q, qty: snap.totalQty, item: (snap.printOrder && snap.printOrder.productName) || (snap.garment && snap.garment.name) || '' };
    });
  const line = (q) => ({
    code: q.quote_code, name: `${q.first_name} ${q.last_name}`.trim(), qty: q.qty, item: q.item || '',
    neededBy: q.needed_by_date || null, rush: !!q.rush, noArtwork: !!q.artwork_pending, balance: q.paid_at ? Number(q.balance_due) || 0 : 0,
  });
  const byDue = (a, b) => (b.rush - a.rush) || String(a.neededBy || '9999').localeCompare(String(b.neededBy || '9999'));
  const open = rows.filter(q => q.paid_at && STAGES.some(([, s]) => s.includes(q.status)));
  return {
    today,
    stages: STAGES.map(([title, statuses]) => ({ title, orders: open.filter(q => statuses.includes(q.status)).map(line).sort(byDue) })),
    late: open.filter(q => q.needed_by_date && q.needed_by_date < today).map(line).sort(byDue),
    dueSoon: open.filter(q => q.needed_by_date && q.needed_by_date >= today && q.needed_by_date <= soon).map(line).sort(byDue),
    newRequests: rows.filter(q => !q.paid_at && q.created_at >= since && q.status !== 'draft').map(line),
    paidToday: rows.filter(q => q.paid_at && q.paid_at >= since).map(q => ({ ...line(q), amount: Number(q.amount_paid) || 0 })),
    balanceTotal: open.reduce((s, q) => s + (Number(q.balance_due) || 0), 0),
  };
}

function render(d, baseUrl) {
  const orderLink = (o) => `<a href="${baseUrl}/admin/dashboard.html#order=${encodeURIComponent(o.code)}" style="color:#000;font-weight:700;">#${esc(o.code)}</a>`;
  const item = (o, extra = '') => `<li style="margin:4px 0;">${orderLink(o)} ${esc(o.name)}: ${esc(o.qty)} × ${esc(o.item)}${o.rush ? ' <strong style="color:#c0392b;">RUSH</strong>' : ''}${o.neededBy ? `, needed by ${esc(o.neededBy)}` : ''}${o.noArtwork ? ', <strong>no artwork yet</strong>' : ''}${o.balance > 0.009 ? `, ${money(o.balance)} still due` : ''}${extra}</li>`;
  const block = (title, list, extra) => list.length ? `<h3 style="margin:18px 0 6px;font-size:16px;">${esc(title)} (${list.length})</h3><ul style="padding-left:18px;margin:0;">${list.map(o => item(o, extra ? extra(o) : '')).join('')}</ul>` : '';
  const openCount = d.stages.reduce((s, st) => s + st.orders.length, 0);
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;color:#111;">
    <div style="background:#000;color:#CCFF00;padding:20px 24px;font-weight:800;font-size:18px;">3T DAILY ORDERS SUMMARY</div>
    <div style="padding:20px 24px;border:1px solid #E5E5E5;border-top:none;">
      <p style="margin-top:0;"><strong>${openCount}</strong> open paid order${openCount === 1 ? '' : 's'}, <strong>${d.late.length}</strong> late, <strong>${d.dueSoon.length}</strong> due in the next 3 days. ${d.newRequests.length} new request${d.newRequests.length === 1 ? '' : 's'} and ${d.paidToday.length} payment${d.paidToday.length === 1 ? '' : 's'} in the last 24 hours.${d.balanceTotal > 0.009 ? ` Balances still owed on open orders: <strong>${money(d.balanceTotal)}</strong>.` : ''}</p>
      ${block('Late', d.late)}
      ${block('Due in the next 3 days', d.dueSoon)}
      ${block('Paid in the last 24 hours', d.paidToday, o => `, paid ${money(o.amount)}`)}
      ${block('New unpaid requests (last 24 hours)', d.newRequests)}
      ${d.stages.map(st => block(st.title, st.orders)).join('')}
      <a href="${baseUrl}/admin/dashboard.html#panel=production" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin-top:22px;">OPEN THE PRODUCTION BOARD</a>
    </div>
  </div>`;
}

/** Sends the summary now, to every order alert inbox. Returns what was sent. */
async function send(baseUrl, now = new Date()) {
  const d = collect(now);
  const openCount = d.stages.reduce((s, st) => s + st.orders.length, 0);
  const subject = `3T Daily Orders Summary - ${d.today}: ${openCount} open, ${d.late.length} late, ${d.paidToday.length} paid`;
  const html = render(d, baseUrl);
  const recipients = emailService.ownerRecipients();
  for (const to of recipients) await emailService.send({ to, subject, html });
  return { recipients, subject, openCount };
}

/** Called hourly: sends once a day at or after the chosen Eastern hour. */
async function maybeSend(baseUrl, now = new Date()) {
  if (String(getSetting('daily_digest_enabled', '1')) !== '1') return null;
  const { day, hour } = easternParts(now);
  const wantHour = Math.min(23, Math.max(0, Number(getSetting('daily_digest_hour', '7')) || 7));
  if (hour < wantHour || getSetting('daily_digest_last_sent', '') === day) return null;
  // mark first, so a slow or failing send never repeats all morning
  db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('daily_digest_last_sent',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(day, now.toISOString());
  return send(baseUrl, now);
}

module.exports = { collect, render, send, maybeSend, easternParts };
