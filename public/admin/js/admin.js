// public/admin/js/admin.js — 3T Print Solutions Admin Dashboard (SPA)

async function api(path, opts) {
  const resp = await fetch('/api/admin' + path, {
    method: opts?.method || 'GET',
    headers: opts?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    body: opts?.body instanceof FormData ? opts.body : (opts?.body ? JSON.stringify(opts.body) : undefined),
  });
  if (resp.status === 401) { window.location.href = '/admin/login.html'; throw new Error('Not authenticated'); }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data, status: resp.status });
  return data;
}

function money(n) { return '$' + Number(n || 0).toFixed(2); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
function showToast(msg) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  document.getElementById('toastHost').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const STATUS_OPTIONS = ['draft','quote_generated','quote_viewed','checkout_started','deposit_paid','paid','needs_review','artwork_issue','awaiting_customer','approved','in_production','ready_for_pickup','shipped','completed','cancelled','refunded'];
const MARGIN_BADGE = { STRONG: 'badge-green', ACCEPTABLE: 'badge-teal', CAUTION: 'badge-amber', LOW_MARGIN: 'badge-red' };
const STATUS_BADGE = (s) => {
  if (s === 'deposit_paid') return 'badge-teal';
  if (['paid','approved','completed'].includes(s)) return 'badge-green';
  if (['needs_review','artwork_issue','awaiting_customer'].includes(s)) return 'badge-amber';
  if (['cancelled','refunded'].includes(s)) return 'badge-red';
  if (['in_production','ready_for_pickup','shipped'].includes(s)) return 'badge-teal';
  return 'badge-gray';
};

// ------------------------------------------------------------------- nav
const PANEL_TITLES = { dashboard:'Dashboard', quotes:'Quotes', orders:'Paid Orders', productionreview:'Production Review', customers:'Customers', garments:'Garments', pricing:'Pricing', locations:'Print Locations', artwork:'Artwork', mockups:'Mockups', discounts:'Discounts', analytics:'Analytics', settings:'Settings' };
document.querySelectorAll('.admin-nav-item[data-panel]').forEach(item => {
  item.addEventListener('click', () => {
    switchPanel(item.dataset.panel);
    if (phoneNav.matches) setNavOpen(false); // on a phone, get the menu out of the way
  });
});
// Menu items are divs: make them reachable and usable from the keyboard too.
document.querySelectorAll('.admin-nav-item').forEach(item => {
  item.setAttribute('role', 'button');
  item.tabIndex = 0;
  item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); } });
});

// ---- collapsible menu ----
// Phones/tablets (<=900px): the menu slides over the page, closed by default.
// Computers: the menu button hides/shows the sidebar, and the choice is remembered.
const phoneNav = window.matchMedia('(max-width: 900px)');
function isNavOpen() {
  return phoneNav.matches ? document.body.classList.contains('nav-open') : !document.body.classList.contains('nav-collapsed');
}
function setNavOpen(open) {
  if (phoneNav.matches) {
    document.body.classList.toggle('nav-open', open);
    document.getElementById('navScrim').hidden = !open;
  } else {
    document.body.classList.toggle('nav-collapsed', !open);
    saveView('3t_admin_nav_collapsed', open ? '0' : '1');
  }
  document.getElementById('navToggle').setAttribute('aria-expanded', String(open));
}
function syncNavToScreen() {
  document.body.classList.remove('nav-open');
  document.getElementById('navScrim').hidden = true;
  document.body.classList.toggle('nav-collapsed', !phoneNav.matches && savedView('3t_admin_nav_collapsed', '0') === '1');
  document.getElementById('navToggle').setAttribute('aria-expanded', String(isNavOpen()));
}
document.getElementById('navToggle').addEventListener('click', () => setNavOpen(!isNavOpen()));
document.getElementById('navScrim').addEventListener('click', () => setNavOpen(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && phoneNav.matches && isNavOpen()) setNavOpen(false); });
phoneNav.addEventListener('change', syncNavToScreen);
syncNavToScreen();
function switchPanel(panel) {
  document.querySelectorAll('.admin-nav-item[data-panel]').forEach(i => i.classList.toggle('active', i.dataset.panel === panel));
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === panel));
  document.getElementById('panelTitle').textContent = PANEL_TITLES[panel];
  if (document.getElementById('editDrawer').classList.contains('open')) closeEditDrawer();
  const loader = { dashboard: loadDashboard, quotes: loadQuotes, orders: loadOrders, productionreview: loadProductionReview, customers: loadCustomers, garments: loadGarments, pricing: loadPricing, locations: loadLocations, artwork: loadArtwork, mockups: loadMockups, discounts: loadDiscounts, analytics: loadAnalytics, settings: loadSettings }[panel];
  if (loader) loader();
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  window.location.href = '/admin/login.html';
});

// ------------------------------------------------------------------- modal
function openModal(title, bodyHtml) {
  const host = document.getElementById('modalHost');
  host.innerHTML = `<div class="modal">
    <div class="modal-head"><h2>${title}</h2><button class="modal-close" id="modalCloseBtn">&times;</button></div>
    <div class="modal-body">${bodyHtml}</div>
  </div>`;
  host.classList.remove('hidden');
  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
  host.addEventListener('click', (e) => { if (e.target === host) closeModal(); });
}
function closeModal() { document.getElementById('modalHost').classList.add('hidden'); document.getElementById('modalHost').innerHTML = ''; }

// ---- artwork viewer: a separate layer above everything (including the
// quote detail modal), showing the file large with a Download button ----
const artworkById = new Map(); // filled wherever artwork is listed
function rememberArtwork(list) { for (const f of list || []) artworkById.set(Number(f.id), f); }
function openArtworkViewer(id) {
  const f = artworkById.get(Number(id));
  if (!f) return;
  const isPdf = f.mime_type === 'application/pdf' || /\.pdf$/i.test(f.original_filename || '');
  const host = document.getElementById('artViewer');
  host.innerHTML = `<div class="art-viewer-box" role="dialog" aria-modal="true" aria-label="Artwork: ${esc(f.original_filename)}">
    <div class="art-viewer-head">
      <div style="min-width:0;">
        <div style="font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.original_filename)}</div>
        <div class="muted" style="font-size:12px;">${[f.quote_code ? '#' + esc(f.quote_code) : '', f.first_name ? esc(`${f.first_name} ${f.last_name || ''}`) : '', esc(f.location_name || ''), f.size_bytes ? Math.round(f.size_bytes / 1024) + ' KB' : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <a class="btn btn-dark btn-sm" href="${esc(f.downloadUrl)}">Download</a>
        <button type="button" class="btn btn-outline btn-sm" id="artViewerClose" aria-label="Close viewer">Close ✕</button>
      </div>
    </div>
    <div class="art-viewer-stage">
      ${isPdf
        ? `<iframe src="${esc(f.url)}" title="${esc(f.original_filename)}"></iframe>`
        : `<img src="${esc(f.url)}" alt="${esc(f.original_filename)}" onerror="this.replaceWith(Object.assign(document.createElement('p'),{className:'muted',textContent:'This file is no longer on the server (removed by a deploy before storage was fixed). Ask the customer to re-send it.'}))">`}
    </div>
  </div>`;
  host.classList.remove('hidden');
  document.getElementById('artViewerClose').addEventListener('click', closeArtworkViewer);
  document.getElementById('artViewerClose').focus();
}
function closeArtworkViewer() {
  const host = document.getElementById('artViewer');
  host.classList.add('hidden'); host.innerHTML = '';
}
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-view-art]');
  if (opener) { e.preventDefault(); openArtworkViewer(opener.dataset.viewArt); return; }
  if (e.target.id === 'artViewer') closeArtworkViewer();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.getElementById('artViewer').classList.contains('hidden')) closeArtworkViewer(); });

// ==================================================================== DASHBOARD
async function loadDashboard() {
  const { stats, recentQuotes } = await api('/dashboard');
  document.getElementById('statGrid').innerHTML = `
    ${statTile('Total Quotes', stats.quotesTotal)}
    ${statTile('Open (Unpaid)', stats.quotesGeneratedNotPaid)}
    ${statTile('Paid Orders', stats.paidOrders)}
    ${statTile('Needs Review', stats.needsReview)}
    ${statTile('Revenue (30d)', money(stats.revenue30d))}
    ${statTile('Abandoned (7d)', stats.abandonedLast7d)}
  `;
  document.getElementById('recentQuotesBody').innerHTML = recentQuotes.map(q => `
    <tr class="clickable" data-open-quote="${q.quote_code}">
      <td><strong>${q.quote_code}</strong></td>
      <td>${esc(q.first_name)} ${esc(q.last_name)}</td>
      <td>${money(q.total)}</td>
      <td><span class="badge ${STATUS_BADGE(q.status)}">${q.status.replace(/_/g,' ')}</span></td>
      <td>${fmtDate(q.created_at)}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="muted">No quotes yet.</td></tr>`;
  bindQuoteRowClicks();
}
function statTile(label, value) {
  return `<div class="stat-tile"><div class="st-label">${label}</div><div class="st-value">${value}</div></div>`;
}
function bindQuoteRowClicks() {
  document.querySelectorAll('[data-open-quote]').forEach(row => {
    row.addEventListener('click', () => openQuoteDetail(row.dataset.openQuote));
  });
}

// ==================================================================== QUOTES
let quotesFilterInit = false;
async function loadQuotes() {
  if (!quotesFilterInit) {
    const sel = document.getElementById('quotesStatusFilter');
    STATUS_OPTIONS.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s.replace(/_/g,' '); sel.appendChild(o); });
    document.getElementById('quotesSearch').addEventListener('input', debounce(fetchQuotes, 300));
    sel.addEventListener('change', fetchQuotes);
    document.getElementById('quotesArtworkPendingFilter').addEventListener('change', fetchQuotes);
    quotesFilterInit = true;
  }
  fetchQuotes();
}
async function fetchQuotes() {
  const q = document.getElementById('quotesSearch').value;
  const status = document.getElementById('quotesStatusFilter').value;
  const artworkPending = document.getElementById('quotesArtworkPendingFilter').checked;
  const params = new URLSearchParams(); if (q) params.set('q', q); if (status) params.set('status', status); if (artworkPending) params.set('artworkPending', '1');
  const { quotes } = await api('/quotes?' + params.toString());
  document.getElementById('quotesBody').innerHTML = quotes.map(q => `
    <tr class="clickable" data-open-quote="${q.quoteCode}">
      <td><strong>${q.quoteCode}</strong></td>
      <td>${esc(q.customerName)}<div class="muted" style="font-size:11px;">${esc(q.email)}</div></td>
      <td>${q.totalQty ?? '—'}</td>
      <td>${money(q.total)}</td>
      <td>${q.marginStatus ? `<span class="badge ${MARGIN_BADGE[q.marginStatus]}">${q.marginStatus.replace('_',' ')}</span>` : '—'}</td>
      <td>${q.artworkPending ? `<span class="badge badge-amber">Pending</span>` : '—'}</td>
      <td><span class="badge ${STATUS_BADGE(q.status)}">${q.status.replace(/_/g,' ')}</span></td>
      <td>${fmtDate(q.createdAt)}</td>
    </tr>`).join('') || `<tr><td colspan="8" class="muted">No quotes match.</td></tr>`;
  bindQuoteRowClicks();
}

