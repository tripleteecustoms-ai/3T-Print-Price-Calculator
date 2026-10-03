// public/admin/js/admin-analytics.js
// The Analytics page: a grid of report cards (sales, average order value,
// sessions, conversion, devices, landing pages, referrers, marketing channels,
// customer cohorts), each compared with the period just before it.
// Data comes from /api/admin/analytics/report; charts are drawn as plain SVG.
// Loaded after admin.js and uses its helpers (api, esc, money, showToast).

const AN_COLORS = ['#12acf0', '#6f3ff5', '#4f7cf7', '#00a47c', '#e8a317', '#d83a52', '#8a8a8a', '#303030'];
const anMoney = (n) => money(n);
const anShortMoney = (n) => n >= 1000 ? '$' + (Math.round(n / 100) / 10) + 'k' : '$' + Math.round(n);
const anPct = (n) => `${Math.round(n * 100) / 100}%`;

function anChange(change) {
  if (change == null) return '<span class="an-change flat" title="Nothing in the earlier period to compare with">–</span>';
  if (!change) return '<span class="an-change flat">–</span>';
  return `<span class="an-change ${change > 0 ? 'up' : 'down'}">${change > 0 ? '↗' : '↘'} ${Math.abs(change)}%</span>`;
}
function anCard(title, hint, head, body, cls = '') {
  return `<div class="an-card ${cls}"><div class="an-title" title="${esc(hint)}">${esc(title)}</div>${head ? `<div class="an-head">${head}</div>` : ''}<div class="an-body">${body}</div></div>`;
}
const anEmpty = (text = 'No data for this date range') => `<div class="an-empty">${esc(text)}</div>`;

