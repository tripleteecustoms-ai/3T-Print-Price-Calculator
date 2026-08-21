// public/js/builder.js
// Customer Order Builder — step-by-step configurator. Every price shown is
// fetched from POST /api/estimate (server-calculated); nothing here is
// trusted as the final price. sessionStorage persists in-progress state.

const DEFAULT_STEPS = ['garment', 'color', 'sizes', 'locations', 'artwork', 'contact'];
// Reassigned in init() from /api/business-info's stepOrder (Settings > Layout
// in the admin). Defaults to DEFAULT_STEPS until that response comes back, so
// nothing here fails before the first fetch resolves.
let STEPS = [...DEFAULT_STEPS];
const STEP_LABELS = { garment: 'Garment', color: 'Color', sizes: 'Sizes', locations: 'Print', artwork: 'Artwork', contact: 'Info' };

/** True if `arr` is an exact permutation of DEFAULT_STEPS — same defensive
 * check the server applies before persisting a custom order, run again here
 * in case /api/business-info ever returns something stale or malformed. */
function isValidStepOrder(arr) {
  if (!Array.isArray(arr) || arr.length !== DEFAULT_STEPS.length) return false;
  const a = [...arr].sort(), b = [...DEFAULT_STEPS].sort();
  return a.every((v, i) => v === b[i]);
}

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
  designSizes: {},              // { locationCode: 'standard' | 'large' | 'oversized' }
  designNotes: '',
  artworkPending: false,        // true = customer explicitly chose "I'll send artwork later"
  contact: {
    firstName:'', lastName:'', email:'', phone:'', businessName:'', orderPurposes:[], neededByDate:'', additionalNotes:'', fulfillmentMethod:'pickup',
    shippingAddress: { line1:'', line2:'', city:'', state:'', zip:'' },
  },
  estimate: null,
  businessInfo: null,
  quantityTiers: [],            // [{id,label,minQty,maxQty,checkoutBehavior}] — client-side mirror for instant UI feedback only; server always re-derives
};

// Must read the same as the server's exact rejection text (server/pricingEngine.js
// MAX_QTY_MESSAGE) — duplicated here only so the "over 10,000" banner can show
// instantly from local quantity math, without waiting on a network round trip.
const MAX_QTY = 10000;
const MAX_QTY_MESSAGE = 'For orders above 10,000 pieces, contact 3T Print Solutions for a custom production proposal.';

/** Client-side tier lookup for instant UI feedback (banner text, button
 * label). Never authoritative — the server always independently re-derives
 * the tier and price from the DB when a quote is actually created. */
function findClientTier(qty) {
  return state.quantityTiers.find(t => qty >= t.minQty && qty <= t.maxQty) || null;
}
function isReviewOrder() {
  const tier = findClientTier(totalQty());
  return !!(tier && tier.checkoutBehavior === 'review');
}

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

/** Delegated keydown handler so Enter/Space activate a role="button" div the
 * same way clicking it does — matches the pattern already used by the
 * step-rail pills. Bind once on a stable parent; works for content the
 * parent re-renders later since it's delegated, not per-element. */
function enableKeyboardActivation(container, selector) {
  if (!container) return;
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest(selector);
    if (!el) return;
    e.preventDefault();
    el.click();
  });
}

