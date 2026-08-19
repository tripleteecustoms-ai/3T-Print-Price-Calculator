// public/admin/js/admin.js — 3T Print Solutions Admin Dashboard (SPA)

async function api(path, opts) {
  const resp = await fetch('/api/admin' + path, {
    method: opts?.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
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

const STATUS_OPTIONS = ['draft','quote_generated','quote_viewed','checkout_started','paid','needs_review','artwork_issue','awaiting_customer','approved','in_production','ready_for_pickup','shipped','completed','cancelled','refunded'];
const MARGIN_BADGE = { STRONG: 'badge-green', ACCEPTABLE: 'badge-teal', CAUTION: 'badge-amber', LOW_MARGIN: 'badge-red' };
const STATUS_BADGE = (s) => {
  if (['paid','approved','completed'].includes(s)) return 'badge-green';
  if (['needs_review','artwork_issue','awaiting_customer'].includes(s)) return 'badge-amber';
  if (['cancelled','refunded'].includes(s)) return 'badge-red';
  if (['in_production','ready_for_pickup','shipped'].includes(s)) return 'badge-teal';
  return 'badge-gray';
};

// ------------------------------------------------------------------- nav
const PANEL_TITLES = { dashboard:'Dashboard', quotes:'Quotes', orders:'Paid Orders', customers:'Customers', garments:'Garments', pricing:'Pricing', locations:'Print Locations', artwork:'Artwork', settings:'Settings' };
document.querySelectorAll('.admin-nav-item[data-panel]').forEach(item => {
  item.addEventListener('click', () => switchPanel(item.dataset.panel));
});
function switchPanel(panel) {
  document.querySelectorAll('.admin-nav-item[data-panel]').forEach(i => i.classList.toggle('active', i.dataset.panel === panel));
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === panel));
  document.getElementById('panelTitle').textContent = PANEL_TITLES[panel];
  const loader = { dashboard: loadDashboard, quotes: loadQuotes, orders: loadOrders, customers: loadCustomers, garments: loadGarments, pricing: loadPricing, locations: loadLocations, artwork: loadArtwork, settings: loadSettings }[panel];
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
    quotesFilterInit = true;
  }
  fetchQuotes();
}
async function fetchQuotes() {
  const q = document.getElementById('quotesSearch').value;
  const status = document.getElementById('quotesStatusFilter').value;
  const params = new URLSearchParams(); if (q) params.set('q', q); if (status) params.set('status', status);
  const { quotes } = await api('/quotes?' + params.toString());
  document.getElementById('quotesBody').innerHTML = quotes.map(q => `
    <tr class="clickable" data-open-quote="${q.quoteCode}">
      <td><strong>${q.quoteCode}</strong></td>
      <td>${esc(q.customerName)}<div class="muted" style="font-size:11px;">${esc(q.email)}</div></td>
      <td>${q.totalQty ?? '—'}</td>
      <td>${money(q.total)}</td>
      <td>${q.marginStatus ? `<span class="badge ${MARGIN_BADGE[q.marginStatus]}">${q.marginStatus.replace('_',' ')}</span>` : '—'}</td>
      <td><span class="badge ${STATUS_BADGE(q.status)}">${q.status.replace(/_/g,' ')}</span></td>
      <td>${fmtDate(q.createdAt)}</td>
    </tr>`).join('') || `<tr><td colspan="7" class="muted">No quotes match.</td></tr>`;
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
  const { quote, customer, items, printLocations, artwork, events, pricing } = data;
  const marginBadge = pricing.internal ? `<span class="badge ${MARGIN_BADGE[pricing.internal.marginStatus]}">${pricing.internal.marginStatus.replace('_',' ')}</span>` : '';

  const colorGroups = {};
  for (const it of items) { colorGroups[it.color_name] = colorGroups[it.color_name] || []; colorGroups[it.color_name].push(it); }

  const body = `
    <div class="flex-between mt-8" style="margin-bottom:14px;">
      <span class="badge ${STATUS_BADGE(quote.status)}">${quote.status.replace(/_/g,' ')}</span>
      ${marginBadge}
    </div>

    <div class="detail-grid" style="margin-bottom:18px;">
      <div class="detail-item"><div class="dl">Customer</div><div class="dv">${esc(customer.first_name)} ${esc(customer.last_name)}</div></div>
      <div class="detail-item"><div class="dl">Email / Phone</div><div class="dv" style="font-weight:600;">${esc(customer.email)} · ${esc(customer.phone)}</div></div>
      <div class="detail-item"><div class="dl">Garment</div><div class="dv">${esc(pricing.garment.name)}</div></div>
      <div class="detail-item"><div class="dl">Quantity</div><div class="dv">${pricing.totalQty}</div></div>
      <div class="detail-item"><div class="dl">Fulfillment</div><div class="dv">${quote.fulfillment_method}</div></div>
      <div class="detail-item"><div class="dl">Needed By</div><div class="dv">${fmtDate(quote.needed_by_date)}</div></div>
      ${quote.event_name ? `<div class="detail-item"><div class="dl">Order For</div><div class="dv">${esc(quote.event_name)}</div></div>` : ''}
    </div>

    <h3>Size Breakdown</h3>
    ${Object.entries(colorGroups).map(([name, list]) => `
      <div style="margin-bottom:8px;font-size:13px;"><strong>${esc(name)}:</strong> ${list.map(i => `${i.size_label}${i.unit_surcharge>0?` (+${money(i.unit_surcharge)})`:''} × ${i.quantity}`).join(', ')}</div>
    `).join('')}

    <h3 class="mt-16">Print Locations &amp; Artwork</h3>
    ${printLocations.map(loc => {
      const files = artwork.filter(a => a.location_name === loc.location_name);
      return `<div class="print-detail-row">
        ${files[0] ? `<img class="thumb-40" src="${files[0].url}" onerror="this.style.display='none'">` : ''}
        <div style="flex:1;">
          <div class="pd-name">${esc(loc.location_name)} — ${loc.addon_price_each > 0 ? money(loc.addon_price_each)+'/shirt' : 'included'}</div>
          ${files.length ? files.map(f => `<div class="pd-file">${esc(f.original_filename)} · <select data-artwork-status="${f.id}">${['pending_review','approved','needs_changes','customer_revision_requested','production_ready'].map(s=>`<option value="${s}" ${s===f.status?'selected':''}>${s.replace(/_/g,' ')}</option>`).join('')}</select></div>`).join('') : `<div class="pd-file muted">No artwork uploaded</div>`}
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
    <tr><td>${esc(c.first_name)} ${esc(c.last_name)}${c.business_name ? `<div class="muted" style="font-size:11px;">${esc(c.business_name)}</div>`:''}</td>
    <td>${esc(c.email)}</td><td>${esc(c.phone)}</td><td>${c.quote_count}</td><td>${c.order_count}</td><td>${money(c.lifetime_value)}</td></tr>
  `).join('') || `<tr><td colspan="6" class="muted">No customers yet.</td></tr>`;
}

// ==================================================================== GARMENTS
async function loadGarments() {
  const { garments } = await api('/garments');
  document.getElementById('garmentsList').innerHTML = garments.map(g => garmentCardHtml(g)).join('');
  garments.forEach(g => bindGarmentCard(g));
}
function garmentCardHtml(g) {
  return `<div class="admin-card" data-garment-id="${g.id}">
    <div class="field-row">
      <div class="field"><label>Name</label><input type="text" class="g-name" value="${esc(g.name)}"></div>
      <div class="field"><label>Brand</label><input type="text" class="g-brand" value="${esc(g.brand||'')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Style Number</label><input type="text" class="g-style" value="${esc(g.style_number||'')}"></div>
      <div class="field"><label>Image URL</label><input type="text" class="g-image" value="${esc(g.image_url||'')}"></div>
    </div>
    <div class="field"><label>Description</label><textarea class="g-desc">${esc(g.description||'')}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Internal Cost (0 = use global blank cost)</label><input type="number" step="0.01" class="g-cost" value="${g.internal_cost}"></div>
      <div class="field"><label>Customer Price Adjustment (+/-)</label><input type="number" step="0.01" class="g-adj" value="${g.customer_price_adjustment}"></div>
    </div>
    <label style="font-size:13px;font-weight:700;"><input type="checkbox" class="g-active" ${g.active ? 'checked' : ''}> Active</label>

    <h3 class="mt-16">Colors</h3>
    <div class="color-editor-list">${g.colors.map(c => colorRowHtml(c)).join('')}</div>
    <button class="btn btn-outline btn-sm mt-8 add-color-btn">+ Add Color</button>

    <h3 class="mt-16">Sizes &amp; Surcharges</h3>
    <div class="size-editor-list">${g.sizes.map(s => sizeRowHtml(s)).join('')}</div>
    <button class="btn btn-outline btn-sm mt-8 add-size-btn">+ Add Size</button>

    <div class="action-btn-row">
      <button class="btn btn-dark btn-sm save-garment-btn">Save Garment</button>
      <button class="btn btn-danger btn-sm deactivate-garment-btn">Deactivate</button>
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
      styleNumber: card.querySelector('.g-style').value, imageUrl: card.querySelector('.g-image').value,
      description: card.querySelector('.g-desc').value, internalCost: card.querySelector('.g-cost').value,
      customerPriceAdjustment: card.querySelector('.g-adj').value, active: card.querySelector('.g-active').checked,
    }});
    showToast('Garment saved.');
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
  await api('/garments', { method: 'POST', body: { name: 'New Garment' } });
  loadGarments();
});