// ==================================================================== PRODUCTION REVIEW
// Phase 2: orders of 1,001+ pieces, superseding the old Bulk Requests tab.
// These are full quote records (needs_manual_review with review_reasons
// including "qty_over_1000") — clicking a row opens the same quote detail
// modal used everywhere else, with the full garment/size/artwork/override UI.
async function loadProductionReview() {
  const { requests } = await api('/production-review');
  const badge = document.getElementById('navReviewCount');
  const openCount = requests.filter(r => !['completed','cancelled','refunded'].includes(r.status)).length;
  badge.textContent = openCount; badge.classList.toggle('hidden', openCount === 0);

  document.getElementById('productionReviewBody').innerHTML = requests.map(r => `
    <tr class="clickable" data-open-quote="${r.quoteCode}">
      <td><strong>${r.quoteCode}</strong></td>
      <td>${esc(r.customerName)}<div class="muted" style="font-size:11px;">${esc(r.email)}</div></td>
      <td>${r.totalQty ?? '—'}</td>
      <td>${money(r.total)}</td>
      <td>${r.reviewReasons.includes('tight_deadline') ? '<span class="badge badge-red">Tight Deadline</span>' : '—'}</td>
      <td><span class="badge ${STATUS_BADGE(r.status)}">${r.status.replace(/_/g,' ')}</span></td>
      <td>${fmtDateTime(r.createdAt)}</td>
    </tr>`).join('') || `<tr><td colspan="7" class="muted">No production review requests yet.</td></tr>`;
  bindQuoteRowClicks();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function loadOrders() {
  const { orders } = await api('/orders');
  document.getElementById('ordersBody').innerHTML = orders.map(o => `
    <tr class="clickable" data-open-quote="${o.quoteCode}">
      <td><strong>${o.quoteCode}</strong></td>
      <td>${esc(o.customerName)}</td>
      <td>${money(o.total)}</td>
      <td><span class="badge ${STATUS_BADGE(o.status)}">${o.status.replace(/_/g,' ')}</span></td>
      <td>${fmtDateTime(o.paidAt)}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="muted">No paid orders yet.</td></tr>`;
  bindQuoteRowClicks();
}

// ---------------------------------------------------------- quote detail modal
async function openQuoteDetail(code) {
  const data = await api(`/quotes/${encodeURIComponent(code)}`);
  renderQuoteDetail(data);
}

function renderQuoteDetail(data) {
  const { quote, customer, items, printLocations, artwork, events, pricing, checkout } = data;
  rememberArtwork(artwork.map(f => ({ ...f, quote_code: quote.quote_code, first_name: customer.first_name, last_name: customer.last_name })));
  const marginBadge = pricing.internal ? `<span class="badge ${MARGIN_BADGE[pricing.internal.marginStatus]}">${pricing.internal.marginStatus.replace('_',' ')}</span>` : '';

  const colorGroups = {};
  for (const it of items) { colorGroups[it.color_name] = colorGroups[it.color_name] || []; colorGroups[it.color_name].push(it); }

  const body = `
    <div class="flex-between mt-8" style="margin-bottom:14px;">
      <span class="badge ${STATUS_BADGE(quote.status)}">${quote.status.replace(/_/g,' ')}</span>
      ${marginBadge}
    </div>

    <div class="detail-grid" style="margin-bottom:18px;">
      <div class="detail-item"><div class="dl">Customer</div><div class="dv"><a href="#" id="quoteCustomerLink" data-customer-id="${customer.id}" style="color:inherit;text-decoration:underline;" title="Open customer profile">${esc(customer.first_name)} ${esc(customer.last_name)}</a></div></div>
      <div class="detail-item"><div class="dl">Email / Phone</div><div class="dv" style="font-weight:600;">${esc(customer.email)} · ${esc(customer.phone)}</div></div>
      <div class="detail-item"><div class="dl">Garment</div><div class="dv">${esc(pricing.garment.name)}</div></div>
      <div class="detail-item"><div class="dl">Quantity</div><div class="dv">${pricing.totalQty}</div></div>
      <div class="detail-item"><div class="dl">Fulfillment</div><div class="dv">${quote.fulfillment_method}</div></div>
      <div class="detail-item"><div class="dl">Needed By</div><div class="dv">${fmtDate(quote.needed_by_date)}</div></div>
      ${quote.event_name ? `<div class="detail-item"><div class="dl">Order For</div><div class="dv">${esc(quote.event_name)}</div></div>` : ''}
      ${pricing.quantityTier ? `<div class="detail-item"><div class="dl">Quantity Tier</div><div class="dv">${esc(pricing.quantityTier.label)}${pricing.quantityTier.checkoutBehavior==='review'?' (Review)':''}</div></div>` : ''}
      ${quote.shipping_address ? `<div class="detail-item"><div class="dl">Shipping Address</div><div class="dv">${esc(quote.shipping_address.line1)}${quote.shipping_address.line2 ? ', '+esc(quote.shipping_address.line2) : ''}, ${esc(quote.shipping_address.city)}, ${esc(quote.shipping_address.state)} ${esc(quote.shipping_address.zip)}</div></div>` : ''}
    </div>

    <h3>Size Breakdown</h3>
    <div class="color-breakdown-list">
      ${Object.entries(colorGroups).map(([name, list]) => `
        <div class="color-breakdown-row" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--3t-border);">
          <span title="${esc(name)}" style="display:inline-block;width:22px;height:22px;border-radius:50%;border:1px solid #ddd;flex-shrink:0;background:${esc(list[0].color_hex || '#cccccc')};"></span>
          <div>
            <div style="font-weight:800;font-size:13px;">${esc(name)}</div>
            <div style="font-size:13px;color:var(--3t-ink-soft);">${list.map(i => `${i.size_label}${i.unit_surcharge>0?` (+${money(i.unit_surcharge)})`:''} × ${i.quantity}`).join(', ')}</div>
          </div>
        </div>
      `).join('')}
    </div>

    <h3 class="mt-16">Print Locations &amp; Artwork</h3>
    ${printLocations.map(loc => {
      const files = artwork.filter(a => a.location_name === loc.location_name);
      return `<div class="print-detail-row">
        ${files[0] ? `<button type="button" class="art-thumb-btn" style="width:auto;" data-view-art="${files[0].id}" title="View artwork">${files[0].mime_type === 'application/pdf' ? '<span class="thumb-40" style="display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-size:10px;font-weight:800;">PDF</span>' : `<img class="thumb-40" src="${files[0].url}" alt="" onerror="this.style.display='none'">`}</button>` : ''}
        <div style="flex:1;">
          <div class="pd-name">${esc(loc.location_name)} — ${loc.addon_price_each > 0 ? money(loc.addon_price_each)+'/shirt' : 'included'}${loc.design_size && loc.design_size !== 'standard' ? ` · <span style="text-transform:capitalize;">${loc.design_size === 'oversized' ? 'Oversized' : 'Large Graphic'}</span> (+${money(loc.design_size_surcharge_each)}/shirt)` : ''}</div>
          ${files.length ? files.map(f => `<div class="pd-file">
            <a href="${f.url}" data-view-art="${f.id}" style="color:inherit;text-decoration:underline;" title="View artwork">${esc(f.original_filename)}</a>
            · <a href="${f.downloadUrl}" style="text-decoration:underline;">Download</a>
            · <select data-artwork-status="${f.id}">${['pending_review','approved','needs_changes','customer_revision_requested','production_ready'].map(s=>`<option value="${s}" ${s===f.status?'selected':''}>${s.replace(/_/g,' ')}</option>`).join('')}</select>
          </div>`).join('') : `<div class="pd-file muted">No artwork uploaded</div>`}
        </div>
      </div>`;
    }).join('')}
    ${quote.design_notes ? `<div class="admin-card mt-8"><strong>Design Notes:</strong> ${esc(quote.design_notes)}</div>` : ''}
    ${quote.notes ? `<div class="admin-card mt-8"><strong>Customer Notes:</strong> ${esc(quote.notes)}</div>` : ''}

    <h3 class="mt-16">Pricing &amp; Margin (Internal)</h3>
    <div class="override-grid">
      <div class="override-tile"><div class="ot-label">Standard Price</div><div class="ot-value">${money(pricing.standardUnit)}</div></div>
      <div class="override-tile"><div class="ot-label">Hard Floor</div><div class="ot-value">${money(pricing.floorUnit)}</div></div>
      <div class="override-tile"><div class="ot-label">Current Price</div><div class="ot-value">${money(pricing.finalBaseUnit)}</div></div>
      <div class="override-tile"><div class="ot-label">Max Discount</div><div class="ot-value">${money(pricing.maxDiscount)}/ea</div></div>
    </div>
    <div class="detail-grid">
      <div class="detail-item"><div class="dl">Direct Cost / Shirt</div><div class="dv">${money(pricing.internal.directCostUnit)}</div></div>
      <div class="detail-item"><div class="dl">Total Direct Cost</div><div class="dv">${money(pricing.internal.directCostTotal)}</div></div>
      <div class="detail-item"><div class="dl">Gross Profit</div><div class="dv">${money(pricing.internal.grossProfitTotal)}</div></div>
      <div class="detail-item"><div class="dl">Gross Margin</div><div class="dv">${pricing.internal.grossMarginPct.toFixed(2)}%</div></div>
    </div>
    ${quote.floor_override ? `<div class="warn-box red"><strong>Below Floor Override Active</strong> — this quote is priced under the approved hard floor.</div>` : ''}
    ${pricing.internal?.belowMinimumMargin ? `<div class="warn-box red"><strong>Below Minimum Target Margin</strong> — this quote's ${pricing.internal.grossMarginPct.toFixed(1)}% margin is under the ${pricing.internal.minimumTargetMarginPct}% Settings &gt; Pricing target. Informational only — does not block the customer.</div>` : ''}
    ${pricing.isEstimatedPrice ? `<div class="warn-box">⚠ This quote's base price came from an unreviewed Phase 2 tier-pricing placeholder.</div>` : ''}
    ${quote.needs_manual_review ? `<div class="warn-box"><strong>Flagged for review:</strong> ${(quote.review_reasons||[]).map(r => r.replace(/_/g,' ')).join(', ')}</div>` : ''}
    ${quote.original_calculated_price != null ? `<div class="detail-grid mt-8">
      <div class="detail-item"><div class="dl">Original Calculated Price</div><div class="dv">${money(quote.original_calculated_price)}</div></div>
      <div class="detail-item"><div class="dl">Final Approved Price</div><div class="dv">${money(quote.final_approved_price)}</div></div>
    </div>` : ''}
    ${pricing.discount ? `<div class="detail-item mt-8"><div class="dl">Discount Applied</div><div class="dv">${esc(pricing.discount.code)} (-${money(pricing.discountAmount)})</div></div>` : ''}

    <h3 class="mt-16">Checkout &amp; Payment</h3>
    <div class="detail-grid">
      <div class="detail-item"><div class="dl">Order Total</div><div class="dv">${money(checkout.orderTotal)}</div></div>
      <div class="detail-item"><div class="dl">Rush Fee</div><div class="dv">${checkout.rush ? `${money(checkout.rushFee)} (${checkout.rushFeePct}%)` : 'No rush'}</div></div>
      <div class="detail-item"><div class="dl">Sales Tax (${checkout.taxRatePct}%)</div><div class="dv">${money(checkout.taxAmount)}</div></div>
      <div class="detail-item"><div class="dl">Grand Total</div><div class="dv"><strong>${money(checkout.grandTotal)}</strong></div></div>
      <div class="detail-item"><div class="dl">Payment</div><div class="dv">${checkout.paymentOption === 'deposit' ? `${checkout.depositPct}% deposit (${money(checkout.amountDueNow)})` : 'Paid in full'}</div></div>
      <div class="detail-item"><div class="dl">Amount Paid</div><div class="dv">${quote.amount_paid != null ? money(quote.amount_paid) : 'Not paid yet'}</div></div>
      ${checkout.paymentOption === 'deposit' ? `<div class="detail-item"><div class="dl">Balance Due</div><div class="dv"><strong>${money(checkout.balanceDue)}</strong></div></div>` : ''}
      <div class="detail-item"><div class="dl">Fulfillment</div><div class="dv">${quote.fulfillment_method === 'shipping'
        ? `Shipping${quote.shipping_address ? `: ${esc(quote.shipping_address.line1)}${quote.shipping_address.line2 ? ', ' + esc(quote.shipping_address.line2) : ''}, ${esc(quote.shipping_address.city)}, ${esc(quote.shipping_address.state)} ${esc(quote.shipping_address.zip)}` : ''}`
        : 'Local Pickup'}</div></div>
    </div>

    <div class="admin-card mt-16">
      <h3>Owner Price Override</h3>
      <div class="sub">Enter a new per-shirt base price. Amounts at or above the floor apply immediately. Below the floor requires confirmation.</div>
      <div class="field-row">
        <div class="field"><label>New Unit Price</label><input type="number" step="0.01" id="overrideUnitPrice" value="${pricing.finalBaseUnit.toFixed(2)}"></div>
        <div class="field"><label>Note (optional)</label><input type="text" id="overrideNote" placeholder="Reason for adjustment"></div>
      </div>
      <div id="overrideWarnHost"></div>
      <button class="btn btn-dark btn-sm" id="applyOverrideBtn" data-code="${quote.quote_code}">Apply Price</button>
    </div>

    <h3 class="mt-16">Order Status</h3>
    <div class="field-row">
      <div class="field">
        <select id="statusSelect">${STATUS_OPTIONS.map(s => `<option value="${s}" ${s===quote.status?'selected':''}>${s.replace(/_/g,' ')}</option>`).join('')}</select>
      </div>
      <button class="btn btn-outline btn-sm" id="applyStatusBtn" data-code="${quote.quote_code}" style="height:fit-content;">Update Status</button>
    </div>
    <div class="action-btn-row">
      <button class="btn btn-primary btn-sm" data-quick-status="approved" data-code="${quote.quote_code}">Approve for Production</button>
      <button class="btn btn-outline btn-sm" data-quick-status="awaiting_customer" data-code="${quote.quote_code}">Request Customer Change</button>
      <button class="btn btn-outline btn-sm" data-quick-status="refunded" data-code="${quote.quote_code}">Issue Refund</button>
      <button class="btn btn-danger btn-sm" data-quick-status="cancelled" data-code="${quote.quote_code}">Cancel Order</button>
      ${!quote.paid_at ? `<button class="btn btn-outline btn-sm" id="sendReminderBtn" data-code="${quote.quote_code}">Send Reminder</button>` : ''}
    </div>

    <h3 class="mt-16">History</h3>
    <div style="max-height:160px;overflow-y:auto;font-size:12.5px;">
      ${events.map(e => `<div style="padding:6px 0;border-top:1px solid var(--3t-border);"><strong>${e.event_type.replace(/_/g,' ')}</strong> — ${esc(e.detail||'')} <span class="muted">(${fmtDateTime(e.created_at)})</span></div>`).join('')}
    </div>
  `;
  openModal(`Quote ${quote.quote_code}`, body);

  document.getElementById('applyOverrideBtn').addEventListener('click', () => applyOverride(quote.quote_code, pricing.floorUnit));
  document.getElementById('applyStatusBtn').addEventListener('click', () => updateStatus(quote.quote_code, document.getElementById('statusSelect').value));
  document.querySelectorAll('[data-quick-status]').forEach(btn => btn.addEventListener('click', () => updateStatus(btn.dataset.code, btn.dataset.quickStatus)));
  document.querySelectorAll('[data-artwork-status]').forEach(sel => sel.addEventListener('change', () => updateArtworkStatus(quote.quote_code, sel.dataset.artworkStatus, sel.value)));
  const reminderBtn = document.getElementById('sendReminderBtn');
  if (reminderBtn) reminderBtn.addEventListener('click', () => sendReminder(reminderBtn));
  document.getElementById('quoteCustomerLink').addEventListener('click', (e) => { e.preventDefault(); openCustomerProfile(customer.id); });
}

async function sendReminder(btn) {
  const code = btn.dataset.code;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    await api(`/quotes/${code}/send-reminder`, { method: 'POST', body: {} });
    showToast('Reminder email sent.');
  } catch (err) {
    showToast(err.message || 'Could not send reminder.');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function applyOverride(code, floorUnit, confirmedBelowFloor) {
  const overrideUnitPrice = document.getElementById('overrideUnitPrice').value;
  const note = document.getElementById('overrideNote').value;
  try {
    await api(`/quotes/${code}/override`, { method: 'POST', body: { overrideUnitPrice, note, confirmedBelowFloor: !!confirmedBelowFloor } });
    showToast('Price updated.');
    openQuoteDetail(code);
  } catch (err) {
    if (err.data?.error === 'BELOW_FLOOR_CONFIRMATION_REQUIRED') {
      const warnHost = document.getElementById('overrideWarnHost');
      warnHost.innerHTML = `<div class="warn-box red"><strong>WARNING</strong> — This price (${money(err.data.requested)}) is below your approved floor (${money(err.data.floorUnit)}).</div>
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;margin:10px 0;">
          <input type="checkbox" id="confirmBelowFloor" style="margin-top:2px;">
          I understand this order is below the normal pricing floor.
        </label>`;
      document.getElementById('applyOverrideBtn').textContent = 'Confirm & Apply Below-Floor Price';
      document.getElementById('applyOverrideBtn').onclick = () => {
        if (!document.getElementById('confirmBelowFloor').checked) { showToast('Please check the confirmation box.'); return; }
        applyOverride(code, floorUnit, true);
      };
    } else {
      showToast(err.message || 'Could not apply override.');
    }
  }
}

async function updateStatus(code, status) {
  try { await api(`/quotes/${code}/status`, { method: 'PATCH', body: { status } }); showToast('Status updated.'); openQuoteDetail(code); loadDashboard(); }
  catch (err) { showToast(err.message); }
}
async function updateArtworkStatus(code, fileId, status) {
  try { await api(`/quotes/${code}/artwork-status`, { method: 'PATCH', body: { status, fileId } }); showToast('Artwork status updated.'); }
  catch (err) { showToast(err.message); }
}

// ==================================================================== CUSTOMERS
async function loadCustomers() {
  document.getElementById('customersSearch').oninput = debounce(fetchCustomers, 300);
  fetchCustomers();
}
async function fetchCustomers() {
  const q = document.getElementById('customersSearch').value;
  const { customers } = await api('/customers' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  document.getElementById('customersBody').innerHTML = customers.map(c => `
    <tr class="clickable" data-open-customer="${c.id}">
    <td><a href="#" class="customer-link" data-open-customer="${c.id}" style="font-weight:800;color:inherit;">${esc(c.first_name)} ${esc(c.last_name)}</a>${c.business_name ? `<div class="muted" style="font-size:11px;">${esc(c.business_name)}</div>`:''}</td>
    <td>${esc(c.email)}</td><td>${esc(c.phone)}</td><td>${c.quote_count}</td><td>${c.order_count}</td>
    <td>${c.last_order_at ? fmtDate(c.last_order_at) : '<span class="muted">Never</span>'}</td><td>${money(c.lifetime_value)}</td></tr>
  `).join('') || `<tr><td colspan="7" class="muted">No customers yet.</td></tr>`;
  document.querySelectorAll('#customersBody tr[data-open-customer]').forEach(row => row.addEventListener('click', (e) => {
    e.preventDefault();
    openCustomerProfile(Number(row.dataset.openCustomer));
  }));
}

// ---- customer profile ----
const CUSTOMER_STATUS_BADGE = { new: 'badge-gray', lead: 'badge-amber', active: 'badge-green', repeat: 'badge-teal', lapsed: 'badge-red' };
async function openCustomerProfile(id) {
  let data;
  try { data = await api(`/customers/${id}`); } catch (err) { showToast(err.message || 'Could not load this customer.'); return; }
  const { customer: c, status, stats: s, addresses, quotes } = data;
  const tile = (label, value) => `<div class="override-tile"><div class="ot-label">${label}</div><div class="ot-value">${value}</div></div>`;
  openModal(`${esc(c.firstName)} ${esc(c.lastName)}`, `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;">
      <span class="badge ${CUSTOMER_STATUS_BADGE[status.key] || 'badge-gray'}">${esc(status.label)}</span>
      ${s.balanceDue > 0 ? `<span class="badge badge-red">Balance due ${money(s.balanceDue)}</span>` : ''}
      ${s.openQuotes ? `<span class="badge badge-amber">${s.openQuotes} open quote${s.openQuotes === 1 ? '' : 's'}</span>` : ''}
    </div>
    <div class="detail-grid">
      ${c.businessName ? `<div class="detail-item"><div class="dl">Business</div><div class="dv">${esc(c.businessName)}</div></div>` : ''}
      <div class="detail-item"><div class="dl">Email</div><div class="dv"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div></div>
      <div class="detail-item"><div class="dl">Phone</div><div class="dv"><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></div></div>
      <div class="detail-item"><div class="dl">Customer Since</div><div class="dv">${fmtDate(s.firstSeenAt)}</div></div>
      <div class="detail-item"><div class="dl">Last Activity</div><div class="dv">${fmtDate(s.lastActivityAt)}</div></div>
      ${addresses.length ? `<div class="detail-item"><div class="dl">Ships To</div><div class="dv">${addresses.map(a => `${esc(a.line1)}${a.line2 ? ', ' + esc(a.line2) : ''}, ${esc(a.city)}, ${esc(a.state)} ${esc(a.zip)}`).join('<br>')}</div></div>` : ''}
    </div>
    <div class="override-grid mt-16">
      ${tile('Lifetime Value', money(s.lifetimeValue))}
      ${tile('Orders', s.orderCount)}
      ${tile('Average Order', s.orderCount ? money(s.averageOrder) : '—')}
      ${tile('Last Order', s.lastOrderAt ? `${fmtDate(s.lastOrderAt)}<div style="font-size:12px;font-weight:600;">${money(s.lastOrderValue)}</div>` : 'Never')}
      ${tile('Quotes', s.quoteCount)}
      ${tile('Quoted Total', money(s.totalQuoted))}
      ${tile('Quote to Order', s.quoteCount ? s.conversionPct + '%' : '—')}
      ${tile('Pieces Ordered', s.piecesOrdered.toLocaleString('en-US'))}
    </div>
    ${s.favoriteGarment ? `<div class="muted" style="font-size:13px;margin-bottom:12px;">Most ordered: <strong>${esc(s.favoriteGarment)}</strong></div>` : ''}
    <h3>Quotes &amp; Orders</h3>
    <div class="admin-table-wrap"><table class="admin-table" style="min-width:560px;"><thead><tr>
      <th>Quote</th><th>Date</th><th>Garment</th><th>Qty</th><th>Total</th><th>Paid</th><th>Status</th>
    </tr></thead><tbody>${quotes.map(q => `
      <tr class="clickable" data-profile-quote="${esc(q.quoteCode)}">
        <td><strong>${esc(q.quoteCode)}</strong>${q.rush ? ' <span class="badge badge-amber">Rush</span>' : ''}</td>
        <td>${fmtDate(q.createdAt)}</td><td>${esc(q.garment || '')}</td><td>${q.totalQty}</td>
        <td>${money(q.orderTotal)}</td>
        <td>${q.paidAt ? money(q.amountPaid) + (q.balanceDue > 0 ? `<div class="muted" style="font-size:11px;">${money(q.balanceDue)} due</div>` : '') : '—'}</td>
        <td><span class="badge ${STATUS_BADGE(q.status)}">${q.status.replace(/_/g, ' ')}</span></td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">No quotes yet.</td></tr>'}
    </tbody></table></div>`);
  document.querySelectorAll('[data-profile-quote]').forEach(row => row.addEventListener('click', async () => {
    await openQuoteDetail(row.dataset.profileQuote);
    // A way back to this customer from the quote they opened.
    const head = document.querySelector('#modalHost .modal-head');
    if (head) {
      const back = document.createElement('button');
      back.type = 'button'; back.className = 'btn btn-ghost btn-sm'; back.textContent = '← Back to customer';
      back.addEventListener('click', () => openCustomerProfile(id));
      head.insertBefore(back, head.firstChild);
    }
  }));
}

// ==================================================================== GARMENTS
// Garments show as compact tiles (or a list); clicking one opens its full
// editor (garmentCardHtml + bindGarmentCard, unchanged) in a side drawer,
// so the whole catalog fits on one screen instead of one giant card each.
let garmentsCache = [];
let editingGarmentId = null;
function savedView(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } }
function saveView(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* view choice is a convenience only */ } }
let garmentView = savedView('3t_admin_garment_view', 'tiles');