// Simple inline-SVG garment silhouettes shown in place of a photo until Trey
// uploads real product photography (server/seed.js seeds every garment with
// image_url: '') — a tasteful placeholder instead of a bare gray box, picked
// by keyword match against the garment name since there's no category field.
function garmentIconSvg(name) {
  const n = (name || '').toLowerCase();
  let body;
  if (/hoodie|sweatshirt/.test(n)) {
    body = '<path d="M8 3c1.2-1 2.6-1.5 4-1.5s2.8.5 4 1.5l3 2.2c.6.4.8 1.2.4 1.9l-1.3 2.2a1.3 1.3 0 0 1-2 .3L15 8.5V19a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V8.5l-1.1 1.1a1.3 1.3 0 0 1-2-.3L4.6 7.1a1.4 1.4 0 0 1 .4-1.9L8 3z"/><path d="M10 4.5c.6 1 1.3 1.5 2 1.5s1.4-.5 2-1.5" fill="none" stroke-width="1.3"/>';
  } else if (/hat|cap/.test(n)) {
    body = '<path d="M4 15c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="none" stroke-width="1.6"/><path d="M4 15h16v1.5a2 2 0 0 1-2 2H10l-4.5 2.2A1 1 0 0 1 4 19.8V15z"/><circle cx="12" cy="7.2" r="1.1"/>';
  } else if (/tote|bag/.test(n)) {
    body = '<rect x="5" y="8" width="14" height="13" rx="1.5"/><path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2" fill="none" stroke-width="1.6"/>';
  } else if (/polo/.test(n)) {
    body = '<path d="M9 3l3 2 3-2 4 2.5-2 3-1.5-1V20a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V7.5L7.5 8.5l-2-3L9 3z"/><path d="M10.5 4.2v2.2M13.5 4.2v2.2" stroke-width="1.3"/>';
  } else {
    // default: tee (also covers long sleeve, performance, standard/premium/heavyweight tees)
    body = '<path d="M8.5 3.2L12 5l3.5-1.8L20 6l-2 3.3-1.8-1V20a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8.3l-1.8 1L4 6l4.5-2.8z"/>';
  }
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="#c7c7c7" stroke="#c7c7c7" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

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

// Keyboard activation for role="button" pills/swatches whose content is
// (re-)rendered dynamically — delegated on the stable parent so it keeps
// working across re-renders instead of needing to be rebound each time.
enableKeyboardActivation(document.getElementById('colorGrid'), '[data-color-id]');
enableKeyboardActivation(document.getElementById('uploadSections'), '[data-design-size-group] [data-value]');
enableKeyboardActivation(document.getElementById('orderPurposeGroup'), '.radio-pill');
enableKeyboardActivation(document.getElementById('fulfillmentGroup'), '.radio-pill');

function goToStep(index) {
  clearError();
  state.stepIndex = Math.max(0, Math.min(STEPS.length - 1, index));
  saveState();
  document.querySelectorAll('.builder-step').forEach(el => {
    el.classList.toggle('active', el.dataset.step === STEPS[state.stepIndex]);
  });
  renderStepRail();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.track3T) window.track3T('step_view', { step: STEPS[state.stepIndex] });
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
  // Prereq-notice targets are looked up by step NAME, not a hardcoded index —
  // Settings > Layout lets the admin reorder STEPS arbitrarily, so "Go to
  // Garment" always has to mean "wherever the garment step currently is".
  if (step === 'color') {
    if (!state.selectedGarmentId) {
      renderPrereqNotice(document.getElementById('colorGrid'), 'Please choose a garment first.', STEPS.indexOf('garment'), 'Go to Garment');
      document.getElementById('colorNextBtn').disabled = true;
      return;
    }
    renderColorGrid();
  }
  if (step === 'sizes') {
    if (state.selectedColors.length === 0) {
      document.getElementById('bulkBanner').classList.add('hidden');
      renderPrereqNotice(document.getElementById('colorBlocks'), 'Please choose at least one color first.', STEPS.indexOf('color'), 'Go to Color');
      document.getElementById('sizesNextBtn').disabled = true;
      return;
    }
    renderColorBlocks();
  }
  if (step === 'locations') {
    if (totalQty() < 1) {
      renderPrereqNotice(document.getElementById('locationGrid'), 'Please set your size quantities first.', STEPS.indexOf('sizes'), 'Go to Sizes');
      document.getElementById('locationsNextBtn').disabled = true;
      return;
    }
    loadPrintLocations();
  }
  if (step === 'artwork') {
    if (state.selectedLocationIds.length === 0) {
      renderPrereqNotice(document.getElementById('uploadSections'), 'Please choose at least one print location first.', STEPS.indexOf('locations'), 'Go to Print Locations');
      document.getElementById('artworkNextBtn').disabled = true;
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
  const grid = document.getElementById('garmentGrid');
  grid.innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading garments…</div>`;
  try {
    const { garments } = await api('/garments');
    state.garments = garments;
    grid.innerHTML = garments.map(g => `
      <button type="button" class="option-card ${g.id === state.selectedGarmentId ? 'selected' : ''}" data-garment-id="${g.id}">
        ${g.imageUrl ? `<img src="${g.imageUrl}" alt="${g.name}">` : `<div style="aspect-ratio:1/1;background:var(--3t-light-gray);border-radius:6px;display:flex;align-items:center;justify-content:center;padding:22%;">${garmentIconSvg(g.name)}</div>`}
        <div class="oc-title">${g.name}</div>
        <div class="oc-sub">${g.brand ? g.brand + ' · ' : ''}${g.description || ''}</div>
      </button>`).join('');

    grid.querySelectorAll('[data-garment-id]').forEach(card => {
      card.addEventListener('click', () => selectGarment(Number(card.dataset.garmentId)));
    });
  } catch (err) {
    grid.innerHTML = `<div class="prereq-notice">
      <p>We couldn't load garments (${err.message || 'network error'}).</p>
      <button type="button" class="btn btn-dark btn-sm" id="retryGarmentsBtn">Retry</button>
    </div>`;
    document.getElementById('retryGarmentsBtn').addEventListener('click', loadGarments);
  }
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
  // Auto-advance to whatever step follows 'garment' in the current order,
  // not a hardcoded index — Settings > Layout can move 'garment' anywhere.
  goToStep(STEPS.indexOf('garment') + 1);
}

// ---------------------------------------------------------------- STEP 2: color
function renderColorGrid() {
  const garment = state.garments.find(g => g.id === state.selectedGarmentId);
  const grid = document.getElementById('colorGrid');
  if (!garment) { grid.innerHTML = ''; return; }
  grid.innerHTML = garment.colors.map(c => {
    const selected = state.selectedColors.some(sc => sc.id === c.id);
    return `<div class="color-swatch ${selected ? 'selected' : ''}" data-color-id="${c.id}" data-name="${c.name}" data-hex="${c.hex}"
      role="button" tabindex="0" aria-pressed="${selected}" aria-label="Color: ${c.name}">
      <div class="chip" style="background:${c.hex};"></div>
      <div class="cname">${c.name}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-color-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.colorId);
      const idx = state.selectedColors.findIndex(c => c.id === id);
      let nowSelected;
      if (idx >= 0) {
        state.selectedColors.splice(idx, 1);
        delete state.sizesByColor[id];
        nowSelected = false;
      } else {
        state.selectedColors.push({ id, name: el.dataset.name, hex: el.dataset.hex });
        state.sizesByColor[id] = {};
        nowSelected = true;
      }
      saveState();
      // Toggle this one swatch in place rather than re-rendering the whole
      // grid — a full re-render replaces every element, which would drop
      // keyboard focus off the swatch a keyboard user just activated.
      el.classList.toggle('selected', nowSelected);
      el.setAttribute('aria-pressed', String(nowSelected));
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
      // 'input' (not 'change') so a customer typing "150" doesn't need to
      // blur the field to register — the network call this triggers is
      // debounced below so mid-typing keystrokes don't each fire a request.
      input.addEventListener('input', () => commit(input.value));
    });
  });

  onSizesChanged();
}