// ==================================================================== PRICING
async function loadPricing() {
  const [{ costs }, { tiers }] = await Promise.all([api('/cost-settings'), api('/pricing-tiers')]);
  document.getElementById('costBlank').value = costs.blank_cost;
  document.getElementById('costFront').value = costs.front_transfer_cost;
  document.getElementById('costLabor').value = costs.labor_cost;
  document.getElementById('costBack').value = costs.back_transfer_cost;

  const table = document.getElementById('pricingTable');
  table.innerHTML = `<tr><th>Qty</th><th>Standard Price</th><th>Hard Floor</th></tr>` + tiers.map(t => `
    <tr data-qty="${t.quantity}">
      <td>${t.quantity}</td>
      <td><input type="number" step="0.01" class="tier-standard" value="${t.standard_price}"></td>
      <td><input type="number" step="0.01" class="tier-floor" value="${t.hard_floor_price}"></td>
    </tr>`).join('');
}
document.getElementById('saveCostsBtn').addEventListener('click', async () => {
  await api('/cost-settings', { method: 'PUT', body: {
    blank_cost: document.getElementById('costBlank').value, front_transfer_cost: document.getElementById('costFront').value,
    labor_cost: document.getElementById('costLabor').value, back_transfer_cost: document.getElementById('costBack').value,
  }});
  showToast('Cost settings saved.');
});
document.getElementById('savePricingBtn').addEventListener('click', async () => {
  const rows = document.querySelectorAll('#pricingTable tr[data-qty]');
  for (const row of rows) {
    const qty = row.dataset.qty;
    const standardPrice = row.querySelector('.tier-standard').value;
    const hardFloorPrice = row.querySelector('.tier-floor').value;
    await api(`/pricing-tiers/${qty}`, { method: 'PUT', body: { standardPrice, hardFloorPrice } });
  }
  showToast('Pricing matrix saved. Existing quotes keep their original snapshot.');
});