async function loadGarments() {
  const { garments } = await api('/garments');
  garmentsCache = garments;
  renderGarmentList();
  if (editingGarmentId != null) {
    const g = garments.find(x => x.id === editingGarmentId);
    if (g) openGarmentEditor(g, { keepScroll: true }); else closeEditDrawer();
  }
}
function garmentBadges(g) {
  return `${g.active ? '' : '<span class="badge badge-gray">Inactive</span>'}${g.ss_style_id ? `<span class="badge ${g.ss_sync_error ? 'badge-red' : 'badge-teal'}">S&amp;S${g.ss_sync_error ? ' error' : ''}</span>` : ''}${g.pricing_mode === 'margin_based' ? '<span class="badge badge-gray">Margin</span>' : ''}`;
}
// ---- Arrange mode: put garments in any order (also the customer order) ----
// Drag tiles on a computer, or use the arrow buttons (works on phones).
let arrangeMode = false;
let arrangeOrder = [];
function setArrangeMode(on) {
  arrangeMode = on;
  if (on) { closeEditDrawer(); arrangeOrder = garmentsCache.map(g => g.id); }
  const btn = document.getElementById('arrangeGarmentsBtn');
  btn.textContent = on ? 'Save Order' : 'Arrange';
  btn.classList.toggle('btn-dark', on); btn.classList.toggle('btn-outline', !on);
  btn.setAttribute('aria-pressed', String(on));
  document.getElementById('arrangeCancelBtn').classList.toggle('hidden', !on);
  renderGarmentList();
}
function moveInArrangeOrder(id, delta) {
  const i = arrangeOrder.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= arrangeOrder.length) return;
  [arrangeOrder[i], arrangeOrder[j]] = [arrangeOrder[j], arrangeOrder[i]];
}
function renderArrangeGrid(host) {
  const byId = new Map(garmentsCache.map(g => [g.id, g]));
  host.innerHTML = `<div class="warn-box" style="margin-top:0;">Drag the tiles (or use the arrows) into the order you want customers to see them, then click <strong>Save Order</strong>.</div>
    <div class="tile-grid" id="arrangeGrid">${arrangeOrder.map((id, i) => { const g = byId.get(id); return `
      <div class="g-tile arrange ${g.active ? '' : 'inactive'}" draggable="true" data-arrange-id="${id}">
        <span class="arrange-pos">${i + 1}</span>
        ${g.image_url ? `<img src="${esc(g.image_url)}" alt="">` : '<span class="g-tile-noimg"></span>'}
        <span style="min-width:0;flex:1;"><span class="g-tile-name" style="display:block;">${esc(g.name)}</span></span>
        <span class="arrange-btns">
          <button type="button" class="btn btn-outline btn-sm" data-arrange-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(g.name)} earlier">◀</button>
          <button type="button" class="btn btn-outline btn-sm" data-arrange-move="1" ${i === arrangeOrder.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(g.name)} later">▶</button>
        </span>
      </div>`; }).join('')}</div>`;
  host.querySelectorAll('[data-arrange-move]').forEach(b => b.addEventListener('click', () => {
    const id = Number(b.closest('[data-arrange-id]').dataset.arrangeId);
    const delta = Number(b.dataset.arrangeMove);
    moveInArrangeOrder(id, delta);
    renderArrangeGrid(host);
    const again = host.querySelector(`[data-arrange-id="${id}"] [data-arrange-move="${delta}"]`);
    (again && !again.disabled ? again : host.querySelector(`[data-arrange-id="${id}"] [data-arrange-move]:not([disabled])`))?.focus();
  }));
  let dragId = null;
  host.querySelectorAll('[data-arrange-id]').forEach(tile => {
    tile.addEventListener('dragstart', (e) => { dragId = Number(tile.dataset.arrangeId); tile.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
    tile.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    tile.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = Number(tile.dataset.arrangeId);
      if (dragId == null || dragId === targetId) return;
      arrangeOrder.splice(arrangeOrder.indexOf(dragId), 1);
      const r = tile.getBoundingClientRect();
      const after = (e.clientX - r.left) > r.width / 2;
      arrangeOrder.splice(arrangeOrder.indexOf(targetId) + (after ? 1 : 0), 0, dragId);
      renderArrangeGrid(host);
    });
  });
}
document.getElementById('arrangeGarmentsBtn').addEventListener('click', async () => {
  if (!arrangeMode) { setArrangeMode(true); return; }
  try {
    await api('/garments-reorder', { method: 'PUT', body: { order: arrangeOrder } });
    showToast('Garment order saved. Customers see this order too.');
    setArrangeMode(false);
    loadGarments();
  } catch (err) { showToast(err.message || 'Could not save the order.'); }
});
document.getElementById('arrangeCancelBtn').addEventListener('click', () => setArrangeMode(false));

