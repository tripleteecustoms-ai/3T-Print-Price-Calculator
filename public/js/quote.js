// public/js/quote.js — Customer Quote / Order Review page

const params = new URLSearchParams(location.search);
const quoteCode = params.get('id');
let currentQuote = null;

async function api(path, opts) {
  const resp = await fetch('/api' + path, {
    method: opts?.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data, status: resp.status });
  return data;
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toastHost').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function fmtDate(d) { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
function money(n) { return '$' + Number(n).toFixed(2); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const STATUS_DISPLAY = {
  quote_generated: { label: 'Ready to Order', cls: 'badge-green' },
  quote_viewed: { label: 'Ready to Order', cls: 'badge-green' },
  checkout_started: { label: 'Checkout Started', cls: 'badge-teal' },
  needs_review: { label: 'Under Review', cls: 'badge-amber' },
  awaiting_customer: { label: 'Awaiting Your Response', cls: 'badge-amber' },
  paid: { label: 'Paid', cls: 'badge-green' },
  expired: { label: 'Expired', cls: 'badge-red' },
};

async function load() {
  if (!quoteCode) { document.getElementById('loadingState').innerHTML = '<p class="text-center mt-24">No quote specified.</p>'; return; }
  try {
    const data = await api(`/quotes/${encodeURIComponent(quoteCode)}`);
    currentQuote = data;

    if (data.quote.paidAt) {
      window.location.href = `/order-received.html?id=${encodeURIComponent(quoteCode)}`;
      return;
    }

    if (data.quote.isExpired) {
      document.getElementById('loadingState').classList.add('hidden');
      document.getElementById('expiredState').classList.remove('hidden');
      return;
    }

    render(data);
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('quoteState').classList.remove('hidden');
  } catch (err) {
    document.getElementById('loadingState').innerHTML = `<p class="text-center mt-24">${err.message || 'Could not load this quote.'}</p>`;
  }
}

function render(data) {
  const { quote, customer, garment, items, printLocations, artwork, pricing } = data;

  document.getElementById('quoteCode').textContent = '#' + quote.code;
  document.getElementById('quoteDate').textContent = fmtDate(quote.createdAt);
  document.getElementById('quoteExpires').textContent = fmtDate(quote.expiresAt);

  const status = STATUS_DISPLAY[quote.status] || { label: quote.status.replace(/_/g, ' '), cls: 'badge-gray' };
  const badge = document.getElementById('statusBadge');
  badge.textContent = status.label;
  badge.className = 'badge ' + status.cls;

  const bannerHost = document.getElementById('statusBannerHost');
  bannerHost.innerHTML = '';
  if (quote.status === 'needs_review') {
    bannerHost.innerHTML = `<div class="status-banner review">Your order is with our team for review. We'll follow up shortly — feel free to pay now or wait to hear from us.</div>`;
  }

  document.getElementById('customerDetails').innerHTML = `
    ${detailItem('Name', `${customer.firstName} ${customer.lastName}`)}
    ${customer.businessName ? detailItem('Business', customer.businessName) : ''}
    ${detailItem('Email', customer.email)}
    ${detailItem('Phone', customer.phone)}
    ${quote.neededByDate ? detailItem('Needed By', fmtDate(quote.neededByDate)) : ''}
    ${detailItem('Fulfillment', quote.fulfillmentMethod === 'shipping' ? 'Shipping' : 'Local Pickup')}
    ${quote.orderPurpose ? detailItem('Order For', quote.orderPurpose) : ''}
  `;

  const colorGroups = {};
  for (const it of items) {
    colorGroups[it.color_name] = colorGroups[it.color_name] || { hex: it.color_hex, sizes: [] };
    colorGroups[it.color_name].sizes.push(it);
  }
  document.getElementById('garmentSummary').innerHTML = `
    <div class="garment-summary">
      <img src="${garment.imageUrl || ''}" onerror="this.style.display='none'">
      <div>
        <div class="gs-name">${garment.name}</div>
        <div class="muted" style="font-size:13px;margin-top:2px;">Total Quantity: ${pricing.totalQty}</div>
        ${Object.entries(colorGroups).map(([colorName, g]) => `
          <div style="margin-top:10px;">
            <div style="font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px;">
              <span style="width:14px;height:14px;border-radius:50%;background:${g.hex || '#ccc'};display:inline-block;border:1px solid #ddd;"></span>${colorName}
            </div>
            <div class="size-chip-row">${g.sizes.map(s => `<span class="size-chip">${s.size_label} – ${s.quantity}</span>`).join('')}</div>
          </div>`).join('')}
      </div>
    </div>`;

  document.getElementById('printDetails').innerHTML = printLocations.map(loc => {
    const files = artwork.filter(a => a.locationName === loc.location_name);
    const designSizeLabel = loc.design_size === 'oversized' ? 'Oversized' : (loc.design_size === 'large' ? 'Large Graphic' : null);
    return `<div class="print-detail-row">
      ${files[0] ? `<img src="${files[0].url}" onerror="this.style.display='none'">` : ''}
      <div style="flex:1;">
        <div class="pd-name">${loc.location_name}${loc.included_in_base ? ' (Included)' : ''}${designSizeLabel ? ` · ${designSizeLabel}` : ''}</div>
        ${files.length ? files.map(f => `<div class="pd-file">${f.filename}</div>`).join('') : `<div class="pd-file">No artwork uploaded</div>`}
      </div>
    </div>`;
  }).join('');

  document.getElementById('itemizedPricing').innerHTML = renderReceipt(pricing);
  renderDiscountBox(pricing);

  updatePayEnabled();
}

function renderDiscountBox(pricing) {
  const host = document.getElementById('discountHost');
  if (pricing.discount) {
    host.innerHTML = `<div class="detail-item" style="display:flex;justify-content:space-between;align-items:center;">
      <div class="dv">Code <strong>${esc(pricing.discount.code)}</strong> applied (-${money(pricing.discountAmount)})</div>
      <button type="button" class="btn btn-ghost btn-sm" id="removeDiscountBtn" style="text-decoration:underline;">Remove</button>
    </div>`;
    document.getElementById('removeDiscountBtn').addEventListener('click', removeDiscount);
  } else {
    host.innerHTML = `<div class="field mb-0">
      <label>Have a discount code?</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="discountCodeInput" placeholder="Enter code" style="text-transform:uppercase;flex:1;">
        <button type="button" class="btn btn-outline btn-sm" id="applyDiscountBtn" style="white-space:nowrap;">Apply</button>
      </div>
    </div>`;
    document.getElementById('applyDiscountBtn').addEventListener('click', applyDiscount);
    document.getElementById('discountCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyDiscount(); });
  }
}

async function applyDiscount() {
  const input = document.getElementById('discountCodeInput');
  const code = input.value.trim();
  if (!code) { showToast('Enter a discount code.'); return; }
  const btn = document.getElementById('applyDiscountBtn');
  btn.disabled = true;
  btn.textContent = 'Applying…';
  try {
    const { pricing } = await api(`/quotes/${quoteCode}/apply-discount`, { method: 'POST', body: { code } });
    showToast('Discount applied.');
    document.getElementById('itemizedPricing').innerHTML = renderReceipt(pricing);
    renderDiscountBox(pricing);
  } catch (err) {
    showToast(err.message || 'Could not apply that discount code.');
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
}

async function removeDiscount() {
  const btn = document.getElementById('removeDiscountBtn');
  btn.disabled = true;
  try {
    const { pricing } = await api(`/quotes/${quoteCode}/remove-discount`, { method: 'POST', body: {} });
    document.getElementById('itemizedPricing').innerHTML = renderReceipt(pricing);
    renderDiscountBox(pricing);
    showToast('Discount removed.');
  } catch (err) {
    showToast(err.message || 'Could not remove the discount.');
    btn.disabled = false;
  }
}

function detailItem(label, value) {
  return `<div class="detail-item"><div class="dl">${label}</div><div class="dv">${value}</div></div>`;
}

function renderReceipt(pricing) {
  let html = `<div class="receipt-line">
    <span class="rl-label">${pricing.totalQty} × ${pricing.garment.name}<span class="rl-sub">${pricing.totalQty} × ${money(pricing.finalBaseUnit)}</span></span>
    <span class="rl-amt">${money(pricing.baseLineTotal)}</span></div>`;
  for (const line of pricing.addonLines) {
    html += `<div class="receipt-line"><span class="rl-label">${line.name}<span class="rl-sub">${line.qty} × ${money(line.each)}</span></span><span class="rl-amt">${money(line.total)}</span></div>`;
  }
  if (pricing.sizeSurchargeTotal > 0) {
    const labels = [...new Set(pricing.surchargedLines.map(l => l.sizeLabel))].join('/');
    html += `<div class="receipt-line"><span class="rl-label">${labels} Size Adjustments</span><span class="rl-amt">${money(pricing.sizeSurchargeTotal)}</span></div>`;
  }
  for (const line of (pricing.designSizeLines || [])) {
    html += `<div class="receipt-line"><span class="rl-label">${line.locationName} — ${line.designSizeLabel}<span class="rl-sub">${line.qty} × ${money(line.each)}</span></span><span class="rl-amt">${money(line.total)}</span></div>`;
  }
  html += `<div class="receipt-line"><span class="rl-label">Subtotal</span><span class="rl-amt">${money(pricing.subtotal)}</span></div>`;
  if (pricing.discount) {
    html += `<div class="receipt-line"><span class="rl-label">Discount (${esc(pricing.discount.code)})</span><span class="rl-amt">-${money(pricing.discountAmount)}</span></div>`;
  }
  html += `<div class="receipt-line"><span class="rl-label">Shipping</span><span class="rl-amt muted">Calculated at checkout</span></div>`;
  html += `<div class="receipt-line" style="border-bottom:none;"><span class="rl-label">Taxes</span><span class="rl-amt muted">Calculated at checkout</span></div>`;
  html += `<div class="receipt-total"><span class="rt-label">Estimated Order Total</span><span class="rt-amt">${money(pricing.total)}</span></div>`;
  return html;
}

document.getElementById('termsCheckbox').addEventListener('change', updatePayEnabled);
function updatePayEnabled() {
  document.getElementById('payBtn').disabled = !document.getElementById('termsCheckbox').checked;
}

document.getElementById('payBtn').addEventListener('click', async () => {
  if (!document.getElementById('termsCheckbox').checked) return;
  const btn = document.getElementById('payBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Starting checkout…';
  try {
    await api(`/quotes/${quoteCode}/checkout-started`, { method: 'POST', body: {} });
    if (window.track3T) window.track3T('checkout_started', { quoteCode });
    const result = await api(`/quotes/${quoteCode}/checkout`, { method: 'POST', body: { termsAccepted: true } });
    // Use window.top (not window) so this always escapes to the full browser
    // tab rather than staying nested inside an iframe. This matters once the
    // builder is embedded on another site: Shopify's real checkout page (and
    // most payment providers) refuse to load inside someone else's iframe as
    // a security measure, so without this the Pay step would look broken.
    // A no-op when the page isn't embedded — window.top === window then.
    window.top.location.href = result.checkoutUrl;
  } catch (err) {
    if (err.data?.error === 'QUOTE_EXPIRED') {
      document.getElementById('quoteState').classList.add('hidden');
      document.getElementById('expiredState').classList.remove('hidden');
    } else {
      showToast(err.message || 'Could not start checkout.');
      btn.disabled = false;
      btn.textContent = 'Confirm Order';
    }
  }
});

document.getElementById('reviewBtn').addEventListener('click', async () => {
  try {
    await api(`/quotes/${quoteCode}/request-review`, { method: 'POST', body: {} });
    showToast('Sent to our team for review. We will follow up shortly.');
    await load();
  } catch (err) { showToast(err.message); }
});

document.getElementById('recalcBtn').addEventListener('click', async () => {
  try {
    await api(`/quotes/${quoteCode}/recalculate`, { method: 'POST', body: {} });
    location.reload();
  } catch (err) { showToast(err.message); }
});

document.getElementById('editBtn').addEventListener('click', editOrder);

async function editOrder() {
  try {
    const [{ garments }, locData] = await Promise.all([
      api('/garments'),
      api(`/print-locations?qty=${currentQuote.pricing.totalQty}`),
    ]);
    const garment = garments.find(g => g.id === currentQuote.garment.id);
    if (!garment) { showToast('This garment is no longer available to edit online — please request a review instead.'); return; }

    const selectedColors = [];
    const sizesByColor = {};
    const colorNames = [...new Set(currentQuote.items.map(i => i.color_name))];
    colorNames.forEach((name, idx) => {
      const match = garment.colors.find(c => c.name.toLowerCase() === name.toLowerCase());
      const id = match ? match.id : `custom_${idx}`;
      const hex = match ? match.hex : (currentQuote.items.find(i => i.color_name === name)?.color_hex || '#000000');
      selectedColors.push({ id, name, hex });
      sizesByColor[id] = {};
      currentQuote.items.filter(i => i.color_name === name).forEach(i => { sizesByColor[id][i.size_label] = i.quantity; });
    });

    const designSizes = {};
    const selectedLocationIds = currentQuote.printLocations.map(loc => {
      const match = locData.printLocations.find(l => l.name.toLowerCase() === loc.location_name.toLowerCase());
      if (match) designSizes[match.code] = loc.design_size || 'standard';
      return match ? match.id : null;
    }).filter(Boolean);

    const c = currentQuote.customer;
    const q = currentQuote.quote;
    const state = {
      stepIndex: 0,
      draftToken: null,
      garments: [],
      selectedGarmentId: garment.id,
      selectedColors,
      sizesByColor,
      garmentSizes: garment.sizes,
      printLocations: [],
      selectedLocationIds,
      uploads: {},
      designSizes,
      designNotes: q.designNotes || '',
      contact: {
        firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone,
        businessName: c.businessName || '',
        orderPurposes: (q.orderPurpose || '').split(',').map(s => s.trim()).filter(Boolean),
        neededByDate: q.neededByDate || '',
        additionalNotes: q.notes || '', fulfillmentMethod: q.fulfillmentMethod || 'pickup',
      },
      estimate: null,
      businessInfo: null,
    };
    sessionStorage.setItem('3t_builder_state', JSON.stringify(state));
    window.location.href = '/index.html';
  } catch (err) {
    showToast('Could not load your order for editing.');
  }
}

load();