// ---- line chart: this period (solid) over the period before (dotted) ----
function anLineChart(labels, current, prev, format) {
  const W = 600, H = 170, L = 40, R = 8, T = 8, B = 24;
  const max = Math.max(...current, ...prev, 0);
  if (!max) return anEmpty();
  // a round number at or above the highest point, so the axis reads cleanly
  const mag = Math.pow(10, Math.floor(Math.log10(max)));
  const top = [1, 2, 2.5, 4, 5, 10].map(m => m * mag).find(v => v >= max) || max;
  const x = (i) => L + (labels.length === 1 ? 0 : (i / (labels.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - v / top) * (H - T - B);
  // a smooth curve through the points that never dips below zero
  const path = (values) => {
    const pts = values.map((v, i) => [x(i), y(v)]);
    if (pts.length < 2) return `M${L},${pts[0][1]} L${W - R},${pts[0][1]}`;
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const mid = (x0 + x1) / 2;
      d += ` C${mid},${y0} ${mid},${y1} ${x1},${y1}`;
    }
    return d;
  };
  const ticks = [0, top / 2, top];
  const every = Math.max(1, Math.ceil(labels.length / 6));
  return `<svg class="an-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart">
    ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${esc(format(t))}</text>`).join('')}
    ${labels.map((label, i) => i % every === 0 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${esc(label)}</text>` : '').join('')}
    <path class="before" d="${path(prev)}"/>
    <path class="now" d="${path(current)}"/>
    ${current.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="9" fill="transparent"><title>${esc(labels[i])}: ${esc(format(v))} (before: ${esc(format(prev[i] || 0))})</title></circle>`).join('')}
  </svg>`;
}
function anLegend(r) {
  return `<div class="an-legend"><span><i style="background:var(--ad-accent)"></i>${esc(r.from === r.to ? r.from : `${r.from} – ${r.to}`)}</span>
    <span><i style="background:var(--ad-accent-soft)"></i>${esc(r.prevFrom === r.prevTo ? r.prevFrom : `${r.prevFrom} – ${r.prevTo}`)}</span></div>`;
}

// ---- donut ----
function anDonut(rows, format, centerText) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (!total) return anEmpty();
  const R = 62, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = rows.map((r, i) => {
    const len = (r.value / total) * C;
    const gap = rows.length > 1 ? 3 : 0;
    const arc = `<circle cx="85" cy="85" r="${R}" fill="none" stroke="${AN_COLORS[i % AN_COLORS.length]}" stroke-width="16"
      stroke-dasharray="${Math.max(0, len - gap)} ${C - Math.max(0, len - gap)}" stroke-dashoffset="${-offset}" transform="rotate(-90 85 85)"><title>${esc(r.name)}: ${esc(format(r.value))}</title></circle>`;
    offset += len;
    return arc;
  }).join('');
  return `<div class="an-donut">
    <svg viewBox="0 0 170 170" role="img" aria-label="Donut chart">${arcs}<text class="center" x="85" y="91" text-anchor="middle">${esc(centerText)}</text></svg>
    <div class="an-donut-legend">${rows.map((r, i) => `<div><i style="background:${AN_COLORS[i % AN_COLORS.length]}"></i><span>${esc(r.name)}</span><strong>${esc(format(r.value))}</strong>${anChange(r.change)}</div>`).join('')}</div>
  </div>`;
}

// ---- horizontal bars, each with the period before underneath ----
function anBars(rows, format) {
  if (!rows.length) return anEmpty();
  const max = Math.max(...rows.map(r => Math.max(r.value, r.prev || 0)), 1);
  return `<div class="an-bars">${rows.map(r => `<div>
      <div class="an-bar-name" title="${esc(r.name)}">${esc(r.name)}</div>
      <div class="an-bar-row"><div class="an-bar-track"><div class="an-bar" style="width:${(r.value / max) * 100}%"></div><div class="an-bar before" style="width:${((r.prev || 0) / max) * 100}%"></div></div>
        <div class="an-bar-num">${esc(format(r.value))} ${anChange(r.change)}</div></div>
    </div>`).join('')}</div>`;
}

// ---- funnel ----
function anFunnel(steps) {
  if (!steps[0].count) return anEmpty();
  return `<div class="an-funnel">${steps.map(s => `<div class="an-funnel-col">
      <div class="an-funnel-label" title="${esc(s.label)}">${esc(s.label)}</div>
      <div class="an-funnel-pct">${anPct(s.pct)}</div>
      <div class="an-funnel-count">${s.count} ${anChange(s.change)}</div>
      <div class="an-funnel-bar-wrap"><div class="an-funnel-bar" style="height:${Math.max(2, s.pct)}%"></div></div>
    </div>`).join('')}</div>`;
}

// ---- customer cohorts ----
function anCohorts(cohorts) {
  if (!cohorts.rows.some(r => r.customers)) return anEmpty('No paid orders yet');
  const cell = (pct) => `<td style="background:rgba(47,95,232,${pct ? 0.12 + Math.min(1, pct / 70) * 0.88 : 0.04});color:${pct > 35 ? '#fff' : '#303030'};">${Math.round(pct * 100) / 100}%</td>`;
  return `<div class="an-cohort-wrap"><table class="an-cohort">
    <thead><tr><th>First order</th><th style="text-align:right;">Customers</th><th colspan="${cohorts.months}" style="text-align:center;">Ordered again, months later</th></tr>
      <tr><th></th><th></th>${Array.from({ length: cohorts.months }, (_, i) => `<th style="text-align:center;">${i + 1}</th>`).join('')}</tr></thead>
    <tbody>${cohorts.rows.map(r => `<tr><td class="who">${esc(r.label)}</td><td class="n">${r.customers}</td>${r.cells.map(cell).join('')}${'<td style="background:none;"></td>'.repeat(Math.max(0, cohorts.months - r.cells.length))}</tr>`).join('')}</tbody>
  </table></div>`;
}

function loadAnalytics() {
  document.getElementById('analyticsRange').onchange = fetchAnalyticsReport;
  fetchAnalyticsReport();
}
async function fetchAnalyticsReport() {
  const grid = document.getElementById('analyticsGrid');
  let d;
  try { d = await api('/analytics/report?range=' + encodeURIComponent(document.getElementById('analyticsRange').value)); }
  catch (err) { grid.innerHTML = `<p class="muted">${esc(err.message || 'Could not load analytics.')}</p>`; return; }
  const r = d.range;
  document.getElementById('analyticsCompare').textContent = `${r.from === r.to ? r.from : `${r.from} – ${r.to}`}, compared with ${r.prevFrom === r.prevTo ? r.prevFrom : `${r.prevFrom} – ${r.prevTo}`}`;
  const count = (n) => String(Math.round(n * 100) / 100);
  const legend = anLegend(r);
  const line = (series, format) => anLineChart(d.labels, series.current, series.prev, format) + legend;

  grid.innerHTML = [
    anCard('Total sales by sales channel', 'Money received on paid orders, split by how the order came in.',
      '', anDonut(d.sales.byChannel, anMoney, anShortMoney(d.sales.total))),
    anCard('Average order value over time', 'Sales divided by the number of paid orders.',
      `<span class="an-value">${anMoney(d.averageOrder.value)}</span>${anChange(d.averageOrder.change)}`, line(d.averageOrder.series, anShortMoney)),
    anCard('Total sales by product', 'Money received on paid orders, by what was ordered.',
      '', anBars(d.sales.byProduct, anMoney)),

    anCard('Sessions over time', 'Visits to the ordering pages. A session is one visit by one browser.',
      `<span class="an-value">${d.sessions.total}</span>${anChange(d.sessions.change)}`, line(d.sessions.series, count)),
    anCard('Conversion rate over time', 'The share of sessions that ended in a paid order.',
      `<span class="an-value">${anPct(d.conversion.rate)}</span>${anChange(d.conversion.change)}`, line(d.conversion.series, anPct)),
    anCard('Conversion rate breakdown', 'How far sessions got: started an order, got a quote, reached checkout, paid.',
      `<span class="an-value">${anPct(d.conversion.rate)}</span>${anChange(d.conversion.change)}`, anFunnel(d.conversion.funnel)),

    anCard('Total sales over time', 'Money received on paid orders.',
      `<span class="an-value">${anMoney(d.sales.total)}</span>${anChange(d.sales.change)}<span class="muted" style="font-size:12.5px;">${d.sales.orders} order${d.sales.orders === 1 ? '' : 's'}</span>`, line(d.sales.series, anShortMoney)),
    anCard('Sessions by device type', 'Phone, tablet or computer. Recorded for visits from now on; earlier visits show as "Not recorded".',
      '', anDonut(d.devices, count, String(d.sessions.total))),
    anCard('Sessions by landing page', 'The first page a visit opened.',
      '', d.landingPages.length ? `<div class="an-list">${d.landingPages.map(p => `<div class="an-list-row"><span class="nm" title="${esc(p.name)}">${esc(p.name)}</span><span class="v">${p.value}</span>${anChange(p.change)}</div>`).join('')}</div>` : anEmpty()),

    anCard('Customer cohort analysis', 'Of the customers whose first paid order was in a month, the share who ordered again in each later month.',
      '', anCohorts(d.cohorts), 'wide'),
    anCard('Sessions by social referrer', 'Visits that came from a social network.',
      '', anBars(d.socialReferrers, count)),

    anCard('Sessions by referrer', 'Where visits came from: typed in directly, a search engine, a social network, another site, or a tagged campaign link.',
      '', anBars(d.referrers, count)),
    anCard('Total sales by referrer', 'Sales credited to the visit that made the quote.',
      '', anBars(d.salesByReferrer, anMoney)),
    anCard('Performance by marketing channel', 'Sessions, paid orders and sales for each source in this period.',
      '', d.channels.length ? `<table class="an-table"><thead><tr><th>Channel</th><th>Sessions</th><th>Orders</th><th>Sales</th></tr></thead><tbody>${d.channels.map(c =>
        `<tr><td>${esc(c.name)} <span class="muted">· ${esc(c.type)}</span></td><td>${c.sessions}</td><td>${c.orders}</td><td>${anMoney(c.sales)}</td></tr>`).join('')}</tbody></table>` : anEmpty()),
  ].join('');
}