function renderGarmentList() {
  const host = document.getElementById('garmentsList');
  if (arrangeMode) { renderArrangeGrid(host); return; }
  document.querySelectorAll('[data-panel="garments"] .view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === garmentView));
  const activeColors = (g) => g.colors.filter(c => c.active).length;
  const activeSizes = (g) => g.sizes.filter(s => s.active).length;
  if (garmentView === 'list') {
    host.innerHTML = `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>
      <th></th><th>Garment</th><th>Brand / Style</th><th>Colors</th><th>Sizes</th><th>Upcharge</th><th>Status</th><th></th>
    </tr></thead><tbody>${garmentsCache.map(g => `
      <tr data-open-garment="${g.id}" style="cursor:pointer;${g.active ? '' : 'opacity:.55;'}">
        <td>${g.image_url ? `<img src="${esc(g.image_url)}" alt="" style="width:32px;height:32px;object-fit:cover;border-radius:4px;">` : ''}</td>
        <td><strong>${esc(g.name)}</strong></td>
        <td>${esc(g.brand || '')} ${esc(g.style_number || '')}</td>
        <td>${activeColors(g)}</td><td>${activeSizes(g)}</td>
        <td>${g.customer_price_adjustment ? (g.customer_price_adjustment > 0 ? '+' : '') + money(g.customer_price_adjustment) : '—'}</td>
        <td>${garmentBadges(g) || '<span class="badge badge-green">Active</span>'}</td>
        <td><button type="button" class="btn btn-outline btn-sm">Edit</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  } else {
    host.innerHTML = `<div class="tile-grid">${garmentsCache.map(g => `
      <button type="button" class="g-tile ${g.active ? '' : 'inactive'} ${g.id === editingGarmentId ? 'editing' : ''}" data-open-garment="${g.id}">
        ${g.image_url ? `<img src="${esc(g.image_url)}" alt="">` : '<span class="g-tile-noimg"></span>'}
        <span style="min-width:0;">
          <span class="g-tile-name" style="display:block;">${esc(g.name)}</span>
          <span class="g-tile-sub" style="display:block;">${esc(g.brand || '')} ${esc(g.style_number || '')} · ${activeColors(g)} colors · ${activeSizes(g)} sizes</span>
          <span style="display:block;">${garmentBadges(g)}</span>
        </span>
      </button>`).join('')}</div>`;
  }
  host.querySelectorAll('[data-open-garment]').forEach(el => el.addEventListener('click', () => {
    const g = garmentsCache.find(x => x.id === Number(el.dataset.openGarment));
    if (g) openGarmentEditor(g);
  }));
}
function openGarmentEditor(g, opts = {}) {
  const body = document.getElementById('editDrawerBody');
  const scroll = opts.keepScroll ? body.scrollTop : 0;
  // Re-opening the same garment (after adding a color, saving, etc.) keeps
  // whichever collapsible sections were open.
  const openSections = opts.keepScroll ? [...body.querySelectorAll('details')].map(d => d.open) : [];
  editingGarmentId = g.id;
  document.getElementById('editDrawerTitle').textContent = g.name;
  body.innerHTML = garmentCardHtml(g);
  body.querySelectorAll('details').forEach((d, i) => { if (openSections[i]) d.open = true; });
  bindGarmentCard(g);
  openEditDrawer();
  body.scrollTop = scroll;
  document.querySelectorAll('.g-tile').forEach(t => t.classList.toggle('editing', Number(t.dataset.openGarment) === g.id));
}
function openEditDrawer() {
  const d = document.getElementById('editDrawer');
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false');
}
function closeEditDrawer() {
  const d = document.getElementById('editDrawer');
  d.classList.remove('open'); d.setAttribute('aria-hidden', 'true');
  editingGarmentId = null;
  document.querySelectorAll('.g-tile.editing').forEach(t => t.classList.remove('editing'));
}
document.getElementById('editDrawerClose').addEventListener('click', closeEditDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('editDrawer').classList.contains('open')) closeEditDrawer(); });
document.querySelectorAll('[data-panel="garments"] .view-toggle button').forEach(b => b.addEventListener('click', () => {
  garmentView = b.dataset.view; saveView('3t_admin_garment_view', garmentView); renderGarmentList();
}));
document.getElementById('ssImportToggle').addEventListener('click', (e) => {
  const card = document.getElementById('ssImportCard');
  const open = card.classList.toggle('hidden') === false;
  e.target.setAttribute('aria-expanded', String(open));
  if (open) document.getElementById('ssSearchInput').focus();
});
function garmentCardHtml(g) {
  return `<div class="admin-card" data-garment-id="${g.id}">
    <div class="field-row">
      <div class="field"><label>Name</label><input type="text" class="g-name" value="${esc(g.name)}"></div>
      <div class="field"><label>Brand</label><input type="text" class="g-brand" value="${esc(g.brand||'')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Style Number</label><input type="text" class="g-style" value="${esc(g.style_number||'')}"></div>
      <div class="field">
        <label>Garment Image</label>
        <div style="display:flex;align-items:center;gap:10px;">
          ${g.image_url ? `<img class="g-image-preview" src="${esc(g.image_url)}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--3t-border);">`
            : `<div class="g-image-preview" style="width:48px;height:48px;border-radius:6px;background:var(--3t-light-gray);display:flex;align-items:center;justify-content:center;font-size:10px;color:#999;">No image</div>`}
          <input type="file" class="g-image-file" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="display:none;">
          <button type="button" class="btn btn-outline btn-sm g-image-upload-btn">Upload Image</button>
          <input type="hidden" class="g-image-value" value="${esc(g.image_url||'')}">
        </div>
      </div>
    </div>
    <div class="field"><label>Description</label><textarea class="g-desc">${esc(g.description||'')}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Internal Cost (0 = use global blank cost)</label><input type="number" step="0.01" class="g-cost" value="${g.internal_cost}"></div>
      <div class="field"><label>Upcharge over the tee (set by S&amp;S sync; tier prices live on the Pricing tab)</label><input type="number" step="0.01" class="g-adj" value="${g.customer_price_adjustment}" disabled></div>
    </div>
    <label style="font-size:13px;font-weight:700;"><input type="checkbox" class="g-active" ${g.active ? 'checked' : ''}> Active</label>

    <h3 class="mt-16">S&amp;S Activewear</h3>
    ${g.ss_style_id ? `
      <div class="sub">Linked to <strong>${esc(g.ss_style_name || 'style ' + g.ss_style_id)}</strong>${g.ss_cost != null ? ` · your S&amp;S cost ${money(g.ss_cost)}` : ''} · last synced ${fmtDateTime(g.ss_last_sync)}</div>
      ${g.ss_sync_error ? `<div class="warn-box">Last sync failed: ${esc(g.ss_sync_error)}</div>` : ''}
      <label style="font-size:13px;display:block;margin:6px 0;"><input type="checkbox" class="g-ss-price-sync" ${g.ss_price_sync ? 'checked' : ''}> Update this garment's prices from S&amp;S on each sync</label>
      <div class="action-btn-row">
        <button type="button" class="btn btn-outline btn-sm g-ss-sync-btn">Sync Now</button>
        <button type="button" class="btn btn-ghost btn-sm g-ss-unlink-btn">Unlink</button>
      </div>` : `
      <div class="sub">Not linked. Enter the S&amp;S brand and style to pull cost, photos, colors, sizes and stock.</div>
      <div class="field-row" style="align-items:flex-end;">
        <div class="field mb-0"><input type="text" class="g-ss-style" value="${esc(`${g.brand || ''} ${g.style_number || ''}`.trim())}" placeholder="Gildan 5000"></div>
        <button type="button" class="btn btn-outline btn-sm g-ss-link-btn" style="height:fit-content;">Link to S&amp;S</button>
      </div>`}

    <details>
    <summary>Sourcing &amp; Inventory</summary>
    <div class="field-row mt-8">
      <div class="field"><label>Supplier</label><input type="text" class="g-supplier" value="${esc(g.supplier||'')}"></div>
      <div class="field"><label>Supplier SKU</label><input type="text" class="g-supplier-sku" value="${esc(g.supplier_sku||'')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Backup Supplier</label><input type="text" class="g-backup-supplier" value="${esc(g.backup_supplier||'')}"></div>
      <div class="field"><label>Backup Style Number</label><input type="text" class="g-backup-style" value="${esc(g.backup_style_number||'')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Last Cost Update</label><input type="date" class="g-last-cost-update" value="${g.last_cost_update ? String(g.last_cost_update).slice(0,10) : ''}"></div>
      <div class="field"><label>Inventory Status</label>
        <select class="g-inventory-status">
          ${['unknown','in_stock','low_stock','out_of_stock','discontinued'].map(s => `<option value="${s}" ${s===(g.inventory_status||'unknown')?'selected':''}>${s.replace(/_/g,' ')}</option>`).join('')}
        </select>
        <div class="muted" style="font-size:11px;margin-top:4px;">Data field only — real-time inventory checking is Phase 4.</div>
      </div>
    </div>
    <div class="field"><label>Weight (oz)</label><input type="number" step="0.1" class="g-weight" value="${g.weight_oz ?? ''}" style="max-width:140px;"></div>
    </details>

    <h3 class="mt-16">Pricing Mode</h3>
    <div class="field-row" style="align-items:center;">
      <div class="field"><label>Mode</label>
        <select class="g-pricing-mode">
          <option value="fixed_tier" ${g.pricing_mode!=='margin_based'?'selected':''}>Fixed Tier (set price per tier directly)</option>
          <option value="margin_based" ${g.pricing_mode==='margin_based'?'selected':''}>Margin-Based (computed from cost inputs)</option>
        </select>
      </div>
      <button type="button" class="btn btn-outline btn-sm manage-pricing-btn" style="height:fit-content;">Manage Tier Pricing →</button>
    </div>

    <details>
    <summary>Colors (${g.colors.filter(c => c.active).length} active of ${g.colors.length})</summary>
    <div class="color-editor-list">${g.colors.map(c => colorRowHtml(c)).join('')}</div>
    <button class="btn btn-outline btn-sm mt-8 add-color-btn">+ Add Color</button>
    </details>

    <details>
    <summary>Sizes &amp; Surcharges (${g.sizes.filter(s => s.active).length} active)</summary>
    <div class="size-editor-list">${g.sizes.map(s => sizeRowHtml(s)).join('')}</div>
    <button class="btn btn-outline btn-sm mt-8 add-size-btn">+ Add Size</button>
    </details>

    <div class="action-btn-row">
      <button class="btn btn-dark btn-sm save-garment-btn">Save Garment</button>
      <button class="btn btn-outline btn-sm deactivate-garment-btn">Deactivate</button>
      <button class="btn btn-danger btn-sm delete-garment-btn">Delete</button>
    </div>
  </div>`;
}
function colorRowHtml(c) {
  return `<div class="field-row color-row" data-color-id="${c.id}" style="align-items:center;">
    <div class="field mb-0"><input type="text" class="c-name" value="${esc(c.name)}" placeholder="Color name"></div>
    <div class="field mb-0" style="display:flex;gap:8px;align-items:center;">
      <input type="color" class="c-hex" value="${c.hex}" style="width:44px;height:38px;padding:2px;">
      <label style="font-size:11px;"><input type="checkbox" class="c-active" ${c.active?'checked':''}> Active</label>
      <button class="btn btn-ghost btn-sm save-color-btn">Save</button>
    </div>
  </div>`;
}
function sizeRowHtml(s) {
  return `<div class="field-row size-row-edit" data-size-id="${s.id}" style="align-items:center;">
    <div class="field mb-0"><input type="text" class="s-label" value="${esc(s.label)}" placeholder="Size label"></div>
    <div class="field mb-0" style="display:flex;gap:8px;align-items:center;">
      <input type="number" step="0.01" class="s-surcharge" value="${s.surcharge}" style="width:100px;">
      <label style="font-size:11px;"><input type="checkbox" class="s-active" ${s.active?'checked':''}> Active</label>
      <button class="btn btn-ghost btn-sm save-size-btn">Save</button>
    </div>
  </div>`;
}
function bindGarmentCard(g) {
  const card = document.querySelector(`[data-garment-id="${g.id}"]`);
  card.querySelector('.save-garment-btn').addEventListener('click', async () => {
    await api(`/garments/${g.id}`, { method: 'PUT', body: {
      name: card.querySelector('.g-name').value, brand: card.querySelector('.g-brand').value,
      styleNumber: card.querySelector('.g-style').value, imageUrl: card.querySelector('.g-image-value').value,
      description: card.querySelector('.g-desc').value, internalCost: card.querySelector('.g-cost').value,
      customerPriceAdjustment: card.querySelector('.g-adj').value, active: card.querySelector('.g-active').checked,
      supplier: card.querySelector('.g-supplier').value, supplierSku: card.querySelector('.g-supplier-sku').value,
      backupSupplier: card.querySelector('.g-backup-supplier').value, backupStyleNumber: card.querySelector('.g-backup-style').value,
      lastCostUpdate: card.querySelector('.g-last-cost-update').value || null, inventoryStatus: card.querySelector('.g-inventory-status').value,
      weightOz: card.querySelector('.g-weight').value, pricingMode: card.querySelector('.g-pricing-mode').value,
    }});
    showToast('Garment saved.');
    loadGarments(); // refresh the tile (name, photo, badges)
  });
  card.querySelector('.manage-pricing-btn').addEventListener('click', () => {
    pendingPricingGarmentId = g.id; // read + cleared by loadPricing() once its garment <select> is populated
    showPricingSubtab('garment');
    switchPanel('pricing');
  });
  card.querySelector('.g-image-upload-btn').addEventListener('click', () => {
    card.querySelector('.g-image-file').click();
  });
  card.querySelector('.g-image-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('image', file);
      const { imageUrl } = await api(`/garments/${g.id}/image`, { method: 'POST', body: fd });
      card.querySelector('.g-image-value').value = imageUrl;
      const preview = card.querySelector('.g-image-preview');
      const img = document.createElement('img');
      img.className = 'g-image-preview';
      img.src = imageUrl;
      img.style.cssText = 'width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--3t-border);';
      preview.replaceWith(img);
      showToast('Image uploaded and saved.');
    } catch (err) {
      showToast(err.message || 'Image upload failed.');
    } finally {
      e.target.value = '';
    }
  });
  const ssLinkBtn = card.querySelector('.g-ss-link-btn');
  if (ssLinkBtn) ssLinkBtn.addEventListener('click', () => runSsButton(ssLinkBtn, 'Linking…', async () => {
    const r = await api(`/garments/${g.id}/ss-link`, { method: 'POST', body: { style: card.querySelector('.g-ss-style').value } });
    showToast(`Linked to ${r.styleName}: ${r.colors} colors, ${r.sizes} sizes${r.note ? '. ' + r.note : ''}`);
    loadGarments();
  }));
  const ssSyncBtn = card.querySelector('.g-ss-sync-btn');
  if (ssSyncBtn) ssSyncBtn.addEventListener('click', () => runSsButton(ssSyncBtn, 'Syncing…', async () => {
    const r = await api(`/garments/${g.id}/ss-sync`, { method: 'POST', body: {} });
    showToast(`Synced: cost ${money(r.baseCost)}${r.upcharge != null ? `, upcharge ${money(r.upcharge)}` : ''}${r.note ? '. ' + r.note : ''}`);
    loadGarments();
  }));
  const ssUnlinkBtn = card.querySelector('.g-ss-unlink-btn');
  if (ssUnlinkBtn) ssUnlinkBtn.addEventListener('click', async () => {
    if (!confirm('Unlink this garment from S&S? Its current colors, sizes and prices stay as they are.')) return;
    await api(`/garments/${g.id}/ss-unlink`, { method: 'POST', body: {} });
    showToast('Unlinked from S&S.');
    loadGarments();
  });
  const ssPriceSync = card.querySelector('.g-ss-price-sync');
  if (ssPriceSync) ssPriceSync.addEventListener('change', async () => {
    await api(`/garments/${g.id}/ss-price-sync`, { method: 'PUT', body: { enabled: ssPriceSync.checked } });
    showToast(ssPriceSync.checked ? 'Prices will follow S&S.' : 'Prices will stay as you set them.');
  });
  card.querySelector('.delete-garment-btn').addEventListener('click', async () => {
    if (!confirm(`Delete "${g.name}"?\n\nIt disappears from admin and from customers. If any quote or order already uses it, it is archived instead so those orders keep working. This cannot be undone here.`)) return;
    try {
      const r = await api(`/garments/${g.id}/permanent`, { method: 'DELETE' });
      showToast(r.archived ? `Deleted. Archived (not erased) because ${r.quoteCount} quote(s) use it.` : 'Garment deleted.');
      closeEditDrawer();
      loadGarments();
    } catch (err) { showToast(err.message || 'Could not delete this garment.'); }
  });
  card.querySelector('.deactivate-garment-btn').addEventListener('click', async () => {
    await api(`/garments/${g.id}`, { method: 'DELETE' }); showToast('Garment deactivated.'); loadGarments();
  });
  card.querySelector('.add-color-btn').addEventListener('click', async () => {
    const { id } = await api(`/garments/${g.id}/colors`, { method: 'POST', body: { name: 'New Color', hex: '#000000' } });
    loadGarments();
  });
  card.querySelector('.add-size-btn').addEventListener('click', async () => {
    await api(`/garments/${g.id}/sizes`, { method: 'POST', body: { label: 'New Size', surcharge: 0 } });
    loadGarments();
  });
  card.querySelectorAll('.color-row').forEach(row => {
    row.querySelector('.save-color-btn').addEventListener('click', async () => {
      await api(`/colors/${row.dataset.colorId}`, { method: 'PUT', body: {
        name: row.querySelector('.c-name').value, hex: row.querySelector('.c-hex').value, active: row.querySelector('.c-active').checked,
      }});
      showToast('Color saved.');
    });
  });
  card.querySelectorAll('.size-row-edit').forEach(row => {
    row.querySelector('.save-size-btn').addEventListener('click', async () => {
      await api(`/sizes/${row.dataset.sizeId}`, { method: 'PUT', body: {
        label: row.querySelector('.s-label').value, surcharge: row.querySelector('.s-surcharge').value, active: row.querySelector('.s-active').checked,
      }});
      showToast('Size saved.');
    });
  });
}
document.getElementById('newGarmentBtn').addEventListener('click', async () => {
  const { id } = await api('/garments', { method: 'POST', body: { name: 'New Garment' } });
  editingGarmentId = id; // open the new garment's editor straight away
  loadGarments();
});

