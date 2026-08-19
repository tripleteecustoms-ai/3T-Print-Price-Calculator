// public/js/builder.js
// Customer Order Builder — step-by-step configurator. Every price shown is
// fetched from POST /api/estimate (server-calculated); nothing here is
// trusted as the final price. sessionStorage persists in-progress state.

const STEPS = ['garment', 'color', 'sizes', 'locations', 'artwork', 'contact'];
const STEP_LABELS = { garment: 'Garment', color: 'Color', sizes: 'Sizes', locations: 'Print', artwork: 'Artwork', contact: 'Info' };

const state = loadState() || {
  stepIndex: 0,
  draftToken: null,
  garments: [],
  selectedGarmentId: null,
  selectedColors: [],           // [{id, name, hex}]
  sizesByColor: {},             // { colorId: { SIZE: qty } }
  garmentSizes: [],             // [{label, surcharge}]
  printLocations: [],           // catalog (fetched per qty)
  selectedLocationIds: [],
  uploads: {},                  // { locationCode: [ {id, filename, url, sizeBytes} ] }
  designNotes: '',
  contact: { firstName:'', lastName:'', email:'', phone:'', businessName:'', orderPurposes:[], neededByDate:'', additionalNotes:'', fulfillmentMethod:'pickup' },
  estimate: null,
  businessInfo: null,
};

function saveState() { sessionStorage.setItem('3t_builder_state', JSON.stringify(state)); }
function loadState() { try { return JSON.parse(sessionStorage.getItem('3t_builder_state')); } catch (e) { return null; } }

