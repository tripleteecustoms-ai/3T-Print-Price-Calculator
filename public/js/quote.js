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
  deposit_paid: { label: 'Deposit Paid', cls: 'badge-teal' },
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
    startPaymentWatch();
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
  if (quote.isLargeOrder) {
    bannerHost.innerHTML = `<div class="status-banner review">Your order has been submitted for production and inventory review. You'll receive a confirmed invoice within one business day.</div>`;
  } else if (quote.awaitingGarmentConfirmation) {
    bannerHost.innerHTML = `<div class="status-banner review">Thanks! We're confirming your garment and final price. We'll reach out shortly; no payment is needed yet.</div>`;
  } else if (quote.status === 'needs_review') {
    bannerHost.innerHTML = `<div class="status-banner review">Your order is with our team for review. We'll follow up shortly — feel free to pay now or wait to hear from us.</div>`;
  }

  // Orders of 1,001+ pieces never go through instant checkout — swap the
  // payment card for a static confirmation instead (see server/routes/
  // customer.js POST /quotes/:code/checkout, which also refuses these
  // server-side as defense in depth).
  // "Other / Not Listed" garments wait the same way until the owner confirms the price.
  const holdCheckout = !!(quote.isLargeOrder || quote.awaitingGarmentConfirmation);
  document.getElementById('largeOrderCard').classList.toggle('hidden', !holdCheckout);
  document.getElementById('termsCard').classList.toggle('hidden', holdCheckout);
  document.getElementById('checkoutOptionsCard').classList.toggle('hidden', holdCheckout);
  // A customer who came through the builder already chose Rush and agreed to
  // the final order review there, so neither is asked again here.
  if (quote.reviewAgreed) {
    document.getElementById('rushRow').classList.add('hidden');
    document.getElementById('termsRow').classList.add('hidden');
    document.getElementById('termsCheckbox').checked = true;
    updatePayEnabled();
  }
  if (quote.awaitingGarmentConfirmation) {
    document.querySelector('#largeOrderCard h2').textContent = 'Confirming Your Garment';
    document.getElementById('largeOrderConfirmText').textContent = "We'll confirm the garment you asked for and send your final price. You can pay once it's confirmed.";
    document.querySelector('#largeOrderCard p.muted').textContent = 'The total above is an estimate based on a standard tee. No payment is needed yet.';
  }
  if (quote.isLargeOrder) {
    document.getElementById('largeOrderConfirmText').textContent =
      "Your order has been submitted for production and inventory review. You'll receive a confirmed invoice within one business day.";
  }

  document.getElementById('customerDetails').innerHTML = `
    ${detailItem('Name', `${customer.firstName} ${customer.lastName}`)}
    ${customer.businessName ? detailItem('Business', customer.businessName) : ''}
    ${detailItem('Email', customer.email)}
    ${detailItem('Phone', customer.phone)}
    ${quote.neededByDate ? detailItem('Needed By', fmtDate(quote.neededByDate)) : ''}
    ${detailItem('Fulfillment', quote.fulfillmentMethod === 'shipping'
      ? `Shipping${quote.shippingAddress ? `<br><span style="font-weight:400;">${esc(quote.shippingAddress.line1)}${quote.shippingAddress.line2 ? ', ' + esc(quote.shippingAddress.line2) : ''}, ${esc(quote.shippingAddress.city)}, ${esc(quote.shippingAddress.state)} ${esc(quote.shippingAddress.zip)}</span>` : ''}`
      : 'Local Pickup')}
    ${quote.orderPurpose ? detailItem('Order For', quote.orderPurpose) : ''}
  `;

  // Sticker / poster / mylar orders have a size and options instead of
  // garment colors, sizes and print locations.
  if (pricing.printOrder) {
    renderPrintOrder(pricing.printOrder, quote, artwork);
    renderTotals(pricing, data.checkout);
    renderDiscountBox(pricing);
    updatePayEnabled();
    return;
  }

  const colorGroups = {};
  for (const it of items) {
    colorGroups[it.color_name] = colorGroups[it.color_name] || { hex: it.color_hex, sizes: [] };
    colorGroups[it.color_name].sizes.push(it);
  }
  document.getElementById('garmentSummary').innerHTML = `
    <div class="garment-summary">
      <img src="${garment.imageUrl || ''}" onerror="this.style.display='none'">
      <div>
        <div class="gs-name">${esc(garment.name)}</div>
        ${quote.customGarmentDescription ? `<div style="font-size:13px;font-weight:600;margin-top:2px;white-space:pre-wrap;">${esc(quote.customGarmentDescription)}</div>` : ''}
        ${quote.customerSuppliedGarment ? '<div class="muted" style="font-size:13px;margin-top:2px;">You are supplying the garments.</div>' : ''}
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
    const designSizeLabel = { oversized: 'Oversized', large: 'Large Graphic', chest: 'Left Chest size' }[loc.design_size] || null;
    const placementIndex = (quote.placements || []).findIndex(p => p.locationName === loc.location_name);
    return `<div class="print-detail-row" style="align-items:flex-start;">
      ${files[0] ? `<img src="${files[0].url}" onerror="this.style.display='none'">` : ''}
      <div style="flex:1;">
        <div class="pd-name">${loc.location_name}${loc.included_in_base ? ' (Included)' : ''}${designSizeLabel ? ` · ${designSizeLabel}` : ''}</div>
        ${files.length ? files.map(f => `<div class="pd-file">${f.filename}</div>`).join('') : `<div class="pd-file">No artwork uploaded</div>`}
        ${placementIndex >= 0 ? `<div class="pl-static" data-placement="${placementIndex}"></div>` : ''}
      </div>
    </div>`;
  }).join('');
  // Reference images (examples the customer shared; not print artwork).
  const references = artwork.filter(a => a.locationName === 'Reference');
  if (references.length) {
    document.getElementById('printDetails').insertAdjacentHTML('beforeend', `<div class="print-detail-row" style="align-items:flex-start;">
      <div style="flex:1;"><div class="pd-name">Reference images</div>
        ${references.map(f => `<div class="pd-file"><a href="${f.url}" target="_blank" rel="noopener" style="color:inherit;">${f.filename}</a></div>`).join('')}
        <div class="pd-file">For reference only. These are not printed as-is.</div></div>
    </div>`);
  }
  // The placement the customer chose in the builder: a guide for pre-production.
  document.querySelectorAll('#printDetails [data-placement]').forEach(el => {
    if (window.Placement) Placement.renderStatic(el, quote.placements[Number(el.dataset.placement)]);
  });

  renderTotals(pricing, data.checkout);
  renderDiscountBox(pricing);

  updatePayEnabled();
}

function renderPrintOrder(order, quote, artwork) {
  document.querySelector('.site-header .tagline').textContent = order.familyName;
  const summary = document.getElementById('garmentSummary');
  summary.previousElementSibling.textContent = 'Product Summary';
  summary.innerHTML = `<div class="garment-summary"><div>
      <div class="gs-name">${esc(order.productName)}</div>
      <div class="size-chip-row" style="margin-top:8px;">
        <span class="size-chip">${esc(order.sizeLabel)}</span>
        <span class="size-chip">Quantity: ${order.qty}</span>
        ${order.orientation ? `<span class="size-chip">${order.orientation === 'landscape' ? 'Landscape' : 'Portrait'}</span>` : ''}
        ${(order.options || []).map(o => `<span class="size-chip">${esc(o.group)}: ${esc(o.choice)}</span>`).join('')}
        ${order.design ? `<span class="size-chip">${esc(order.design.methodLabel)}${order.design.templateName ? `: ${esc(order.design.templateName)}` : ''}</span>` : ''}
        ${order.design && order.design.logoLabel ? `<span class="size-chip">Logo: ${esc(order.design.logoLabel)}</span>` : ''}
        ${order.addons.map(a => `<span class="size-chip">${esc(a.name)}</span>`).join('')}
      </div>
    </div></div>`;
  const details = document.getElementById('printDetails');
  details.previousElementSibling.textContent = 'Artwork';
  details.innerHTML = artwork.length
    ? artwork.map(f => `<div class="print-detail-row" style="align-items:flex-start;">
        <img src="${esc(f.url)}" onerror="this.style.display='none'">
        <div style="flex:1;"><div class="pd-name">${esc(f.locationName || 'Artwork')}</div><div class="pd-file">${f.locationName === 'Approved Mockup'
          ? `<a href="${esc(f.url)}" target="_blank" rel="noopener" style="color:inherit;">View Approved Mockup</a>` : esc(f.filename)}</div></div>
      </div>`).join('')
    : `<div class="print-detail-row"><div style="flex:1;"><div class="pd-file">${order.design && order.design.method !== 'upload'
        ? "We'll create your artwork after checkout and send you a proof to approve."
        : 'No artwork uploaded yet. Reply to your quote email to send it.'}</div></div></div>`;
  if (quote.designNotes) {
    details.insertAdjacentHTML('beforeend', `<div class="print-detail-row"><div style="flex:1;"><div class="pd-name">Design notes</div><div class="pd-file" style="white-space:pre-wrap;">${esc(quote.designNotes)}</div></div></div>`);
  }
  // There is no way to reopen a print order in its builder; Request Review covers changes.
  document.getElementById('editBtn').classList.add('hidden');
}

// ---- checkout options: rush + full/deposit (server recalculates every total) ----
function renderTotals(pricing, checkout) {
  currentQuote.pricing = pricing;
  currentQuote.checkout = checkout;
  document.getElementById('itemizedPricing').innerHTML = renderReceipt(pricing, checkout);
  document.getElementById('rushCheckbox').checked = checkout.rush;
  document.getElementById('rushLabelDetail').textContent = `(+${checkout.rushFeePct}% of your order, ${money(Math.round(checkout.orderTotal * checkout.rushFeePct) / 100)})`;
  const group = document.getElementById('paymentOptionGroup');
  group.classList.toggle('hidden', !checkout.depositAvailable);
  // nothing left to choose in this card once Rush is hidden and there's no deposit option
  if (currentQuote.quote && currentQuote.quote.reviewAgreed && !checkout.depositAvailable) document.getElementById('checkoutOptionsCard').classList.add('hidden');
  document.querySelector(`input[name="paymentOption"][value="${checkout.paymentOption}"]`).checked = true;
  document.getElementById('payFullDetail').textContent = `(${money(checkout.grandTotal)} today)`;
  document.getElementById('depositLabel').textContent = `Pay a ${checkout.depositPct}% deposit`;
  document.getElementById('payDepositDetail').textContent = `(${money(Math.round(checkout.grandTotal * checkout.depositPct) / 100)} today)`;
  const payBtn = document.getElementById('payBtn');
  if (!payBtn.dataset.loading) payBtn.textContent = payButtonLabel(checkout);
}
function payButtonLabel(checkout) {
  return checkout.paymentOption === 'deposit'
    ? `Confirm Order & Pay ${money(checkout.amountDueNow)} Deposit`
    : `Confirm Order & Pay ${money(checkout.amountDueNow)}`;
}
async function saveCheckoutOptions(changes) {
  try {
    const { checkout } = await api(`/quotes/${quoteCode}/checkout-options`, { method: 'POST', body: changes });
    renderTotals(currentQuote.pricing, checkout);
  } catch (err) {
    showToast(err.message || 'Could not update your checkout options.');
    renderTotals(currentQuote.pricing, currentQuote.checkout);
  }
}
document.getElementById('rushCheckbox').addEventListener('change', (e) => saveCheckoutOptions({ rush: e.target.checked }));
document.querySelectorAll('input[name="paymentOption"]').forEach(r => r.addEventListener('change', (e) => {
  if (e.target.checked) saveCheckoutOptions({ paymentOption: e.target.value });
}));

// ---- live payment status ----
// Paying happens in Shopify (often another tab). While this page is open,
// check every 20s, and right away when the customer switches back to it;
// once the server sees the payment, show the order-received page.
let paymentWatchTimer = null;
function goToOrderReceived() { window.location.href = `/order-received.html?id=${encodeURIComponent(quoteCode)}`; }
async function checkPaymentNow() {
  try {
    const s = await api(`/quotes/${encodeURIComponent(quoteCode)}/payment-status`);
    if (s.paid) { clearInterval(paymentWatchTimer); goToOrderReceived(); }
  } catch (e) { /* offline or server busy: try again next tick */ }
}
function startPaymentWatch() {
  if (paymentWatchTimer || !currentQuote || currentQuote.quote.isLargeOrder) return;
  paymentWatchTimer = setInterval(() => { if (document.visibilityState === 'visible') checkPaymentNow(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkPaymentNow(); });
  window.addEventListener('pageshow', (e) => { // back button from Shopify restores this page as it was left
    if (!e.persisted) return;
    const btn = document.getElementById('payBtn');
    delete btn.dataset.loading;
    btn.textContent = payButtonLabel(currentQuote.checkout);
    updatePayEnabled();
    checkPaymentNow();
  });
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
      <label for="discountCodeInput">Have a discount code?</label>
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
    currentQuote.pricing = pricing;
    await saveCheckoutOptions({}); // re-total rush/tax/deposit on the discounted order
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
    currentQuote.pricing = pricing;
    await saveCheckoutOptions({});
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

function renderReceipt(pricing, checkout) {
  // A print order is one pack at a pack price, plus flat add-ons.
  const po = pricing.printOrder;
  let html = po
    ? `<div class="receipt-line">
    <span class="rl-label">${esc(po.productName)}<span class="rl-sub">${esc(po.sizeLabel)}, ${po.qty} × ${money(pricing.finalBaseUnit)}</span></span>
    <span class="rl-amt">${money(pricing.baseLineTotal)}</span></div>`
    : `<div class="receipt-line">
    <span class="rl-label">${pricing.totalQty} × ${pricing.garment.name}<span class="rl-sub">${pricing.totalQty} × ${money(pricing.finalBaseUnit)}</span></span>
    <span class="rl-amt">${money(pricing.baseLineTotal)}</span></div>`;
  for (const line of pricing.addonLines) {
    html += `<div class="receipt-line"><span class="rl-label">${line.name}${po && !line.perPiece ? '' : `<span class="rl-sub">${line.qty} × ${money(line.each)}</span>`}</span><span class="rl-amt">${money(line.total)}</span></div>`;
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
  if (checkout.rush) {
    html += `<div class="receipt-line"><span class="rl-label">Rush Fee<span class="rl-sub">${checkout.rushFeePct}% of order</span></span><span class="rl-amt">${money(checkout.rushFee)}</span></div>`;
  }
  html += `<div class="receipt-line"><span class="rl-label">Sales Tax<span class="rl-sub">${checkout.taxRatePct}%</span></span><span class="rl-amt">${money(checkout.taxAmount)}</span></div>`;
  if (currentQuote.quote.fulfillmentMethod === 'shipping') {
    html += `<div class="receipt-line"><span class="rl-label">Ground Shipping<span class="rl-sub">Flat rate</span></span><span class="rl-amt">${money(checkout.shippingFee)}</span></div>`;
  }
  html += `<div class="receipt-total"><span class="rt-label">Order Total</span><span class="rt-amt">${money(checkout.grandTotal)}</span></div>`;
  if (checkout.paymentOption === 'deposit') {
    html += `<div class="receipt-line"><span class="rl-label">Due today (${checkout.depositPct}% deposit)</span><span class="rl-amt">${money(checkout.amountDueNow)}</span></div>`;
    html += `<div class="receipt-line" style="border-bottom:none;"><span class="rl-label">Balance due before ${currentQuote.quote.fulfillmentMethod === 'shipping' ? 'shipping' : 'pickup'}</span><span class="rl-amt">${money(checkout.balanceDue)}</span></div>`;
  }
  if (pricing.quantityTier && pricing.quantityTier.checkoutBehavior === 'review') {
    html += `<div class="review-note" style="text-align:left;margin-top:8px;"><strong>Preliminary volume estimate</strong> - final pricing depends on garment inventory, freight and production scheduling.</div>`;
  }
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
  btn.dataset.loading = '1';
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
    if (err.data?.error === 'ALREADY_PAID') {
      goToOrderReceived();
    } else if (err.data?.error === 'QUOTE_EXPIRED') {
      document.getElementById('quoteState').classList.add('hidden');
      document.getElementById('expiredState').classList.remove('hidden');
    } else {
      showToast(err.message || 'Could not start checkout.');
      btn.disabled = false;
      delete btn.dataset.loading;
      btn.textContent = payButtonLabel(currentQuote.checkout);
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
      customGarmentDescription: q.customGarmentDescription || '',
      customerSuppliedGarment: !!q.customerSuppliedGarment,
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
    // The builder keeps its in-progress order in localStorage (see builder.js).
    localStorage.setItem('3t_builder_state', JSON.stringify({ ...state, savedAt: Date.now() }));
    window.location.href = '/index.html';
  } catch (err) {
    showToast('Could not load your order for editing.');
  }
}

load();