// ---- Import from S&S ----
async function ssSearch() {
  const btn = document.getElementById('ssSearchBtn');
  const out = document.getElementById('ssSearchResults');
  await runSsButton(btn, 'Searching…', async () => {
    const { styles } = await api('/ss/search', { method: 'POST', body: { query: document.getElementById('ssSearchInput').value } });
    out.innerHTML = styles.length ? styles.map(s => `
      <div class="print-detail-row" style="align-items:center;">
        ${s.styleImage ? `<img class="thumb-40" src="${esc(s.styleImage)}" alt="">` : ''}
        <div style="flex:1;"><div class="pd-name">${esc(s.brandName)} ${esc(s.styleName)}</div><div class="pd-file muted">${esc(s.title)}${s.baseCategory ? ' · ' + esc(s.baseCategory) : ''}</div></div>
        <button type="button" class="btn btn-dark btn-sm ss-import-btn" data-style-id="${s.styleID}">Import</button>
      </div>`).join('') : '<p class="muted">No S&amp;S styles matched.</p>';
    out.querySelectorAll('.ss-import-btn').forEach(b => b.addEventListener('click', () => runSsButton(b, 'Importing…', async () => {
      const r = await api('/ss/import', { method: 'POST', body: { styleID: b.dataset.styleId } });
      showToast(`Imported ${r.styleName}: ${r.colors} colors, ${r.sizes} sizes${r.note ? '. ' + r.note : ''}`);
      b.closest('.print-detail-row').remove();
      loadGarments();
    })));
  });
}
document.getElementById('ssSearchBtn').addEventListener('click', ssSearch);
document.getElementById('ssSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ssSearch(); });

// ==================================================================== PRICING (Phase 2)
let pendingPricingGarmentId = null; // set by a garment card's "Manage Tier Pricing" button
let pricingGarmentsCache = [];

async function loadPricing() {
  const [{ costs }, { tiers }, { settings }, { garments }, { log }] = await Promise.all([
    api('/cost-settings'), api('/quantity-tiers'), api('/settings'), api('/garments'), api('/action-log'),
  ]);
  document.getElementById('costBlank').value = costs.blank_cost;
  document.getElementById('costFront').value = costs.front_transfer_cost;
  document.getElementById('costLabor').value = costs.labor_cost;
  document.getElementById('costBack').value = costs.back_transfer_cost;
  document.getElementById('minMarginInput').value = settings.minimum_target_margin_pct ?? 20;

  renderTiersTable(tiers);
  pricingGarmentsCache = garments;
  const sel = document.getElementById('pricingGarmentSelect');
  sel.innerHTML = garments.map(g => `<option value="${g.id}">${esc(g.name)}${g.active ? '' : ' (inactive)'}</option>`).join('');
  sel.onchange = () => loadGarmentPricing(Number(sel.value));
  if (pendingPricingGarmentId && garments.some(g => g.id === pendingPricingGarmentId)) {
    sel.value = String(pendingPricingGarmentId);
  }
  pendingPricingGarmentId = null;
  if (sel.value) loadGarmentPricing(Number(sel.value));

  document.getElementById('actionLogBody').innerHTML = log.map(l => `
    <tr><td>${fmtDateTime(l.created_at)}</td><td>${esc(l.admin_name || '—')}</td><td>${esc(l.action_type.replace(/_/g,' '))}</td>
    <td style="max-width:360px;white-space:normal;font-size:11.5px;">${esc(actionLogSummary(l))}</td></tr>
  `).join('') || `<tr><td colspan="4" class="muted">No global actions logged yet.</td></tr>`;
}
function actionLogSummary(l) {
  if (l.action_type === 'global_price_adjustment' && l.detail) {
    const d = l.detail;
    return `${d.mode === 'percent' ? (d.amount > 0 ? '+' : '') + d.amount + '%' : money(d.amount)} applied to ${d.after?.length ?? '?'} garment(s).`;
  }
  return JSON.stringify(l.detail || {});
}

// Pricing panel sub-tabs: only one section on screen at a time.
function showPricingSubtab(name) {
  document.querySelectorAll('[data-panel="pricing"] .subtab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.subtab === name);
    b.setAttribute('aria-selected', String(b.dataset.subtab === name));
  });
  document.querySelectorAll('[data-panel="pricing"] [data-subtab-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.subtabPanel !== name));
  saveView('3t_admin_pricing_subtab', name);
}
document.querySelectorAll('[data-panel="pricing"] .subtab-btn').forEach(b => b.addEventListener('click', () => showPricingSubtab(b.dataset.subtab)));
showPricingSubtab(savedView('3t_admin_pricing_subtab', 'garment'));

// Quantity tiers as tiles (was a 43-row table).
function renderTiersTable(tiers) {
  const grid = document.getElementById('tiersTable');
  grid.innerHTML = tiers.map((t, i) => `
    <div class="tier-tile ${t.checkout_behavior === 'review' ? 'review' : ''}" data-tier-id="${t.id}">
      <div class="tt-label"><span>#<span class="tt-num">${i + 1}</span></span>
        <label style="font-weight:600;font-size:10px;"><input type="checkbox" class="t-active" style="width:auto;height:auto;" ${t.active ? 'checked' : ''}> On</label></div>
      <input type="text" class="t-label" value="${esc(t.label)}" aria-label="Tier label">
      <div class="tt-row"><span>Min</span><input type="number" class="t-min" value="${t.min_qty}" aria-label="Minimum quantity"></div>
      <div class="tt-row"><span>Max</span><input type="number" class="t-max" value="${t.max_qty}" aria-label="Maximum quantity"></div>
      <div class="tt-row"><select class="t-behavior" aria-label="Checkout"><option value="immediate" ${t.checkout_behavior === 'immediate' ? 'selected' : ''}>Instant</option><option value="review" ${t.checkout_behavior === 'review' ? 'selected' : ''}>Review</option></select></div>
      <div class="tt-actions">
        <button type="button" class="btn btn-outline btn-sm t-move" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move earlier" aria-label="Move earlier">◀</button>
        <button type="button" class="btn btn-outline btn-sm t-move" data-move="1" ${i === tiers.length - 1 ? 'disabled' : ''} title="Move later" aria-label="Move later">▶</button>
        <button type="button" class="btn btn-danger btn-sm t-delete" title="Delete tier" aria-label="Delete tier">✕</button>
      </div>
    </div>`).join('');

  grid.querySelectorAll('.t-move').forEach(btn => btn.addEventListener('click', () => {
    const tile = btn.closest('[data-tier-id]');
    const dir = Number(btn.dataset.move);
    const sibling = dir < 0 ? tile.previousElementSibling : tile.nextElementSibling;
    if (!sibling || !sibling.dataset.tierId) return;
    if (dir < 0) grid.insertBefore(tile, sibling); else grid.insertBefore(sibling, tile);
    renumberTierRows();
  }));
  grid.querySelectorAll('.t-delete').forEach(btn => btn.addEventListener('click', async () => {
    const tile = btn.closest('[data-tier-id]');
    if (!confirm('Delete this tier? Any garment/location prices set for it will be removed too.')) return;
    try {
      await api(`/quantity-tiers/${tile.dataset.tierId}`, { method: 'DELETE' });
      tile.remove();
      renumberTierRows();
      showToast('Tier deleted.');
    } catch (err) { showToast(err.message || 'Could not delete tier.'); }
  }));
  grid.querySelectorAll('.t-behavior').forEach(sel => sel.addEventListener('change', () => sel.closest('.tier-tile').classList.toggle('review', sel.value === 'review')));
}
function renumberTierRows() {
  const tiles = document.querySelectorAll('#tiersTable [data-tier-id]');
  tiles.forEach((tile, i) => {
    tile.querySelector('.tt-num').textContent = i + 1;
    tile.querySelectorAll('.t-move').forEach(b => b.disabled = false);
  });
  if (tiles.length) {
    tiles[0].querySelector('[data-move="-1"]').disabled = true;
    tiles[tiles.length - 1].querySelector('[data-move="1"]').disabled = true;
  }
}
document.getElementById('addTierBtn').addEventListener('click', async () => {
  await api('/quantity-tiers', { method: 'POST', body: { label: 'New Tier', minQty: 1, maxQty: 1, checkoutBehavior: 'immediate' } });
  loadPricing();
});
document.getElementById('saveTiersBtn').addEventListener('click', async () => {
  const rows = document.querySelectorAll('#tiersTable [data-tier-id]');
  const order = [];
  for (const row of rows) {
    const tierId = row.dataset.tierId;
    order.push(tierId);
    await api(`/quantity-tiers/${tierId}`, { method: 'PUT', body: {
      label: row.querySelector('.t-label').value, minQty: row.querySelector('.t-min').value, maxQty: row.querySelector('.t-max').value,
      checkoutBehavior: row.querySelector('.t-behavior').value, active: row.querySelector('.t-active').checked,
    }});
  }
  await api('/quantity-tiers-reorder', { method: 'PUT', body: { order } });
  showToast('Tiers saved.');
  loadPricing();
});

document.getElementById('saveCostsBtn').addEventListener('click', async () => {
  await api('/cost-settings', { method: 'PUT', body: {
    blank_cost: document.getElementById('costBlank').value, front_transfer_cost: document.getElementById('costFront').value,
    labor_cost: document.getElementById('costLabor').value, back_transfer_cost: document.getElementById('costBack').value,
  }});
  showToast('Cost settings saved.');
});
document.getElementById('saveMinMarginBtn').addEventListener('click', async () => {
  await api('/settings', { method: 'PUT', body: { minimum_target_margin_pct: document.getElementById('minMarginInput').value } });
  showToast('Saved.');
});

// ---- per-garment pricing (fixed_tier table or margin_based cost form) ----
async function loadGarmentPricing(garmentId) {
  const host = document.getElementById('garmentPricingHost');
  host.innerHTML = '<p class="muted">Loading…</p>';
  const garment = pricingGarmentsCache.find(g => g.id === garmentId);
  if (!garment) { host.innerHTML = ''; return; }

  if (garment.pricing_mode === 'margin_based') {
    await renderMarginBasedForm(host, garment);
  } else {
    await renderFixedTierTable(host, garment);
  }
}

async function renderFixedTierTable(host, garment) {
  const { tiers } = await api(`/garments/${garment.id}/tier-prices`);
  host.innerHTML = `
    <div class="action-btn-row" style="margin-bottom:10px;">
      <button type="button" class="btn btn-outline btn-sm" id="switchToMarginBtn">Switch to Margin-Based Pricing</button>
    </div>
    <div class="tier-tile-grid" id="fixedTierTable">
      ${tiers.map(t => `
        <div class="tier-tile ${t.checkoutBehavior === 'review' ? 'review' : ''}" data-tier-id="${t.tierId}">
          <div class="tt-label"><span>${esc(t.label)}</span>${t.isEstimatedPrice ? '<span class="tt-flag" title="Estimated price, needs your review">!</span>' : ''}</div>
          <div class="tt-row"><span>Price</span><input type="number" step="0.01" class="ft-standard" value="${t.standardPrice}" aria-label="${esc(t.label)} price"></div>
          <div class="tt-row"><span>Floor</span><input type="number" step="0.01" class="ft-floor" value="${t.hardFloorPrice}" aria-label="${esc(t.label)} floor"></div>
        </div>`).join('')}
    </div>
    <div class="action-btn-row">
      <button class="btn btn-dark btn-sm" id="saveFixedTierBtn">Save Tier Prices</button>
      <span class="muted" style="font-size:12px;align-self:center;">Amber tiles are 1,000+ (review, no instant checkout). Edited tiles are outlined until saved.</span>
    </div>
    ${priceTesterHtml()}
  `;
  // Only tiles the admin actually touches get saved (and so only those clear
  // their Estimated flag); clicking Save must never silently mark every
  // other still-unreviewed placeholder tier as "confirmed" too.
  document.querySelectorAll('#fixedTierTable [data-tier-id] input').forEach(input => {
    input.addEventListener('input', () => { const tile = input.closest('[data-tier-id]'); tile.dataset.dirty = '1'; tile.classList.add('dirty'); });
  });
  document.getElementById('saveFixedTierBtn').addEventListener('click', async () => {
    const dirtyRows = document.querySelectorAll('#fixedTierTable [data-tier-id][data-dirty="1"]');
    if (dirtyRows.length === 0) { showToast('No changes to save.'); return; }
    for (const row of dirtyRows) {
      await api(`/garments/${garment.id}/tier-prices/${row.dataset.tierId}`, { method: 'PUT', body: {
        standardPrice: row.querySelector('.ft-standard').value, hardFloorPrice: row.querySelector('.ft-floor').value,
      }});
    }
    showToast(`Saved ${dirtyRows.length} tier price(s) — Estimated badge cleared only on rows you edited.`);
    loadGarmentPricing(garment.id);
  });
  document.getElementById('switchToMarginBtn').addEventListener('click', () => switchPricingMode(garment, 'margin_based'));
  bindPriceTester(garment.id);
}

async function renderMarginBasedForm(host, garment) {
  const { costInputs, tierFreight } = await api(`/garments/${garment.id}/cost-inputs`);
  host.innerHTML = `
    <div class="action-btn-row" style="margin-bottom:10px;">
      <button type="button" class="btn btn-outline btn-sm" id="switchToFixedBtn">Switch to Fixed-Tier Pricing</button>
    </div>
    <div class="sub"><strong>Selling Price = Total Unit Cost / (1 − Target Gross Margin)</strong>. Spoilage and payment-processing allowances are applied as % markups on the cost subtotal (garment cost + freight + transfer + labor + finishing + overhead) before dividing by the margin.</div>
    <div class="field-row">
      <div class="field"><label>Garment Cost</label><input type="number" step="0.01" class="mb-garment-cost" value="${costInputs.garment_cost}"></div>
      <div class="field"><label>DTF Transfer Cost</label><input type="number" step="0.01" class="mb-dtf" value="${costInputs.dtf_transfer_cost}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Pressing Labor</label><input type="number" step="0.01" class="mb-labor" value="${costInputs.pressing_labor}"></div>
      <div class="field"><label>Finishing &amp; Packaging</label><input type="number" step="0.01" class="mb-finishing" value="${costInputs.finishing_packaging}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Spoilage Allowance %</label><input type="number" step="0.1" class="mb-spoilage" value="${costInputs.spoilage_pct}"></div>
      <div class="field"><label>Payment Processing Allowance %</label><input type="number" step="0.1" class="mb-payproc" value="${costInputs.payment_processing_pct}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Overhead</label><input type="number" step="0.01" class="mb-overhead" value="${costInputs.overhead}"></div>
      <div class="field"><label>Target Gross Margin %</label><input type="number" step="0.1" class="mb-margin" value="${costInputs.target_margin_pct}"></div>
    </div>
    <button class="btn btn-dark btn-sm" id="saveMarginInputsBtn">Save Cost Inputs</button>

    <h3 class="mt-16">Incoming Garment Freight (per unit, by tier)</h3>
    <div class="sub">The one cost that plausibly drops at higher volumes — everything else above is treated as flat per-unit regardless of order size.</div>
    <div class="tier-tile-grid" id="freightTable">
      ${tierFreight.map(t => `<div class="tier-tile" data-tier-id="${t.tierId}"><div class="tt-label"><span>${esc(t.label)}</span></div>
        <div class="tt-row"><span>Freight</span><input type="number" step="0.01" class="freight-input" value="${t.freightPerUnit}" aria-label="${esc(t.label)} freight per unit"></div></div>`).join('')}
    </div>
    <button class="btn btn-dark btn-sm mt-8" id="saveFreightBtn">Save Freight</button>
    ${priceTesterHtml()}
  `;
  document.getElementById('saveMarginInputsBtn').addEventListener('click', async () => {
    await api(`/garments/${garment.id}/cost-inputs`, { method: 'PUT', body: {
      garmentCost: document.querySelector('.mb-garment-cost').value, dtfTransferCost: document.querySelector('.mb-dtf').value,
      pressingLabor: document.querySelector('.mb-labor').value, finishingPackaging: document.querySelector('.mb-finishing').value,
      spoilagePct: document.querySelector('.mb-spoilage').value, paymentProcessingPct: document.querySelector('.mb-payproc').value,
      overhead: document.querySelector('.mb-overhead').value, targetMarginPct: document.querySelector('.mb-margin').value,
    }});
    showToast('Cost inputs saved.');
  });
  document.getElementById('saveFreightBtn').addEventListener('click', async () => {
    const rows = document.querySelectorAll('#freightTable [data-tier-id]');
    for (const row of rows) {
      await api(`/garments/${garment.id}/tier-freight/${row.dataset.tierId}`, { method: 'PUT', body: { freightPerUnit: row.querySelector('.freight-input').value } });
    }
    showToast('Freight saved.');
  });
  document.getElementById('switchToFixedBtn').addEventListener('click', () => switchPricingMode(garment, 'fixed_tier'));
  bindPriceTester(garment.id);
}

async function switchPricingMode(garment, mode) {
  if (!confirm(`Switch ${garment.name} to ${mode === 'margin_based' ? 'margin-based' : 'fixed-tier'} pricing? This changes how its selling price is computed going forward.`)) return;
  await api(`/garments/${garment.id}/pricing-mode`, { method: 'PUT', body: { pricingMode: mode } });
  garment.pricing_mode = mode;
  showToast('Pricing mode updated.');
  loadGarmentPricing(garment.id);
}

function priceTesterHtml() {
  return `
    <div class="admin-card mt-16" style="background:var(--3t-light-gray);">
      <h3>Price Tester</h3>
      <div class="sub">Compute what a customer would actually be charged right now, at any quantity — runs the exact same pricing code as a live quote.</div>
      <div class="field-row" style="align-items:flex-end;">
        <div class="field mb-0"><label>Quantity</label><input type="number" min="1" id="priceTesterQty" value="24" style="width:120px;"></div>
        <button type="button" class="btn btn-outline btn-sm" id="priceTesterBtn" style="height:fit-content;">Test Price</button>
      </div>
      <div id="priceTesterResult" class="mt-8"></div>
    </div>`;
}
function bindPriceTester(garmentId) {
  document.getElementById('priceTesterBtn').addEventListener('click', async () => {
    const qty = document.getElementById('priceTesterQty').value;
    const resultHost = document.getElementById('priceTesterResult');
    resultHost.innerHTML = '<span class="muted">Testing…</span>';
    try {
      const r = await api(`/garments/${garmentId}/price-test`, { method: 'POST', body: { qty } });
      resultHost.innerHTML = `
        <div class="override-grid">
          <div class="override-tile"><div class="ot-label">Tier</div><div class="ot-value">${esc(r.tier?.label || '—')}</div></div>
          <div class="override-tile"><div class="ot-label">Standard Unit</div><div class="ot-value">${money(r.standardUnit)}</div></div>
          <div class="override-tile"><div class="ot-label">Total (${qty} pcs)</div><div class="ot-value">${money(r.total)}</div></div>
          <div class="override-tile"><div class="ot-label">Gross Margin</div><div class="ot-value">${r.internal.grossMarginPct.toFixed(1)}%</div></div>
        </div>
        ${r.isEstimatedPrice ? '<div class="warn-box">⚠ This tier\'s price is an unreviewed Phase 2 placeholder.</div>' : ''}
        ${r.internal.belowMinimumMargin ? `<div class="warn-box red">Below the ${r.internal.minimumTargetMarginPct}% minimum target margin.</div>` : ''}
      `;
    } catch (err) {
      resultHost.innerHTML = `<div class="warn-box red">${esc(err.message || 'Could not compute a price.')}</div>`;
    }
  });
}

document.getElementById('applyGlobalAdjBtn').addEventListener('click', async () => {
  const mode = document.getElementById('globalAdjType').value;
  const amount = Number(document.getElementById('globalAdjAmount').value);
  if (!amount) { showToast('Enter a non-zero amount.'); return; }
  const desc = mode === 'percent' ? `${amount > 0 ? '+' : ''}${amount}%` : money(amount);
  if (!confirm(`Apply ${desc} to every garment's price? Fixed-tier garments scale all tier prices; margin-based garments get their Garment Cost increased by this amount. This is a real, consequential bulk action.`)) return;
  const btn = document.getElementById('applyGlobalAdjBtn');
  btn.disabled = true;
  try {
    const { garmentsAffected } = await api('/global-price-adjustment', { method: 'POST', body: { mode, amount } });
    showToast(`Applied to ${garmentsAffected} garment(s). See the Admin Action Log below.`);
    loadPricing();
  } catch (err) {
    showToast(err.message || 'Could not apply the adjustment.');
  } finally {
    btn.disabled = false;
  }
});

// ==================================================================== PRINT LOCATIONS
// Locations as compact tiles, plus ONE add-on price grid for whichever
// location is picked (was a 43-column row per location, ~3 screens wide).
let pricingLocationId = null;
async function loadLocations() {
  const { printLocations } = await api('/print-locations');
  const priced = printLocations.filter(l => !l.included_in_base);
  if (!priced.some(l => l.id === pricingLocationId)) pricingLocationId = priced.length ? priced[0].id : null;
  const current = priced.find(l => l.id === pricingLocationId);

  document.getElementById('locationsList').innerHTML = `
    <div class="tile-grid">${printLocations.map(l => `
      <div class="admin-card loc-tile" data-loc-id="${l.id}" style="margin:0;padding:12px;${l.active ? '' : 'opacity:.6;'}">
        <div class="field"><label>Name</label><input type="text" class="l-name" value="${esc(l.name)}"></div>
        <div class="field"><label>Internal Cost / Unit</label><input type="number" step="0.01" class="l-cost" value="${l.internal_cost_per_unit}"></div>
        <label style="display:block;"><input type="checkbox" class="l-included" ${l.included_in_base ? 'checked' : ''}> Included in shirt price (Front)</label>
        <label style="display:block;margin-bottom:8px;"><input type="checkbox" class="l-active" ${l.active ? 'checked' : ''}> Active</label>
        <button class="btn btn-dark btn-sm save-loc-btn">Save</button>
      </div>`).join('')}
    </div>
    <div class="admin-card mt-16">
      <h3>Add-on Print Prices (per piece)</h3>
      ${current ? `
        <div class="loc-chip-row" role="group" aria-label="Pick a print location">${priced.map(l => `<button type="button" class="loc-chip ${l.id === current.id ? 'active' : ''}" data-pick-loc="${l.id}">${esc(l.name)}</button>`).join('')}</div>
        <div class="tier-tile-grid" id="locPriceGrid">${current.tierPricing.map(p => `
          <div class="tier-tile" data-tier-id="${p.tierId}">
            <div class="tt-label"><span>${esc(p.label)}</span>${p.isEstimatedPrice ? '<span class="tt-flag" title="Estimated price, needs your review">!</span>' : ''}</div>
            <input type="number" step="0.01" class="addon-input" data-tier-id="${p.tierId}" value="${p.addonPrice}" aria-label="${esc(current.name)} add-on at ${esc(p.label)}">
          </div>`).join('')}
        </div>
        <button class="btn btn-dark btn-sm mt-8" id="saveLocPricesBtn">Save ${esc(current.name)} Prices</button>`
      : '<p class="muted">Every active location is included in the shirt price, so there are no add-on prices to set.</p>'}
    </div>`;

  document.querySelectorAll('.loc-tile[data-loc-id]').forEach(card => {
    const id = card.dataset.locId;
    card.querySelector('.save-loc-btn').addEventListener('click', async () => {
      await api(`/print-locations/${id}`, { method: 'PUT', body: {
        name: card.querySelector('.l-name').value, internalCostPerUnit: card.querySelector('.l-cost').value,
        includedInBase: card.querySelector('.l-included').checked, active: card.querySelector('.l-active').checked,
      }});
      showToast('Print location saved.');
      loadLocations();
    });
  });
  document.querySelectorAll('[data-pick-loc]').forEach(chip => chip.addEventListener('click', () => {
    if (document.querySelector('#locPriceGrid .dirty') && !confirm('You have unsaved price changes for this location. Switch anyway?')) return;
    pricingLocationId = Number(chip.dataset.pickLoc);
    loadLocations();
  }));
  // Only tiles the admin actually touches get saved (and so only those clear
  // their Estimated flag); Save must never silently mark every other
  // still-unreviewed placeholder tier add-on as "confirmed" too.
  document.querySelectorAll('#locPriceGrid .addon-input').forEach(input => {
    input.addEventListener('input', () => { input.dataset.dirty = '1'; input.closest('.tier-tile').classList.add('dirty'); });
  });
  const saveBtn = document.getElementById('saveLocPricesBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const dirtyInputs = document.querySelectorAll('#locPriceGrid .addon-input[data-dirty="1"]');
    if (dirtyInputs.length === 0) { showToast('No changes to save.'); return; }
    for (const input of dirtyInputs) await api(`/print-locations/${pricingLocationId}/tier-pricing/${input.dataset.tierId}`, { method: 'PUT', body: { addonPrice: input.value } });
    showToast(`Saved ${dirtyInputs.length} price(s).`);
    loadLocations();
  });
}
document.getElementById('newLocationBtn').addEventListener('click', async () => {
  await api('/print-locations', { method: 'POST', body: { name: 'New Location', defaultAddon: 0 } });
  loadLocations();
});

