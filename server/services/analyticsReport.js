// server/services/analyticsReport.js
//
// The numbers behind the admin Analytics page: sales, average order value,
// sessions, conversion, devices, landing pages, referrers, marketing
// channels and customer cohorts for a date range, each next to the same
// figure for the period just before it.
//
// Everything comes from this app's own data: the anonymous visit events the
// ordering pages record (analytics_events) and paid orders (quotes). A day is
// a day in the shop's time zone.

const db = require('../db');

const ZONE = 'America/New_York';
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ------------------------------------------------------------------ time
// SQLite's "2026-10-03 14:00:00" (UTC) and ISO strings both parse here.
function ms(stamp) {
  if (!stamp) return NaN;
  const s = String(stamp);
  return Date.parse(/T/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}
const zoneFormat = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric' });
function zoneParts(t) {
  const p = Object.fromEntries(zoneFormat.formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour };
}
/** The moment the shop's day containing `t` began. */
function startOfDay(t) {
  const p = zoneParts(t);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour) - Math.floor(t / HOUR) * HOUR; // zone time minus UTC, to the hour
  return Date.UTC(p.year, p.month - 1, p.day) - offset;
}

const RANGES = {
  today: { label: 'Today', days: 1, back: 0 },
  yesterday: { label: 'Yesterday', days: 1, back: 1 },
  7: { label: 'Last 7 days', days: 7, back: 0 },
  30: { label: 'Last 30 days', days: 30, back: 0 },
  90: { label: 'Last 90 days', days: 90, back: 0 },
  365: { label: 'Last 12 months', days: 365, back: 0 },
};
function resolveRange(key, now = Date.now()) {
  const r = RANGES[key] || RANGES[30];
  const end = startOfDay(now) + DAY - r.back * DAY;      // the end of the last day in the range
  const start = end - r.days * DAY;
  return {
    key: RANGES[key] ? String(key) : '30', label: r.label, start, end, prevStart: start - r.days * DAY, prevEnd: start,
    bucket: r.days === 1 ? 'hour' : r.days > 120 ? 'month' : 'day',
    days: r.days,
  };
}
const dayLabel = (t) => new Date(t).toLocaleDateString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric' });
function buckets(range) {
  if (range.bucket === 'hour') return Array.from({ length: 24 }, (_, h) => ({ label: `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` }));
  if (range.bucket === 'month') return Array.from({ length: 12 }, (_, i) => ({ label: new Date(range.start + (i + 0.5) * (range.end - range.start) / 12).toLocaleDateString('en-US', { timeZone: ZONE, month: 'short' }) }));
  return Array.from({ length: range.days }, (_, i) => ({ label: dayLabel(range.start + i * DAY + 12 * HOUR) }));
}
/** Which bucket of a period a moment falls in (the same position is used for the comparison period). */
function bucketIndex(t, periodStart, range) {
  const span = range.end - range.start;
  const count = range.bucket === 'hour' ? 24 : range.bucket === 'month' ? 12 : range.days;
  return Math.min(count - 1, Math.max(0, Math.floor((t - periodStart) / (span / count))));
}