let sizesChangeDebounceTimer = null;
function onSizesChanged() {
  const qty = totalQty();
  const bulkBanner = document.getElementById('bulkBanner');
  const nextBtn = document.getElementById('sizesNextBtn');
  const tier = findClientTier(qty);

  if (qty > 0 && !tier) {
    // Either > 10,000 (rejected outright) or the tier table is momentarily
    // still loading — either way, don't let them continue on a quantity we
    // can't price yet. The server independently enforces this too.
    bulkBanner.classList.remove('hidden');
    bulkBanner.innerHTML = `<h4>Order Too Large</h4><p>${MAX_QTY_MESSAGE}</p>`;
    nextBtn.disabled = true;
    updateSummary({ overMax: true, qty });
    return;
  }
  if (qty > 0 && tier.checkoutBehavior === 'review') {
    // 1,001+ pieces: NOT blocked — the customer keeps building their order
    // normally, they just get routed to production review at the end
    // instead of instant checkout (see the Contact step's submit button).
    bulkBanner.classList.remove('hidden');
    bulkBanner.innerHTML = `<h4>Large Order — ${qty} Pieces</h4>
      <p>Orders of 1,001 pieces or more get a preliminary volume estimate and go through a quick production &amp; inventory review instead of instant checkout — keep building your order below as usual.</p>`;
  } else {
    bulkBanner.classList.add('hidden');
  }
  nextBtn.disabled = qty < 1;
  // The qty/garment/color lines in the summary come straight from local
  // state, so update them immediately — only the server-priced lines need
  // the (debounced) network round trip below.
  updateSummary();
  clearTimeout(sizesChangeDebounceTimer);
  sizesChangeDebounceTimer = setTimeout(() => { refreshEstimate(); }, 300);
}

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