// ==================================================================== ARTWORK
async function loadArtwork() {
  document.getElementById('artworkStatusFilter').onchange = fetchArtwork;
  fetchArtwork();
}
async function fetchArtwork() {
  const status = document.getElementById('artworkStatusFilter').value;
  const { artwork } = await api('/artwork' + (status ? `?status=${status}` : ''));
  rememberArtwork(artwork);
  document.getElementById('artworkGrid').innerHTML = artwork.map(f => `
    <div class="option-card" style="cursor:default;">
      <button type="button" class="art-thumb-btn" data-view-art="${f.id}" title="View artwork" aria-label="View ${esc(f.original_filename)}">
        ${f.mime_type === 'application/pdf'
          ? `<div style="aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;border-radius:6px;background:#f3f4f6;font-weight:700;color:#6b7280;">PDF</div>`
          : `<img src="${f.url}" alt="" onerror="this.style.display='none'" style="aspect-ratio:1/1;object-fit:cover;border-radius:6px;width:100%;">`}
      </button>
      <div class="oc-title" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.original_filename)}</div>
      <a class="btn btn-dark btn-sm" href="${f.downloadUrl}" style="margin-top:4px;text-align:center;">Download</a>
      <div class="oc-sub">${esc(f.quote_code)} · ${esc(f.first_name)} ${esc(f.last_name)}</div>
      <div class="oc-sub">${esc(f.location_name || '')}</div>
      <select data-file-id="${f.id}" data-quote="${f.quote_code}" style="margin-top:4px;font-size:11.5px;padding:4px;">
        ${['pending_review','approved','needs_changes','customer_revision_requested','production_ready'].map(s=>`<option value="${s}" ${s===f.status?'selected':''}>${s.replace(/_/g,' ')}</option>`).join('')}
      </select>
    </div>
  `).join('') || '<p class="muted">No artwork uploaded yet.</p>';

  document.querySelectorAll('#artworkGrid select').forEach(sel => sel.addEventListener('change', async () => {
    await api(`/quotes/${sel.dataset.quote}/artwork-status`, { method: 'PATCH', body: { status: sel.value, fileId: sel.dataset.fileId } });
    showToast('Artwork status updated.');
  }));
}