// ------------------------------------------------------------------ where a visit came from
const SEARCH = ['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'brave'];
const SOCIAL = { facebook: 'facebook', 'fb.': 'facebook', instagram: 'instagram', tiktok: 'tiktok', 't.co': 'x', twitter: 'x', 'x.com': 'x', pinterest: 'pinterest', youtube: 'youtube', linkedin: 'linkedin', snapchat: 'snapchat', reddit: 'reddit' };
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
function classifySource(session, ownHosts) {
  const utm = String(session.utm || '').trim().toLowerCase();
  if (utm) {
    const social = Object.entries(SOCIAL).find(([needle]) => utm.includes(needle.replace('.', '')));
    return { type: social ? 'Social' : SEARCH.some(s => utm.includes(s)) ? 'Search' : 'Campaign', name: social ? social[1] : utm };
  }
  const host = hostOf(session.referrer);
  if (!host || ownHosts.has(host)) return { type: 'Direct', name: 'direct' };
  const social = Object.entries(SOCIAL).find(([needle]) => host.includes(needle));
  if (social) return { type: 'Social', name: social[1] };
  const search = SEARCH.find(s => host.includes(s));
  if (search) return { type: 'Search', name: search };
  return { type: 'Referral', name: host };
}
/** mobile | tablet | desktop from a browser's user-agent string. */
function deviceOf(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return null;
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

function pageName(path) {
  const p = String(path || '/').split('?')[0];
  if (p === '/' || p === '/start.html') return 'Start page · /';
  if (p === '/index.html') return 'Apparel order form · /index.html';
  if (p === '/print.html') return 'Print product order form · /print.html';
  if (p === '/quote.html') return 'Quote page · /quote.html';
  if (p === '/order-received.html') return 'Order received · /order-received.html';
  if (p === '/mockup-approval.html') return 'Mockup approval · /mockup-approval.html';
  if (p === '/login' || p === '/login.html') return 'Login · /login';
  if (p === '/account' || p === '/account.html') return 'Account · /account';
  return p;
}

// ------------------------------------------------------------------ helpers
function pctChange(now, before) {
  if (!before) return now ? null : 0; // nothing to compare against
  return Math.round(((now - before) / before) * 1000) / 10;
}
function top(map, limit = 8) {
  return [...map.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => (b.value - a.value) || a.name.localeCompare(b.name)).slice(0, limit);
}
function tally(map, key, current, amount = 1) {
  const row = map.get(key) || { value: 0, prev: 0 };
  if (current) row.value = round2(row.value + amount); else row.prev = round2(row.prev + amount);
  map.set(key, row);
}

// ------------------------------------------------------------------ the report
function report(rangeKey, opts = {}) {
  const now = opts.now || Date.now();
  const range = resolveRange(rangeKey, now);
  const iso = (t) => new Date(t).toISOString();
  const sqlStamp = (t) => iso(t).slice(0, 19).replace('T', ' ');
  const ownHosts = new Set([...(opts.ownHosts || []), 'localhost', '127.0.0.1'].map(h => String(h).replace(/^www\./, '').toLowerCase()));
  const inCurrent = (t) => t >= range.start && t < range.end;
  const inPrev = (t) => t >= range.prevStart && t < range.prevEnd;

  // ---- sessions: every visit that began in either period ----
  // (created_at is stored both as "YYYY-MM-DD HH:MM:SS" and as ISO, so both spellings of the cutoff are checked)
  const events = db.prepare(`SELECT visitor_id, session_id, event_type, path, referrer, utm_source, device, quote_code, created_at
    FROM analytics_events WHERE created_at >= ? OR created_at >= ? ORDER BY id`).all(sqlStamp(range.prevStart - DAY), iso(range.prevStart - DAY));
  const sessions = new Map();
  for (const e of events) {
    const t = ms(e.created_at);
    if (!(t >= range.prevStart && t < range.end)) continue;
    const key = e.session_id || e.visitor_id;
    let s = sessions.get(key);
    if (!s) { s = { startedAt: t, landing: e.path, referrer: e.referrer, utm: e.utm_source, device: e.device, types: new Set(), quotes: new Set() }; sessions.set(key, s); }
    s.types.add(e.event_type);
    if (!s.device && e.device) s.device = e.device;
    if (e.quote_code) s.quotes.add(e.quote_code);
  }

  // ---- paid orders in either period ----
  const orders = db.prepare(`SELECT q.id, q.quote_code, q.customer_id, q.paid_at, q.amount_paid, q.pricing_snapshot,
      EXISTS(SELECT 1 FROM quote_events ev WHERE ev.quote_id = q.id AND ev.event_type = 'generated' AND ev.detail LIKE 'Entered by %') AS shop_entered
    FROM quotes q WHERE q.paid_at IS NOT NULL AND q.status NOT IN ('cancelled') AND (q.paid_at >= ? OR q.paid_at >= ?)`).all(sqlStamp(range.prevStart - DAY), iso(range.prevStart - DAY))
    .map(o => ({ ...o, t: ms(o.paid_at), amount: Number(o.amount_paid) || 0 }))
    .filter(o => o.t >= range.prevStart && o.t < range.end);
  const paidCodes = new Set(db.prepare('SELECT quote_code FROM quotes WHERE paid_at IS NOT NULL').all().map(r => r.quote_code));
  const amountByCode = new Map(orders.map(o => [o.quote_code, o]));

  const slots = buckets(range);
  const series = () => ({ current: slots.map(() => 0), prev: slots.map(() => 0) });
  const salesSeries = series(), orderSeries = series(), sessionSeries = series(), convertedSeries = series();

  // ---- sales ----
  let sales = 0, salesPrev = 0, orderCount = 0, orderCountPrev = 0;
  const byChannel = new Map(), byProduct = new Map();
  for (const o of orders) {
    const current = inCurrent(o.t);
    let snap = {};
    try { snap = JSON.parse(o.pricing_snapshot); } catch (e) {}
    const product = snap.printOrder ? (snap.printOrder.familyName || snap.printOrder.productName) : (snap.garment && snap.garment.name) || 'Order';
    tally(byChannel, o.shop_entered ? 'Entered in admin' : 'Online order form', current, o.amount);
    tally(byProduct, product, current, o.amount);
    const i = bucketIndex(o.t, current ? range.start : range.prevStart, range);
    if (current) { sales += o.amount; orderCount++; salesSeries.current[i] += o.amount; orderSeries.current[i]++; }
    else { salesPrev += o.amount; orderCountPrev++; salesSeries.prev[i] += o.amount; orderSeries.prev[i]++; }
  }
  const aovSeries = {
    current: salesSeries.current.map((v, i) => orderSeries.current[i] ? round2(v / orderSeries.current[i]) : 0),
    prev: salesSeries.prev.map((v, i) => orderSeries.prev[i] ? round2(v / orderSeries.prev[i]) : 0),
  };

  // ---- sessions, funnel, and where they came from ----
  let sessionCount = 0, sessionCountPrev = 0;
  const funnel = { started: [0, 0], quoted: [0, 0], checkout: [0, 0], paid: [0, 0] };
  const devices = new Map(), landing = new Map(), referrers = new Map(), social = new Map(), salesByReferrer = new Map(), channels = new Map();
  for (const s of sessions.values()) {
    const current = inCurrent(s.startedAt);
    if (!current && !inPrev(s.startedAt)) continue;
    const which = current ? 0 : 1;
    const i = bucketIndex(s.startedAt, current ? range.start : range.prevStart, range);
    if (current) { sessionCount++; sessionSeries.current[i]++; } else { sessionCountPrev++; sessionSeries.prev[i]++; }
    const paid = [...s.quotes].some(code => paidCodes.has(code));
    if (s.types.has('step_view') || s.quotes.size) funnel.started[which]++;
    if (s.types.has('quote_generated') || s.quotes.size) funnel.quoted[which]++;
    if (s.types.has('checkout_started') || paid) funnel.checkout[which]++;
    if (paid) { funnel.paid[which]++; if (current) convertedSeries.current[i]++; else convertedSeries.prev[i]++; }

    const source = classifySource(s, ownHosts);
    const sourceName = `${source.type} · ${source.name}`;
    tally(devices, s.device ? s.device[0].toUpperCase() + s.device.slice(1) : 'Not recorded', current);
    tally(landing, pageName(s.landing), current);
    tally(referrers, sourceName, current);
    if (source.type === 'Social') tally(social, source.name, current);
    // sales and orders credited to the visit that made the quote
    const sessionSales = [...s.quotes].reduce((sum, code) => sum + ((amountByCode.get(code) || {}).amount || 0), 0);
    if (sessionSales > 0) tally(salesByReferrer, sourceName, current, sessionSales);
    const ch = channels.get(source.name) || { type: source.type, sessions: 0, orders: 0, sales: 0 };
    if (current) { ch.sessions++; if (paid) ch.orders++; ch.sales = round2(ch.sales + sessionSales); }
    channels.set(source.name, ch);
  }
  const rate = (paid, total) => total ? Math.round((paid / total) * 10000) / 100 : 0;
  const conversionSeries = {
    current: convertedSeries.current.map((v, i) => rate(v, sessionSeries.current[i])),
    prev: convertedSeries.prev.map((v, i) => rate(v, sessionSeries.prev[i])),
  };
  const step = (label, pair) => ({ label, count: pair[0], prev: pair[1], pct: rate(pair[0], sessionCount), change: pctChange(pair[0], pair[1]) });

  // ---- customer cohorts: of the customers whose first order was in a month, how many ordered again N months later ----
  const allPaid = db.prepare("SELECT customer_id, paid_at FROM quotes WHERE paid_at IS NOT NULL AND status NOT IN ('cancelled','refunded')").all();
  const monthIndex = (t) => { const p = zoneParts(t); return p.year * 12 + (p.month - 1); };
  const thisMonth = monthIndex(now);
  const first = new Map(), active = new Map(); // customer -> first month; customer -> set of months with an order
  for (const o of allPaid) {
    const m = monthIndex(ms(o.paid_at));
    if (!first.has(o.customer_id) || m < first.get(o.customer_id)) first.set(o.customer_id, m);
    if (!active.has(o.customer_id)) active.set(o.customer_id, new Set());
    active.get(o.customer_id).add(m);
  }
  const COHORT_MONTHS = 8;
  const cohorts = [];
  for (let m = thisMonth - COHORT_MONTHS + 1; m <= thisMonth; m++) {
    const members = [...first.entries()].filter(([, fm]) => fm === m).map(([id]) => id);
    cohorts.push({
      label: new Date(Date.UTC(Math.floor(m / 12), m % 12, 15)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      customers: members.length,
      // one cell per month after the first order; months that have not happened yet are left out
      cells: Array.from({ length: thisMonth - m }, (_, k) => members.length ? Math.round((members.filter(id => active.get(id).has(m + k + 1)).length / members.length) * 10000) / 100 : 0),
    });
  }

  const withChange = (list) => list.map(r => ({ ...r, change: pctChange(r.value, r.prev) }));
  return {
    range: { key: range.key, label: range.label, bucket: range.bucket, from: dayLabel(range.start + 12 * HOUR), to: dayLabel(range.end - 12 * HOUR), prevFrom: dayLabel(range.prevStart + 12 * HOUR), prevTo: dayLabel(range.prevEnd - 12 * HOUR) },
    labels: slots.map(s => s.label),
    sales: { total: round2(sales), prev: round2(salesPrev), change: pctChange(sales, salesPrev), orders: orderCount, ordersPrev: orderCountPrev,
      series: { current: salesSeries.current.map(round2), prev: salesSeries.prev.map(round2) }, byChannel: withChange(top(byChannel)), byProduct: withChange(top(byProduct)) },
    averageOrder: { value: orderCount ? round2(sales / orderCount) : 0, prev: orderCountPrev ? round2(salesPrev / orderCountPrev) : 0,
      change: pctChange(orderCount ? sales / orderCount : 0, orderCountPrev ? salesPrev / orderCountPrev : 0), series: aovSeries },
    sessions: { total: sessionCount, prev: sessionCountPrev, change: pctChange(sessionCount, sessionCountPrev), series: sessionSeries },
    conversion: { rate: rate(funnel.paid[0], sessionCount), prev: rate(funnel.paid[1], sessionCountPrev), change: pctChange(rate(funnel.paid[0], sessionCount), rate(funnel.paid[1], sessionCountPrev)), series: conversionSeries,
      funnel: [{ label: 'Sessions', count: sessionCount, prev: sessionCountPrev, pct: sessionCount ? 100 : 0, change: pctChange(sessionCount, sessionCountPrev) },
        step('Started an order', funnel.started), step('Got a quote', funnel.quoted), step('Reached checkout', funnel.checkout), step('Paid', funnel.paid)] },
    devices: withChange(top(devices)), landingPages: withChange(top(landing, 10)), referrers: withChange(top(referrers)), socialReferrers: withChange(top(social)),
    salesByReferrer: withChange(top(salesByReferrer)),
    channels: [...channels.entries()].map(([name, c]) => ({ name, ...c })).filter(c => c.sessions).sort((a, b) => b.sales - a.sales || b.sessions - a.sessions).slice(0, 8),
    cohorts: { months: COHORT_MONTHS - 1, rows: cohorts },
  };
}

module.exports = { report, deviceOf, RANGES };