async function api(path, opts) {
  const resp = await fetch('/api' + path, {
    method: opts?.method || 'GET',
    headers: opts?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    body: opts?.body instanceof FormData ? opts.body : (opts?.body ? JSON.stringify(opts.body) : undefined),
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

function showError(msg) {
  const el = document.getElementById('errorBanner');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function clearError() { document.getElementById('errorBanner').classList.add('hidden'); }

function totalQty() {
  let total = 0;
  for (const colorId of Object.keys(state.sizesByColor)) {
    for (const q of Object.values(state.sizesByColor[colorId])) total += (Number(q) || 0);
  }
  return total;
}

function colorSelectionsPayload() {
  return state.selectedColors.map(c => ({
    colorName: c.name,
    colorHex: c.hex,
    sizes: Object.entries(state.sizesByColor[c.id] || {}).filter(([, q]) => q > 0).map(([label, qty]) => ({ label, qty })),
  })).filter(c => c.sizes.length > 0);
}

// ---------------------------------------------------------------- render step nav
// Tabs are always clickable — you can jump to any step at any time. If a
// step needs information from an earlier step that hasn't been filled in
// yet, that step shows a short prompt pointing back to what's missing
// instead of rendering broken/empty content.
function renderStepRail() {
  const rail = document.getElementById('stepRail');
  rail.innerHTML = STEPS.map((s, i) => {
    const cls = i === state.stepIndex ? 'active' : (i < state.stepIndex ? 'done' : '');
    return `<div class="step-pill ${cls}" data-step-index="${i}" role="button" tabindex="0">${STEP_LABELS[s]}</div>`;
  }).join('');
  document.getElementById('headerStepLabel').textContent = `Step ${state.stepIndex + 1} of ${STEPS.length}`;
}
document.getElementById('stepRail').addEventListener('click', (e) => {
  const pill = e.target.closest('[data-step-index]');
  if (pill) goToStep(Number(pill.dataset.stepIndex));
});
document.getElementById('stepRail').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const pill = e.target.closest('[data-step-index]');
  if (pill) { e.preventDefault(); goToStep(Number(pill.dataset.stepIndex)); }
});

function goToStep(index) {
  clearError();
  state.stepIndex = Math.max(0, Math.min(STEPS.length - 1, index));
  saveState();
  document.querySelectorAll('.builder-step').forEach(el => {
    el.classList.toggle('active', el.dataset.step === STEPS[state.stepIndex]);
  });
  renderStepRail();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  onStepEnter(STEPS[state.stepIndex]);
}

function renderPrereqNotice(container, message, targetIndex, targetLabel) {
  container.innerHTML = `<div class="prereq-notice">
    <p>${message}</p>
    <button type="button" class="btn btn-dark btn-sm" data-goto-step="${targetIndex}">${targetLabel}</button>
  </div>`;
  container.querySelector('[data-goto-step]').addEventListener('click', () => goToStep(targetIndex));
}

function onStepEnter(step) {
  if (step === 'color') {
    if (!state.selectedGarmentId) {
      renderPrereqNotice(document.getElementById('colorGrid'), 'Please choose a garment first.', 0, 'Go to Garment');
      document.getElementById('colorNextBtn').disabled = true;
      return;
    }
    renderColorGrid();
  }
  if (step === 'sizes') {
    if (state.selectedColors.length === 0) {
      document.getElementById('bulkBanner').classList.add('hidden');
      renderPrereqNotice(document.getElementById('colorBlocks'), 'Please choose at least one color first.', 1, 'Go to Color');
      document.getElementById('sizesNextBtn').disabled = true;
      return;
    }
    renderColorBlocks();
  }
  if (step === 'locations') {
    if (totalQty() < 1) {
      renderPrereqNotice(document.getElementById('locationGrid'), 'Please set your size quantities first.', 2, 'Go to Sizes');
      document.getElementById('locationsNextBtn').disabled = true;
      return;
    }
    loadPrintLocations();
  }
  if (step === 'artwork') {
    if (state.selectedLocationIds.length === 0) {
      renderPrereqNotice(document.getElementById('uploadSections'), 'Please choose at least one print location first.', 3, 'Go to Print Locations');
      return;
    }
    renderUploadSections();
  }
  if (step === 'contact') hydrateContactForm();
}

document.querySelectorAll('[data-nav="back"]').forEach(btn => btn.addEventListener('click', () => goToStep(state.stepIndex - 1)));
document.querySelectorAll('[data-nav="next"]').forEach(btn => btn.addEventListener('click', () => {
  if (btn.disabled) return;
  goToStep(state.stepIndex + 1);
}));

// ---------------------------------------------------------------- STEP 1: garment
async function loadGarments() {
  const { garments } = await api('/garments');
  state.garments = garments;
  const grid = document.getElementById('garmentGrid');
  grid.innerHTML = garments.map(g => `
    <button type="button" class="option-card ${g.id === state.selectedGarmentId ? 'selected' : ''}" data-garment-id="${g.id}">
      ${g.imageUrl ? `<img src="${g.imageUrl}" alt="${g.name}">` : `<div style="aspect-ratio:1/1;background:var(--3t-light-gray);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#999;">No image</div>`}
      <div class="oc-title">${g.name}</div>
      <div class="oc-sub">${g.brand ? g.brand + ' · ' : ''}${g.description || ''}</div>
    </button>`).join('');

  grid.querySelectorAll('[data-garment-id]').forEach(card => {
    card.addEventListener('click', () => selectGarment(Number(card.dataset.garmentId)));
  });
}

function selectGarment(id) {
  const garment = state.garments.find(g => g.id === id);
  if (!garment) return;
  const changed = state.selectedGarmentId !== id;
  state.selectedGarmentId = id;
  state.garmentSizes = garment.sizes;
  if (changed) {
    state.selectedColors = [];
    state.sizesByColor = {};
    state.selectedLocationIds = [];
  }
  saveState();
  document.querySelectorAll('#garmentGrid .option-card').forEach(c => c.classList.toggle('selected', Number(c.dataset.garmentId) === id));
  renderColorGrid();
  updateSummary();
  goToStep(1);
}

// ---------------------------------------------------------------- STEP 2: color
function renderColorGrid() {
  const garment = state.garments.find(g => g.id === state.selectedGarmentId);
  const grid = document.getElementById('colorGrid');
  if (!garment) { grid.innerHTML = ''; return; }
  grid.innerHTML = garment.colors.map(c => {
    const selected = state.selectedColors.some(sc => sc.id === c.id);
    return `<div class="color-swatch ${selected ? 'selected' : ''}" data-color-id="${c.id}" data-name="${c.name}" data-hex="${c.hex}">
      <div class="chip" style="background:${c.hex};"></div>
      <div class="cname">${c.name}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-color-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.colorId);
      const idx = state.selectedColors.findIndex(c => c.id === id);
      if (idx >= 0) {
        state.selectedColors.splice(idx, 1);
        delete state.sizesByColor[id];
      } else {
        state.selectedColors.push({ id, name: el.dataset.name, hex: el.dataset.hex });
        state.sizesByColor[id] = {};
      }
      saveState();
      renderColorGrid();
      document.getElementById('colorNextBtn').disabled = state.selectedColors.length === 0;
    });
  });
  document.getElementById('colorNextBtn').disabled = state.selectedColors.length === 0;
}

// ---------------------------------------------------------------- STEP 3: sizes
function renderColorBlocks() {
  const wrap = document.getElementById('colorBlocks');
  wrap.innerHTML = state.selectedColors.map(c => `
    <div class="color-block">
      <div class="color-block-head">
        <div class="chip-sm" style="background:${c.hex};"></div>
        <div class="color-block-title">${c.name}</div>
      </div>
      <div class="size-matrix" data-color-id="${c.id}">
        ${state.garmentSizes.map(s => {
          const qty = (state.sizesByColor[c.id] && state.sizesByColor[c.id][s.label]) || 0;
          return `<div class="size-row">
            <div>
              <div class="size-label">${s.label}</div>
              ${s.surcharge > 0 ? `<div class="size-surcharge">+$${s.surcharge.toFixed(2)}/shirt</div>` : ''}
            </div>
            <div class="qty-stepper" data-size="${s.label}">
              <button type="button" data-delta="-1">−</button>
              <input type="number" min="0" value="${qty}" inputmode="numeric">
              <button type="button" data-delta="1">+</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('.size-matrix').forEach(matrix => {
    const colorId = Number(matrix.dataset.colorId);
    matrix.querySelectorAll('.qty-stepper').forEach(stepper => {
      const sizeLabel = stepper.dataset.size;
      const input = stepper.querySelector('input');
      const commit = (val) => {
        const v = Math.max(0, Math.floor(Number(val) || 0));
        state.sizesByColor[colorId] = state.sizesByColor[colorId] || {};
        state.sizesByColor[colorId][sizeLabel] = v;
        input.value = v;
        saveState();
        onSizesChanged();
      };
      stepper.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
        commit((Number(input.value) || 0) + Number(btn.dataset.delta));
      }));
      input.addEventListener('change', () => commit(input.value));
    });
  });

  onSizesChanged();
}

async function onSizesChanged() {
  const qty = totalQty();
  const bulkBanner = document.getElementById('bulkBanner');
  const nextBtn = document.getElementById('sizesNextBtn');
  if (qty > 24) {
    bulkBanner.classList.remove('hidden');
    nextBtn.disabled = true;
    updateSummary({ bulk: true, qty });
    return;
  }
  bulkBanner.classList.add('hidden');
  nextBtn.disabled = qty < 1;
  await refreshEstimate();
}

document.getElementById('bulkQuoteBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  const qty = totalQty();
  const subject = encodeURIComponent(`Bulk quote request — ${qty} pieces`);
  const body = encodeURIComponent(`Hi 3T Print Solutions,\n\nI'd like a bulk quote for ${qty} pieces.\n\nGarment: ${state.garments.find(g=>g.id===state.selectedGarmentId)?.name || ''}\nColors: ${state.selectedColors.map(c=>c.name).join(', ')}\n\nThanks!`);
  const email = state.businessInfo?.businessEmail || 'orders@3tprintsolutions.com';
  window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
});

// ---------------------------------------------------------------- STEP 4: print locations
async function loadPrintLocations() {
  const qty = totalQty();
  const grid = document.getElementById('locationGrid');
  try {
    const { printLocations } = await api(`/print-locations?qty=${qty}`);
    state.printLocations = printLocations;
    if (!printLocations || printLocations.length === 0) {
      grid.innerHTML = `<p class="summary-empty">No print locations are set up yet — please contact us to finish your order.</p>`;
      document.getElementById('locationsNextBtn').disabled = true;
      return;
    }
    if (state.selectedLocationIds.length === 0) {
      const front = printLocations.find(l => l.included);
      if (front) state.selectedLocationIds = [front.id];
    }
    renderLocationGrid();
    saveState();
    await refreshEstimate();
  } catch (err) {
    grid.innerHTML = `<div class="prereq-notice">
      <p>We couldn't load print locations (${err.message || 'network error'}).</p>
      <button type="button" class="btn btn-dark btn-sm" id="retryLocationsBtn">Retry</button>
    </div>`;
    document.getElementById('retryLocationsBtn').addEventListener('click', loadPrintLocations);
  }
}

function renderLocationGrid() {
  const grid = document.getElementById('locationGrid');
  grid.innerHTML = state.printLocations.map(l => {
    const selected = state.selectedLocationIds.includes(l.id);
    const priceLabel = l.included ? 'Included' : `+$${l.addonEach.toFixed(2)}/shirt`;
    return `<button type="button" class="option-card ${selected ? 'selected' : ''}" data-loc-id="${l.id}">
      <div class="oc-title">${l.name.toUpperCase()}</div>
      <div class="oc-price">${priceLabel}</div>
    </button>`;
  }).join('');

  grid.querySelectorAll('[data-loc-id]').forEach(card => {
    card.addEventListener('click', async () => {
      const id = Number(card.dataset.locId);
      const loc = state.printLocations.find(l => l.id === id);
      if (loc.included) return; // front print always included, can't deselect
      const idx = state.selectedLocationIds.indexOf(id);
      if (idx >= 0) state.selectedLocationIds.splice(idx, 1);
      else state.selectedLocationIds.push(id);
      saveState();
      renderLocationGrid();
      document.getElementById('locationsNextBtn').disabled = state.selectedLocationIds.length === 0;
      await refreshEstimate();
    });
  });
  document.getElementById('locationsNextBtn').disabled = state.selectedLocationIds.length === 0;
}

// ---------------------------------------------------------------- STEP 5: artwork
async function ensureDraftToken() {
  if (state.draftToken) return state.draftToken;
  const { draftToken } = await api('/draft-token', { method: 'POST', body: {} });
  state.draftToken = draftToken;
  saveState();
  return draftToken;
}

function selectedLocationObjects() {
  return state.printLocations.filter(l => state.selectedLocationIds.includes(l.id));
}

function renderUploadSections() {
  const wrap = document.getElementById('uploadSections');
  const locs = selectedLocationObjects();
  wrap.innerHTML = locs.map(l => `
    <div class="upload-section" data-loc-code="${l.code}">
      <div class="color-block-title mb-0">${l.name.toUpperCase()} DESIGN</div>
      <div class="mt-8 file-list" data-loc-code-list="${l.code}">
        ${(state.uploads[l.code] || []).map(f => fileChipHtml(f, l.code)).join('')}
      </div>
      <div class="upload-dropzone mt-8" data-loc-code-drop="${l.code}">
        <div class="icon">📎</div>
        <div style="font-weight:700;font-size:13.5px;">Click to upload artwork</div>
        <div class="muted" style="font-size:11.5px;margin-top:2px;">PNG, JPG, PDF, or SVG</div>
        <input type="file" accept=".png,.jpg,.jpeg,.pdf,.svg" style="display:none;">
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('[data-loc-code-drop]').forEach(dz => {
    const code = dz.dataset.locCodeDrop;
    const input = dz.querySelector('input');
    dz.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      if (input.files[0]) await handleUpload(code, input.files[0]);
      input.value = '';
    });
  });

  document.getElementById('designNotes').value = state.designNotes || '';
  document.getElementById('designNotes').oninput = (e) => { state.designNotes = e.target.value; saveState(); };
}

function fileChipHtml(f, code) {
  const isImage = /image\//.test(f.mimeType || '');
  return `<div class="file-chip" data-file-id="${f.id}">
    ${isImage ? `<img src="${f.url}" alt="">` : `<div style="width:40px;height:40px;border-radius:4px;background:var(--3t-light-gray);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;">${(f.filename.split('.').pop()||'').toUpperCase()}</div>`}
    <div class="fc-info"><div class="fc-name">${f.filename}</div><div class="fc-meta">${formatBytes(f.sizeBytes)}</div></div>
    <button type="button" data-remove="${f.id}" data-loc-code="${code}">Remove</button>
  </div>`;
}
function formatBytes(n) { if (!n) return ''; if (n < 1024*1024) return Math.round(n/1024) + ' KB'; return (n/1024/1024).toFixed(1) + ' MB'; }

async function handleUpload(locationCode, file) {
  try {
    const draftToken = await ensureDraftToken();
    const fd = new FormData();
    fd.append('file', file);
    fd.append('draftToken', draftToken);
    fd.append('printLocationCode', locationCode);
    const { file: uploaded } = await api('/uploads', { method: 'POST', body: fd });
    state.uploads[locationCode] = state.uploads[locationCode] || [];
    state.uploads[locationCode].push(uploaded);
    saveState();
    renderUploadSections();
  } catch (err) {
    showToast(err.message || 'Upload failed.');
  }
}

document.getElementById('uploadSections').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const id = btn.dataset.remove;
  const code = btn.dataset.locCode;
  try {
    await api(`/uploads/${id}`, { method: 'DELETE' });
    state.uploads[code] = (state.uploads[code] || []).filter(f => String(f.id) !== String(id));
    saveState();
    renderUploadSections();
  } catch (err) { showToast(err.message); }
});

// ---------------------------------------------------------------- STEP 6: contact
function hydrateContactForm() {
  const c = state.contact;
  document.getElementById('firstName').value = c.firstName;
  document.getElementById('lastName').value = c.lastName;
  document.getElementById('email').value = c.email;
  document.getElementById('phone').value = c.phone;
  document.getElementById('businessName').value = c.businessName;
  document.getElementById('neededByDate').value = c.neededByDate;
  document.getElementById('additionalNotes').value = c.additionalNotes;
  document.querySelectorAll('#orderPurposeGroup .radio-pill').forEach(p => p.classList.toggle('selected', (c.orderPurposes || []).includes(p.dataset.value)));
  document.querySelectorAll('#fulfillmentGroup .radio-pill').forEach(p => p.classList.toggle('selected', p.dataset.value === c.fulfillmentMethod));
}
['firstName','lastName','email','phone','businessName','neededByDate','additionalNotes'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => { state.contact[id] = e.target.value; saveState(); });
});
document.getElementById('orderPurposeGroup').addEventListener('click', (e) => {
  const pill = e.target.closest('.radio-pill');
  if (!pill) return;
  const val = pill.dataset.value;
  const list = state.contact.orderPurposes || (state.contact.orderPurposes = []);
  const idx = list.indexOf(val);
  if (idx === -1) { list.push(val); pill.classList.add('selected'); }
  else { list.splice(idx, 1); pill.classList.remove('selected'); }
  saveState();
});
document.getElementById('fulfillmentGroup').addEventListener('click', (e) => {
  const pill = e.target.closest('.radio-pill');
  if (!pill) return;
  state.contact.fulfillmentMethod = pill.dataset.value;
  document.querySelectorAll('#fulfillmentGroup .radio-pill').forEach(p => p.classList.toggle('selected', p === pill));
  saveState();
});

document.getElementById('getPriceBtn').addEventListener('click', submitQuote);

async function submitQuote() {
  clearError();
  const c = state.contact;
  if (!c.firstName.trim() || !c.lastName.trim() || !c.email.trim() || !c.phone.trim()) {
    showError('Please fill in your first name, last name, email, and phone number.');
    return;
  }
  const btn = document.getElementById('getPriceBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Calculating your price…';
  try {
    const payload = {
      garmentId: state.selectedGarmentId,
      colorSelections: colorSelectionsPayload(),
      printLocationIds: state.selectedLocationIds,
      designNotes: state.designNotes,
      draftToken: state.draftToken,
      firstName: c.firstName.trim(), lastName: c.lastName.trim(), email: c.email.trim(), phone: c.phone.trim(),
      businessName: c.businessName.trim() || null, orderPurpose: (c.orderPurposes || []).join(', ') || null,
      neededByDate: c.neededByDate || null, notes: c.additionalNotes.trim() || null,
      fulfillmentMethod: c.fulfillmentMethod,
      termsAccepted: true,
    };
    const result = await api('/quotes', { method: 'POST', body: payload });
    if (result.bulkQuoteRequired) {
      showError('This order exceeds 24 pieces — please use the bulk quote option in Step 3.');
      return;
    }
    sessionStorage.removeItem('3t_builder_state');
    window.location.href = `/quote.html?id=${encodeURIComponent(result.quoteCode)}`;
  } catch (err) {
    showError(err.message || 'Something went wrong generating your quote.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get My Price';
  }
}

// ---------------------------------------------------------------- estimate + summary
async function refreshEstimate() {
  if (!state.selectedGarmentId) return;
  const selections = colorSelectionsPayload();
  if (selections.length === 0) { updateSummary(); return; }
  try {
    const { estimate, bulkQuoteRequired } = await api('/estimate', {
      method: 'POST',
      body: { garmentId: state.selectedGarmentId, colorSelections: selections, printLocationIds: state.selectedLocationIds },
    });
    if (bulkQuoteRequired) { updateSummary({ bulk: true, qty: totalQty() }); return; }
    state.estimate = estimate;
    saveState();
    updateSummary();
  } catch (err) {
    // non-fatal — summary just won't update
  }
}

function updateSummary(opts) {
  const body = document.getElementById('summaryBody');
  const garment = state.garments.find(g => g.id === state.selectedGarmentId);

  if (opts && opts.bulk) {
    body.innerHTML = `<p class="summary-empty">${opts.qty} pieces selected.</p>
      <div class="bulk-banner" style="border-color:#555;">
        <h4 style="color:#fff;">24-Piece Max</h4>
        <p style="color:#bbb;">This calculator covers 1–24 pieces. Use "Get a Bulk Quote" to continue.</p>
      </div>`;
    return;
  }

  if (!garment) { body.innerHTML = '<p class="summary-empty">Choose a garment to get started.</p>'; return; }

  let html = `<div class="summary-line"><span class="l">Garment</span><span class="r">${garment.name}</span></div>`;
  if (state.selectedColors.length) {
    html += `<div class="summary-line"><span class="l">Color${state.selectedColors.length>1?'s':''}</span><span class="r">${state.selectedColors.map(c=>c.name).join(', ')}</span></div>`;
  }
  const qty = totalQty();
  if (qty > 0) html += `<div class="summary-line"><span class="l">Quantity</span><span class="r">${qty}</span></div>`;

  const est = state.estimate;
  if (est) {
    // Use finalBaseUnit (not the raw tier price) so the displayed "qty × unit
    // price" always multiplies out to the amount shown next to it — garments
    // with a price adjustment (hoodies, hats, etc.) change the unit price.
    html += `<div class="summary-line"><span class="l">${qty} × $${est.finalBaseUnit.toFixed(2)}</span><span class="r">$${est.baseLineTotal.toFixed(2)}</span></div>`;
    for (const line of est.addonLines) {
      html += `<div class="summary-line"><span class="l">${line.name} (${line.qty} × $${line.each.toFixed(2)})</span><span class="r">$${line.total.toFixed(2)}</span></div>`;
    }
    if (est.sizeSurchargeTotal > 0) {
      html += `<div class="summary-line"><span class="l">Size Adjustments</span><span class="r">$${est.sizeSurchargeTotal.toFixed(2)}</span></div>`;
    }
    html += `<div class="summary-total"><span class="l">Estimated Total</span><span class="r">$${est.total.toFixed(2)}</span></div>`;
    html += `<div class="summary-note">Final total confirmed on your itemized quote. Shipping &amp; taxes calculated at checkout.</div>`;
  }

  body.innerHTML = html;
}

// ---------------------------------------------------------------- init
async function init() {
  try {
    const info = await api('/business-info');
    state.businessInfo = info;
  } catch (e) {}
  await loadGarments();
  if (state.selectedGarmentId) {
    const garment = state.garments.find(g => g.id === state.selectedGarmentId);
    if (garment) { state.garmentSizes = garment.sizes; renderColorGrid(); }
  }
  goToStep(state.stepIndex || 0);
  updateSummary();
  saveState();
}
init();