// ==================================================================== MOCKUPS
const MOCKUP_STATUS_LABEL = { pending_customer: 'Awaiting Customer', approved: 'Approved', changes_requested: 'Changes Requested' };
const MOCKUP_STATUS_BADGE = { pending_customer: 'badge-amber', approved: 'badge-green', changes_requested: 'badge-red' };

async function loadMockups() {
  const { orders } = await api('/mockups/orders');
  document.getElementById('mockupOrderSelect').innerHTML = orders.map(o =>
    `<option value="${esc(o.quoteCode)}">${esc(o.quoteCode)} — ${esc(o.customerName)} (${o.status.replace(/_/g,' ')})</option>`
  ).join('') || '<option value="">No active orders</option>';
  fetchMockups();
}

async function fetchMockups() {
  const { mockups } = await api('/mockups');
  document.getElementById('mockupsList').innerHTML = mockups.map(m => `
    <div class="option-card" style="cursor:default;">
      <a href="${m.url}" target="_blank" rel="noopener"><img src="${m.url}" onerror="this.style.display='none'" style="aspect-ratio:1/1;object-fit:cover;border-radius:6px;"></a>
      <div class="oc-title" style="font-size:12.5px;">${esc(m.quote_code)}</div>
      <div class="oc-sub">${esc(m.first_name)} ${esc(m.last_name)}</div>
      <span class="badge ${MOCKUP_STATUS_BADGE[m.status] || 'badge-gray'}" style="margin-top:4px;">${MOCKUP_STATUS_LABEL[m.status] || m.status}</span>
      ${m.customer_note ? `<div class="oc-sub mt-8" style="white-space:normal;"><strong>Note:</strong> ${esc(m.customer_note)}</div>` : ''}
      <div class="oc-sub">${fmtDateTime(m.uploaded_at)}</div>
    </div>
  `).join('') || '<p class="muted">No mockups sent yet.</p>';
}