// ==================================================================== PRINT LOCATIONS
async function loadLocations() {
  const { printLocations } = await api('/print-locations');
  document.getElementById('locationsList').innerHTML = printLocations.map(l => `
    <div class="admin-card" data-loc-id="${l.id}">
      <div class="field-row">
        <div class="field"><label>Name</label><input type="text" class="l-name" value="${esc(l.name)}"></div>
        <div class="field"><label>Internal Cost / Unit</label><input type="number" step="0.01" class="l-cost" value="${l.internal_cost_per_unit}"></div>
      </div>
      <label style="font-size:13px;font-weight:700;margin-right:16px;"><input type="checkbox" class="l-included" ${l.included_in_base?'checked':''}> Included in base price (e.g. Front)</label>
      <label style="font-size:13px;font-weight:700;"><input type="checkbox" class="l-active" ${l.active?'checked':''}> Active</label>
      <div class="action-btn-row"><button class="btn btn-dark btn-sm save-loc-btn">Save</button>
        <button class="btn btn-outline btn-sm toggle-matrix-btn">Edit Pricing Matrix (1–24)</button></div>
      <div class="matrix-editor hidden mt-16">
        <div class="admin-table-wrap"><table class="pricing-grid-table"><tr>${l.pricing.map(p=>`<th>${p.quantity}</th>`).join('')}</tr>
        <tr>${l.pricing.map(p=>`<td><input type="number" step="0.01" class="addon-input" data-qty="${p.quantity}" value="${p.addon_price}" style="width:64px;"></td>`).join('')}</tr></table></div>
        <button class="btn btn-dark btn-sm mt-8 save-matrix-btn">Save Matrix</button>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('[data-loc-id]').forEach(card => {
    const id = card.dataset.locId;
    card.querySelector('.save-loc-btn').addEventListener('click', async () => {
      await api(`/print-locations/${id}`, { method: 'PUT', body: {
        name: card.querySelector('.l-name').value, internalCostPerUnit: card.querySelector('.l-cost').value,
        includedInBase: card.querySelector('.l-included').checked, active: card.querySelector('.l-active').checked,
      }});
      showToast('Print location saved.');
    });
    card.querySelector('.toggle-matrix-btn').addEventListener('click', () => card.querySelector('.matrix-editor').classList.toggle('hidden'));
    card.querySelector('.save-matrix-btn').addEventListener('click', async () => {
      const inputs = card.querySelectorAll('.addon-input');
      for (const input of inputs) await api(`/print-locations/${id}/pricing/${input.dataset.qty}`, { method: 'PUT', body: { addonPrice: input.value } });
      showToast('Pricing matrix saved.');
    });
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
  document.getElementById('artworkGrid').innerHTML = artwork.map(f => `
    <div class="option-card" style="cursor:default;">
      <img src="${f.url}" onerror="this.style.display='none'" style="aspect-ratio:1/1;object-fit:cover;border-radius:6px;">
      <div class="oc-title" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.original_filename)}</div>
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