function printLocationSelectionsPayload() {
  return state.selectedLocationIds.map(id => {
    const loc = state.printLocations.find(l => l.id === id);
    return { id, designSize: (loc && state.designSizes[loc.code]) || 'standard' };
  });
}

const DESIGN_SIZE_OPTIONS = [
  { value: 'standard', label: 'Standard', dims: '11in Width x Proportionate Height' },
  { value: 'large', label: 'Large Graphic', dims: '13in Width x Proportionate Height' },
  { value: 'oversized', label: 'Oversized', dims: '15.5in Width x Proportionate Height' },
];

function designSizeSurchargeFor(value) {
  if (value === 'large') return state.businessInfo?.designSizeSurcharges?.large ?? 1.50;
  if (value === 'oversized') return state.businessInfo?.designSizeSurcharges?.oversized ?? 2.50;
  return 0;
}

function renderUploadSections() {
  const wrap = document.getElementById('uploadSections');
  const locs = selectedLocationObjects();
  locs.forEach(l => { if (!state.designSizes[l.code]) state.designSizes[l.code] = 'standard'; });

  wrap.innerHTML = locs.map(l => `
    <div class="upload-section" data-loc-code="${l.code}">
      <div class="color-block-title mb-0">${l.name.toUpperCase()} DESIGN</div>

      <div class="field mt-8 mb-0">
        <label>Design Size</label>
        <div class="radio-pill-group" data-design-size-group="${l.code}">
          ${DESIGN_SIZE_OPTIONS.map(o => {
            const surcharge = designSizeSurchargeFor(o.value);
            const priceText = surcharge > 0 ? ` (+$${surcharge.toFixed(2)}/shirt)` : '';
            const selected = state.designSizes[l.code] === o.value;
            return `<div class="radio-pill ${selected ? 'selected' : ''}" data-value="${o.value}" title="${o.dims}" role="button" tabindex="0" aria-pressed="${selected}">${o.label}${priceText}</div>`;
          }).join('')}
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px;">${DESIGN_SIZE_OPTIONS.find(o => o.value === state.designSizes[l.code])?.dims || ''}</div>
      </div>

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

  wrap.querySelectorAll('[data-design-size-group]').forEach(group => {
    const code = group.dataset.designSizeGroup;
    group.querySelectorAll('[data-value]').forEach(pill => {
      pill.addEventListener('click', async () => {
        const value = pill.dataset.value;
        state.designSizes[code] = value;
        saveState();
        renderUploadSections();
        // renderUploadSections() rebuilds this whole section, which would
        // otherwise drop keyboard focus right after a keyboard user just
        // activated this pill — restore it to the equivalent freshly-rendered pill.
        const newPill = document.querySelector(`[data-design-size-group="${code}"] [data-value="${value}"]`);
        if (newPill) newPill.focus();
        await refreshEstimate();
      });
    });
  });

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

  const laterCheckbox = document.getElementById('artworkLaterCheckbox');
  if (laterCheckbox) laterCheckbox.checked = !!state.artworkPending;
  updateArtworkNextBtn();
}

/** Total artwork files uploaded across every print location so far. */
function totalUploadsCount() {
  return Object.values(state.uploads).reduce((sum, arr) => sum + (arr ? arr.length : 0), 0);
}

// A customer must explicitly do one of two things before advancing past
// Artwork: upload at least one file, or check "I'll send artwork later" —
// silently skipping the step (the old behavior) is no longer possible.
function updateArtworkNextBtn() {
  const btn = document.getElementById('artworkNextBtn');
  if (!btn) return;
  btn.disabled = !(totalUploadsCount() > 0 || state.artworkPending);
}

document.getElementById('artworkLaterCheckbox')?.addEventListener('change', (e) => {
  state.artworkPending = e.target.checked;
  saveState();
  updateArtworkNextBtn();
});

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
  document.querySelectorAll('#orderPurposeGroup .radio-pill').forEach(p => {
    const isSelected = (c.orderPurposes || []).includes(p.dataset.value);
    p.classList.toggle('selected', isSelected);
    p.setAttribute('aria-pressed', String(isSelected));
  });
  document.querySelectorAll('#fulfillmentGroup .radio-pill').forEach(p => {
    const isSelected = p.dataset.value === c.fulfillmentMethod;
    p.classList.toggle('selected', isSelected);
    p.setAttribute('aria-pressed', String(isSelected));
  });
  const sa = c.shippingAddress || {};
  document.getElementById('shipLine1').value = sa.line1 || '';
  document.getElementById('shipLine2').value = sa.line2 || '';
  document.getElementById('shipCity').value = sa.city || '';
  document.getElementById('shipState').value = sa.state || '';
  document.getElementById('shipZip').value = sa.zip || '';
  updateShippingAddressVisibility();
  updateGetPriceBtnEnabled();
  updateGetPriceBtnLabel();
}
['firstName','lastName','email','phone','businessName','neededByDate','additionalNotes'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => { state.contact[id] = e.target.value; saveState(); });
});
['shipLine1','shipLine2','shipCity','shipState','shipZip'].forEach(id => {
  const key = id.replace('ship', '').charAt(0).toLowerCase() + id.replace('ship', '').slice(1); // shipLine1 -> line1
  document.getElementById(id).addEventListener('input', (e) => {
    state.contact.shippingAddress = state.contact.shippingAddress || {};
    state.contact.shippingAddress[key] = e.target.value;
    saveState();
  });
});
function updateShippingAddressVisibility() {
  document.getElementById('shippingAddressField').classList.toggle('hidden', state.contact.fulfillmentMethod !== 'shipping');
}
document.getElementById('orderPurposeGroup').addEventListener('click', (e) => {
  const pill = e.target.closest('.radio-pill');
  if (!pill) return;
  const val = pill.dataset.value;
  const list = state.contact.orderPurposes || (state.contact.orderPurposes = []);
  const idx = list.indexOf(val);
  if (idx === -1) { list.push(val); pill.classList.add('selected'); pill.setAttribute('aria-pressed', 'true'); }
  else { list.splice(idx, 1); pill.classList.remove('selected'); pill.setAttribute('aria-pressed', 'false'); }
  saveState();
});
document.getElementById('fulfillmentGroup').addEventListener('click', (e) => {
  const pill = e.target.closest('.radio-pill');
  if (!pill) return;
  state.contact.fulfillmentMethod = pill.dataset.value;
  document.querySelectorAll('#fulfillmentGroup .radio-pill').forEach(p => {
    const isSelected = p === pill;
    p.classList.toggle('selected', isSelected);
    p.setAttribute('aria-pressed', String(isSelected));
  });
  updateShippingAddressVisibility();
  saveState();
});

document.getElementById('builderTermsCheckbox').addEventListener('change', updateGetPriceBtnEnabled);
function updateGetPriceBtnEnabled() {
  document.getElementById('getPriceBtn').disabled = !document.getElementById('builderTermsCheckbox').checked;
}
// Button text honestly reflects what clicking it will do: normal orders get
// a quote + checkout; orders of 1,001+ pieces go to production review
// instead (Phase 2 — replaces the old 24-piece "Get a Bulk Quote" cap).
function updateGetPriceBtnLabel() {
  const btn = document.getElementById('getPriceBtn');
  if (!btn || btn.dataset.loading) return;
  btn.textContent = isReviewOrder() ? 'Submit for Production Review' : 'Get My Quote';
}

document.getElementById('getPriceBtn').addEventListener('click', submitQuote);

async function submitQuote() {
  clearError();
  const c = state.contact;
  if (!c.firstName.trim() || !c.lastName.trim() || !c.email.trim() || !c.phone.trim()) {
    showError('Please fill in your first name, last name, email, and phone number.');
    return;
  }
  const termsAccepted = document.getElementById('builderTermsCheckbox').checked;
  if (!termsAccepted) {
    showError('Please confirm the order details are correct before we can generate your quote.');
    return;
  }
  // Defense-in-depth mirror of the Artwork step's Next-button gate — a
  // customer can't normally reach this step without having made a choice,
  // but state can be restored from sessionStorage (e.g. an old saved
  // session from before this flag existed), so re-check here too.
  if (totalUploadsCount() === 0 && !state.artworkPending) {
    showError("Please go back to the Artwork step and either upload your artwork or check \"I'll send artwork later.\"");
    goToStep(STEPS.indexOf('artwork'));
    return;
  }
  const reviewOrder = isReviewOrder();
  if (reviewOrder && c.fulfillmentMethod === 'shipping') {
    const sa = c.shippingAddress || {};
    if (!sa.line1?.trim() || !sa.city?.trim() || !sa.state?.trim() || !sa.zip?.trim()) {
      showError('Please provide a complete shipping address (street, city, state, ZIP) for a production review order.');
      goToStep(STEPS.indexOf('contact'));
      return;
    }
  }
  const btn = document.getElementById('getPriceBtn');
  btn.disabled = true;
  btn.dataset.loading = '1';
  btn.innerHTML = reviewOrder ? '<span class="spinner"></span> Submitting for review…' : '<span class="spinner"></span> Getting your quote…';
  try {
    const payload = {
      garmentId: state.selectedGarmentId,
      colorSelections: colorSelectionsPayload(),
      printLocationIds: printLocationSelectionsPayload(),
      designNotes: state.designNotes,
      draftToken: state.draftToken,
      firstName: c.firstName.trim(), lastName: c.lastName.trim(), email: c.email.trim(), phone: c.phone.trim(),
      businessName: c.businessName.trim() || null, orderPurpose: (c.orderPurposes || []).join(', ') || null,
      neededByDate: c.neededByDate || null, notes: c.additionalNotes.trim() || null,
      fulfillmentMethod: c.fulfillmentMethod,
      shippingAddress: c.fulfillmentMethod === 'shipping' ? c.shippingAddress : null,
      termsAccepted,
      artworkPending: !!state.artworkPending,
    };
    const result = await api('/quotes', { method: 'POST', body: payload });
    if (window.track3T) window.track3T('quote_generated', { quoteCode: result.quoteCode });
    sessionStorage.removeItem('3t_builder_state');
    window.location.href = `/quote.html?id=${encodeURIComponent(result.quoteCode)}`;
  } catch (err) {
    showError(err.message || 'Something went wrong generating your quote.');
  } finally {
    delete btn.dataset.loading;
    updateGetPriceBtnLabel();
    updateGetPriceBtnEnabled();
  }
}

// ---------------------------------------------------------------- estimate + summary
async function refreshEstimate() {
  if (!state.selectedGarmentId) return;
  if (totalQty() > MAX_QTY) return; // over-max is handled entirely client-side by onSizesChanged's banner
  const selections = colorSelectionsPayload();
  if (selections.length === 0) { updateSummary(); return; }
  try {
    const { estimate } = await api('/estimate', {
      method: 'POST',
      body: { garmentId: state.selectedGarmentId, colorSelections: selections, printLocationIds: printLocationSelectionsPayload() },
    });
    state.estimate = estimate;
    saveState();
    hideEstimateError();
    updateSummary();
  } catch (err) {
    showEstimateError();
  }
}

function showEstimateError() {
  const box = document.getElementById('summaryErrorBox');
  if (!box) return;
  box.innerHTML = `<div class="summary-error">
    We couldn't update your price. Your selections are saved. Please retry.
    <button type="button" class="btn btn-outline btn-sm" id="retryEstimateBtn">Retry</button>
  </div>`;
  box.classList.remove('hidden');
  document.getElementById('retryEstimateBtn').addEventListener('click', async () => {
    await refreshEstimate();
  });
}
function hideEstimateError() {
  const box = document.getElementById('summaryErrorBox');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function updateSummary(opts) {
  const body = document.getElementById('summaryBody');
  const garment = state.garments.find(g => g.id === state.selectedGarmentId);

  if (opts && opts.overMax) {
    body.innerHTML = `<p class="summary-empty">${opts.qty} pieces selected.</p>
      <div class="bulk-banner" style="border-color:#555;">
        <h4 style="color:#fff;">Order Too Large</h4>
        <p style="color:#bbb;">${MAX_QTY_MESSAGE}</p>
      </div>`;
    updateMobileSummaryBar(opts.qty, null);
    updateGetPriceBtnLabel();
    return;
  }

  if (!garment) { body.innerHTML = '<p class="summary-empty">Choose a garment to get started.</p>'; updateMobileSummaryBar(0, null); return; }

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
    for (const line of (est.designSizeLines || [])) {
      html += `<div class="summary-line"><span class="l">${line.locationName} — ${line.designSizeLabel} (${line.qty} × $${line.each.toFixed(2)})</span><span class="r">$${line.total.toFixed(2)}</span></div>`;
    }
    html += `<div class="summary-total"><span class="l">Estimated Total</span><span class="r">$${est.total.toFixed(2)}</span></div>`;
    if (est.quantityTier && est.quantityTier.checkoutBehavior === 'review') {
      html += `<div class="summary-note"><strong>Preliminary volume estimate</strong> - final pricing depends on garment inventory, freight and production scheduling.</div>`;
    } else {
      html += `<div class="summary-note">Final total confirmed on your itemized quote. Shipping &amp; taxes calculated at checkout.</div>`;
    }
  }

  body.innerHTML = html;
  updateMobileSummaryBar(qty, est ? est.total : null);
  updateGetPriceBtnLabel();
}

/** Sticky bottom bar on mobile viewports — reuses the same qty/total figures
 * the desktop summary panel already computed above rather than recalculating
 * anything, and stays hidden until there's an actual order to summarize. */
function updateMobileSummaryBar(qty, total) {
  const bar = document.getElementById('mobileSummaryBar');
  if (!bar) return;
  if (!qty || qty < 1) { bar.classList.add('hidden'); return; }
  document.getElementById('mobileSummaryCount').textContent = `${qty} Item${qty === 1 ? '' : 's'}`;
  document.getElementById('mobileSummaryTotal').textContent = total != null ? `$${total.toFixed(2)}` : '';
  bar.classList.remove('hidden');
}

document.getElementById('mobileViewOrderBtn')?.addEventListener('click', () => {
  document.getElementById('summaryPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------------------------------------------------------------- init
async function init() {
  try {
    const info = await api('/business-info');
    state.businessInfo = info;
    if (isValidStepOrder(info.stepOrder)) STEPS = info.stepOrder;
  } catch (e) {}
  try {
    const { tiers } = await api('/quantity-tiers');
    state.quantityTiers = tiers;
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