document.getElementById('sendMockupBtn').addEventListener('click', async () => {
  const code = document.getElementById('mockupOrderSelect').value;
  const fileInput = document.getElementById('mockupFileInput');
  const file = fileInput.files[0];
  if (!code) { showToast('No order selected.'); return; }
  if (!file) { showToast('Choose an image to upload.'); return; }

  const btn = document.getElementById('sendMockupBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    const fd = new FormData();
    fd.append('image', file);
    const result = await api(`/quotes/${code}/mockups`, { method: 'POST', body: fd });
    if (result.emailError) {
      showToast(`Mockup saved, but the email failed: ${result.emailError}`);
    } else {
      showToast('Mockup sent to the customer for approval.');
    }
    fileInput.value = '';
    fetchMockups();
  } catch (err) {
    showToast(err.message || 'Could not send mockup.');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// ==================================================================== DISCOUNTS
async function loadDiscounts() {
  fetchDiscounts();
}
async function fetchDiscounts() {
  const { discountCodes } = await api('/discount-codes');
  document.getElementById('discountsBody').innerHTML = discountCodes.map(d => `
    <tr>
      <td><strong>${esc(d.code)}</strong></td>
      <td>${d.type === 'percent' ? 'Percent Off' : 'Flat $ Off'}</td>
      <td>${d.type === 'percent' ? `${d.value}%` : money(d.value)}</td>
      <td>${d.times_used}${d.usage_limit != null ? ` / ${d.usage_limit}` : ''}</td>
      <td>${d.expires_at ? fmtDate(d.expires_at) : 'Never'}</td>
      <td><input type="checkbox" data-discount-active="${d.id}" ${d.active ? 'checked' : ''}></td>
      <td><button class="btn btn-danger btn-sm" data-discount-delete="${d.id}">Delete</button></td>
    </tr>
  `).join('') || `<tr><td colspan="7" class="muted">No discount codes yet.</td></tr>`;

  document.querySelectorAll('[data-discount-active]').forEach(cb => cb.addEventListener('change', async () => {
    await api(`/discount-codes/${cb.dataset.discountActive}`, { method: 'PATCH', body: { active: cb.checked } });
    showToast(cb.checked ? 'Code activated.' : 'Code deactivated.');
  }));
  document.querySelectorAll('[data-discount-delete]').forEach(btn => btn.addEventListener('click', async () => {
    await api(`/discount-codes/${btn.dataset.discountDelete}`, { method: 'DELETE' });
    showToast('Discount code deleted.');
    fetchDiscounts();
  }));
}

document.getElementById('generateDiscountCodeBtn').addEventListener('click', () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  document.getElementById('discountCodeInput').value = code;
});

document.getElementById('createDiscountBtn').addEventListener('click', async () => {
  const btn = document.getElementById('createDiscountBtn');
  const code = document.getElementById('discountCodeInput').value.trim();
  const type = document.getElementById('discountTypeInput').value;
  const value = document.getElementById('discountValueInput').value;
  const usageLimit = document.getElementById('discountUsageLimitInput').value;
  const expiresAt = document.getElementById('discountExpiresInput').value;
  const active = document.getElementById('discountActiveInput').checked;
  if (!code) { showToast('Enter a code (or click Generate).'); return; }
  if (!value) { showToast('Enter a value.'); return; }

  btn.disabled = true;
  try {
    await api('/discount-codes', { method: 'POST', body: { code, type, value, usageLimit, expiresAt, active } });
    showToast('Discount code created.');
    document.getElementById('discountCodeInput').value = '';
    document.getElementById('discountValueInput').value = '';
    document.getElementById('discountUsageLimitInput').value = '';
    document.getElementById('discountExpiresInput').value = '';
    fetchDiscounts();
  } catch (err) {
    showToast(err.message || 'Could not create discount code.');
  } finally {
    btn.disabled = false;
  }
});

// ==================================================================== ANALYTICS
async function loadAnalytics() {
  document.getElementById('analyticsDaysSelect').onchange = fetchAnalytics;
  fetchAnalytics();
}

async function fetchAnalytics() {
  const days = document.getElementById('analyticsDaysSelect').value;
  const data = await api(`/analytics?days=${days}`);

  document.getElementById('analyticsStatGrid').innerHTML = `
    ${statTile('Revenue', money(data.orderStats.revenue))}
    ${statTile('Orders', data.orderStats.orders)}
    ${statTile('Avg Order Value', money(data.orderStats.avgOrderValue))}
    ${statTile('Repeat Customer Rate', `${data.repeatCustomers.rate}%`)}
  `;

  renderFunnel(data.funnel);
  renderRevenueChart(data.revenueByDay);

  document.getElementById('analyticsSourcesBody').innerHTML = data.trafficSources.map(s => {
    const conversion = s.visitors > 0 ? ((s.paid / s.visitors) * 100).toFixed(1) : '0.0';
    return `<tr><td><strong>${esc(s.source)}</strong></td><td>${s.visitors}</td><td>${s.quotesGenerated}</td><td>${s.paid}</td><td>${conversion}%</td></tr>`;
  }).join('') || `<tr><td colspan="5" class="muted">No visits recorded yet.</td></tr>`;

  document.getElementById('analyticsTopGarmentsBody').innerHTML = data.topGarments.map(g =>
    `<tr><td>${esc(g.name)}</td><td>${g.qty}</td></tr>`
  ).join('') || `<tr><td colspan="2" class="muted">No paid orders in this window.</td></tr>`;
}

function renderFunnel(funnel) {
  const max = Math.max(1, ...funnel.map(f => f.count));
  document.getElementById('analyticsFunnel').innerHTML = funnel.map(f => {
    const pct = Math.round((f.count / max) * 100);
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <div style="width:120px;font-size:12.5px;font-weight:700;flex-shrink:0;">${esc(f.label)}</div>
      <div style="flex:1;background:var(--3t-light-gray);border-radius:4px;overflow:hidden;height:22px;">
        <div style="width:${pct}%;background:var(--3t-lime,#CCFF00);height:100%;"></div>
      </div>
      <div style="width:50px;text-align:right;font-size:12.5px;font-weight:700;flex-shrink:0;">${f.count}</div>
    </div>`;
  }).join('');
}

function renderRevenueChart(revenueByDay) {
  const host = document.getElementById('analyticsRevenueChart');
  if (!revenueByDay.length) { host.innerHTML = '<p class="muted">No paid orders in this window.</p>'; return; }
  const max = Math.max(1, ...revenueByDay.map(d => d.revenue));
  const barWidth = Math.max(6, Math.min(28, Math.floor(560 / revenueByDay.length) - 4));
  const bars = revenueByDay.map(d => {
    const h = Math.max(2, Math.round((d.revenue / max) * 120));
    return `<div title="${esc(d.day)}: ${money(d.revenue)} (${d.orders} order${d.orders===1?'':'s'})" style="width:${barWidth}px;height:${h}px;background:var(--3t-lime,#CCFF00);border-radius:2px 2px 0 0;flex-shrink:0;"></div>`;
  }).join('');
  host.innerHTML = `<div style="display:flex;align-items:flex-end;gap:3px;height:130px;overflow-x:auto;padding-bottom:4px;">${bars}</div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--3t-ink-soft);margin-top:4px;">
      <span>${esc(revenueByDay[0].day)}</span><span>${esc(revenueByDay[revenueByDay.length-1].day)}</span>
    </div>`;
}

// ==================================================================== SETTINGS
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('hidden', t.dataset.tab !== btn.dataset.tab));
  if (btn.dataset.tab === 'email') fetchEmails();
  if (btn.dataset.tab === 'layout') loadLayoutStepOrder();
  if (btn.dataset.tab === 'ss') loadSsSettings();
}));

// ---- S&S Activewear settings ----
async function loadSsSettings() {
  const [s, { garments }] = await Promise.all([api('/ss/settings'), api('/garments')]);
  document.getElementById('ssAccountNumber').value = s.accountNumber || '';
  document.getElementById('ssApiKey').value = '';
  document.getElementById('ssApiKey').placeholder = s.hasApiKey ? 'saved (leave blank to keep)' : 'paste your API key';
  document.getElementById('ssMarkupPct').value = s.markupPct;
  document.getElementById('ssAutoSync').checked = s.autoSync;
  document.getElementById('ssReferenceGarment').innerHTML = garments.filter(g => g.active)
    .map(g => `<option value="${g.id}" ${g.id === s.referenceGarmentId ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
  document.getElementById('ssStatus').textContent = s.configured
    ? `Connected account ${s.accountNumber}. ${s.lastSyncAll ? 'Last full sync: ' + fmtDateTime(s.lastSyncAll) + '.' : 'Not synced yet.'}`
    : 'Not connected yet: enter your account number and API key, then Save.';
}
document.getElementById('ssSaveBtn').addEventListener('click', async () => {
  try {
    await api('/ss/settings', { method: 'PUT', body: {
      accountNumber: document.getElementById('ssAccountNumber').value,
      apiKey: document.getElementById('ssApiKey').value,
      markupPct: document.getElementById('ssMarkupPct').value,
      referenceGarmentId: document.getElementById('ssReferenceGarment').value,
      autoSync: document.getElementById('ssAutoSync').checked,
    }});
    showToast('S&S settings saved.');
    loadSsSettings();
  } catch (err) { showToast(err.message); }
});
async function runSsButton(btn, busyText, fn) {
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = busyText;
  try { await fn(); } catch (err) { showToast(err.message); } finally { btn.disabled = false; btn.textContent = original; }
}
document.getElementById('ssTestBtn').addEventListener('click', (e) => runSsButton(e.target, 'Testing…', async () => {
  const { message } = await api('/ss/test', { method: 'POST', body: {} });
  showToast(message);
}));
function ssResultsHtml(results) {
  if (!results.length) return '<p class="muted">No garments are linked to S&amp;S yet. Link them on the Garments tab.</p>';
  return `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Garment</th><th>Result</th></tr></thead><tbody>${results.map(r => `<tr>
    <td>${esc(r.name)}</td>
    <td>${r.ok ? `S&amp;S cost ${money(r.baseCost)} · ${r.colors} colors · ${r.sizes} sizes · ${Number(r.totalStock).toLocaleString('en-US')} in stock${r.upcharge != null ? ` · upcharge ${r.upcharge >= 0 ? '+' : ''}${money(r.upcharge)}` : ''}${r.isReference ? ' · reference garment' : ''}${r.note ? ` · ${esc(r.note)}` : ''}`
      : `<span class="badge badge-red">Failed</span> ${esc(r.error)}`}</td></tr>`).join('')}</tbody></table></div>`;
}
document.getElementById('ssSyncAllBtn').addEventListener('click', (e) => runSsButton(e.target, 'Syncing…', async () => {
  const { results } = await api('/ss/sync-all', { method: 'POST', body: {} });
  document.getElementById('ssSyncResults').innerHTML = ssResultsHtml(results);
  showToast(`Synced ${results.filter(r => r.ok).length} of ${results.length} garments.`);
  loadSsSettings();
}));
async function loadSettings() {
  const { settings } = await api('/settings');
  document.getElementById('settingBusinessName').value = settings.business_name || '';
  document.getElementById('settingBusinessEmail').value = settings.business_email || '';
  document.getElementById('settingExpirationDays').value = settings.quote_expiration_days || 7;
  document.getElementById('settingPaymentProvider').value = settings.payment_provider || 'mock';
  document.getElementById('settingShopifyDomain').value = settings.shopify_shop_domain || '';
  document.getElementById('settingShopifyClientId').value = settings.shopify_client_id || '';
  document.getElementById('settingShopifyClientSecret').value = settings.shopify_client_secret || '';
  document.getElementById('settingEmailProvider').value = settings.email_provider || 'mock';
  document.getElementById('settingGmailAddress').value = settings.gmail_address || '';
  document.getElementById('settingGmailAppPassword').value = settings.gmail_app_password || '';
  document.getElementById('settingTaxRatePct').value = settings.tax_rate_pct ?? 8;
  document.getElementById('settingRushFeePct').value = settings.rush_fee_pct ?? 20;
  document.getElementById('settingDepositThreshold').value = settings.deposit_threshold ?? 1000;
  document.getElementById('settingDepositPct').value = settings.deposit_pct ?? 50;
}
document.getElementById('saveCheckoutBtn').addEventListener('click', async () => {
  const vals = {
    tax_rate_pct: document.getElementById('settingTaxRatePct').value,
    rush_fee_pct: document.getElementById('settingRushFeePct').value,
    deposit_threshold: document.getElementById('settingDepositThreshold').value,
    deposit_pct: document.getElementById('settingDepositPct').value,
  };
  const n = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, Number(v)]));
  if (!(n.tax_rate_pct >= 0 && n.tax_rate_pct <= 100)) return showToast('Sales tax must be between 0% and 100%.');
  if (!(n.rush_fee_pct >= 0 && n.rush_fee_pct <= 500)) return showToast('Rush fee must be between 0% and 500%.');
  if (!(n.deposit_threshold >= 0)) return showToast('Enter a deposit amount of $0 or more.');
  if (!(n.deposit_pct >= 1 && n.deposit_pct <= 100)) return showToast('Deposit must be between 1% and 100%.');
  await api('/settings', { method: 'PUT', body: vals });
  showToast('Checkout rules saved.');
});
document.getElementById('saveGeneralBtn').addEventListener('click', async () => {
  await api('/settings', { method: 'PUT', body: {
    business_name: document.getElementById('settingBusinessName').value,
    business_email: document.getElementById('settingBusinessEmail').value,
    quote_expiration_days: document.getElementById('settingExpirationDays').value,
  }});
  showToast('Saved.');
});
document.getElementById('savePaymentBtn').addEventListener('click', async () => {
  await api('/settings', { method: 'PUT', body: {
    payment_provider: document.getElementById('settingPaymentProvider').value,
    shopify_shop_domain: document.getElementById('settingShopifyDomain').value,
    shopify_client_id: document.getElementById('settingShopifyClientId').value,
    shopify_client_secret: document.getElementById('settingShopifyClientSecret').value,
  }});
  showToast('Saved.');
});
document.getElementById('saveEmailBtn').addEventListener('click', async () => {
  await api('/settings', { method: 'PUT', body: {
    email_provider: document.getElementById('settingEmailProvider').value,
    gmail_address: document.getElementById('settingGmailAddress').value,
    gmail_app_password: document.getElementById('settingGmailAppPassword').value,
  }});
  showToast('Saved.');
});
document.getElementById('sendTestEmailBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    const { sentTo } = await api('/test-email', { method: 'POST', body: {} });
    showToast(`Test email sent to ${sentTo}.`);
    fetchEmails();
  } catch (err) {
    showToast(err.message || 'Could not send test email.');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});
document.getElementById('changePwBtn').addEventListener('click', async () => {
  try {
    await api('/change-password', { method: 'POST', body: { currentPassword: document.getElementById('curPassword').value, newPassword: document.getElementById('newPassword').value } });
    showToast('Password updated.');
    document.getElementById('curPassword').value = ''; document.getElementById('newPassword').value = '';
  } catch (err) { showToast(err.message); }
});
async function fetchEmails() {
  const { emails } = await api('/emails');
  document.getElementById('emailsBody').innerHTML = emails.map(e => `<tr><td>${esc(e.to_email)}</td><td>${esc(e.subject)}</td><td>${fmtDateTime(e.sent_at)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No emails sent yet.</td></tr>';
}

// -------------------------------------------------------------- layout (step order)
// Lets the admin reorder the 6 customer-builder steps. Reordering is safe by
// construction: the builder's own prereq-notice system (see builder.js's
// onStepEnter) already redirects a customer who reaches a step whose data
// dependencies aren't met yet, and the server never accepts a quote that's
// missing required fields (calculateQuote() throws) — so any permutation a
// person can drag together here is safe to ship, no combination needs to be
// blocked here beyond "every step exactly once."
let layoutStepOrder = [];
let layoutStepLabels = {};
let layoutDefaultOrder = [];

async function loadLayoutStepOrder() {
  const { stepOrder, defaultOrder, stepLabels } = await api('/settings/step-order');
  layoutStepOrder = stepOrder;
  layoutDefaultOrder = defaultOrder;
  layoutStepLabels = stepLabels;
  renderLayoutStepList();
}

function renderLayoutStepList() {
  const host = document.getElementById('layoutStepList');
  host.innerHTML = layoutStepOrder.map((key, i) => `
    <div class="layout-step-row" draggable="true" data-step-key="${key}" data-index="${i}">
      <span class="layout-step-handle" aria-hidden="true">⠿</span>
      <span class="layout-step-num">${i + 1}</span>
      <span class="layout-step-name">${esc(layoutStepLabels[key] || key)}</span>
      <span class="layout-step-move">
        <button type="button" class="btn-icon" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up">↑</button>
        <button type="button" class="btn-icon" data-move="1" ${i === layoutStepOrder.length - 1 ? 'disabled' : ''} title="Move down" aria-label="Move down">↓</button>
      </span>
    </div>
  `).join('');

  host.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => {
    const row = btn.closest('.layout-step-row');
    const from = Number(row.dataset.index);
    const to = from + Number(btn.dataset.move);
    if (to < 0 || to >= layoutStepOrder.length) return;
    const [moved] = layoutStepOrder.splice(from, 1);
    layoutStepOrder.splice(to, 0, moved);
    renderLayoutStepList();
  }));

  let dragFrom = null;
  host.querySelectorAll('.layout-step-row').forEach(row => {
    row.addEventListener('dragstart', () => { dragFrom = Number(row.dataset.index); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const to = Number(row.dataset.index);
      if (dragFrom === null || dragFrom === to) return;
      const [moved] = layoutStepOrder.splice(dragFrom, 1);
      layoutStepOrder.splice(to, 0, moved);
      dragFrom = null;
      renderLayoutStepList();
    });
  });
}

document.getElementById('saveLayoutBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    await api('/settings/step-order', { method: 'PUT', body: { stepOrder: layoutStepOrder } });
    showToast('Step order saved.');
  } catch (err) {
    showToast(err.message || 'Could not save step order.');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('resetLayoutBtn').addEventListener('click', async () => {
  layoutStepOrder = [...layoutDefaultOrder];
  renderLayoutStepList();
  await api('/settings/step-order', { method: 'PUT', body: { stepOrder: layoutStepOrder } });
  showToast('Reset to default order.');
});

// ==================================================================== INIT
async function init() {
  try {
    const me = await api('/me');
    document.getElementById('adminName').textContent = me.displayName;
  } catch (e) { return; }
  loadDashboard();
}
init();