// ==================================================================== SETTINGS
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('hidden', t.dataset.tab !== btn.dataset.tab));
  if (btn.dataset.tab === 'email') fetchEmails();
}));
async function loadSettings() {
  const { settings } = await api('/settings');
  document.getElementById('settingBusinessName').value = settings.business_name || '';
  document.getElementById('settingBusinessEmail').value = settings.business_email || '';
  document.getElementById('settingExpirationDays').value = settings.quote_expiration_days || 7;
  document.getElementById('settingPaymentProvider').value = settings.payment_provider || 'mock';
  document.getElementById('settingShopifyDomain').value = settings.shopify_shop_domain || '';
  document.getElementById('settingShopifyToken').value = settings.shopify_admin_token || '';
  document.getElementById('settingEmailProvider').value = settings.email_provider || 'mock';
}
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
    shopify_admin_token: document.getElementById('settingShopifyToken').value,
  }});
  showToast('Saved.');
});
document.getElementById('saveEmailBtn').addEventListener('click', async () => {
  await api('/settings', { method: 'PUT', body: { email_provider: document.getElementById('settingEmailProvider').value } });
  showToast('Saved.');
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

// ==================================================================== INIT
async function init() {
  try {
    const me = await api('/me');
    document.getElementById('adminName').textContent = me.displayName;
  } catch (e) { return; }
  loadDashboard();
}
init();
