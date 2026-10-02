// public/js/builder.js
// Customer Order Builder — step-by-step configurator. Every price shown is
// fetched from POST /api/estimate (server-calculated); nothing here is
// trusted as the final price. localStorage persists in-progress state, so a
// customer who leaves and comes back lands on the step they left.

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

// In-progress orders are kept on this device for two weeks. (Declared up
// here because loadState() runs on the next line.)
const STATE_KEY = '3t_builder_state';
const STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const restoredState = loadState();
const state = restoredState || {
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
  placements: {},               // { locationCode: saved placement record } from the design preview (placement.js)
  designNotes: '',
  artworkPending: false,        // true = customer explicitly chose "I'll send artwork later"
  artworkTermsAccepted: false,  // the artwork-terms checkbox at the end of the Artwork step
  customGarmentDescription: '', // what the customer wants when they pick "Other / Not Listed"
  customerSuppliedGarment: false,
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

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// Saves from before this moved out of sessionStorage are still picked up.
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...state, savedAt: Date.now() })); } catch (e) {}
}
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY));
    if (saved && Date.now() - (saved.savedAt || 0) < STATE_MAX_AGE_MS) return saved;
  } catch (e) {}
  try { return JSON.parse(sessionStorage.getItem(STATE_KEY)); } catch (e) { return null; }
}
function clearSavedState() {
  try { localStorage.removeItem(STATE_KEY); } catch (e) {}
  try { sessionStorage.removeItem(STATE_KEY); } catch (e) {}
}
// Shown once when a saved order is restored, with a way to wipe it.
function showResumeNotice() {
  const el = document.getElementById('resumeNotice');
  if (!el || !restoredState || !(restoredState.selectedGarmentId || restoredState.stepIndex > 0)) return;
  el.innerHTML = '<span>Welcome back. We saved your order where you left off.</span><span><button type="button" id="resumeStartOverBtn">Start over</button><button type="button" id="resumeDismissBtn" aria-label="Dismiss">&times;</button></span>';
  el.classList.remove('hidden');
  document.getElementById('resumeDismissBtn').addEventListener('click', () => el.classList.add('hidden'));
  document.getElementById('resumeStartOverBtn').addEventListener('click', () => {
    if (!confirm('Clear this order and start over?')) return;
    clearSavedState();
    window.location.href = window.location.pathname;
  });
}

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
  if (/^other|not listed/.test(n)) {
    body = '<circle cx="12" cy="12" r="9" fill="none" stroke-width="1.8"/><path d="M12 7.5v9M7.5 12h9" fill="none" stroke-width="2" stroke-linecap="round"/>';
  } else if (/hoodie|sweatshirt/.test(n)) {
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
    // Each card sits in a cell so supplier-linked garments can carry a
    // "View more" button underneath (a button can't live inside the card button).
    // The card shows the first lines of the description; View more has all of it.
    grid.innerHTML = garments.map(g => `
      <div class="option-cell">
        <button type="button" class="option-card ${g.id === state.selectedGarmentId ? 'selected' : ''}" data-garment-id="${g.id}">
          ${g.imageUrl ? `<img src="${g.imageUrl}" alt="${g.name}">` : `<div style="aspect-ratio:1/1;background:var(--3t-light-gray);border-radius:6px;display:flex;align-items:center;justify-content:center;padding:22%;">${garmentIconSvg(g.name)}</div>`}
          <div class="oc-title">${g.name}</div>
          <div class="oc-sub">${g.brand ? g.brand + ' · ' : ''}${g.description || ''}</div>
        </button>
        ${g.specs ? `<button type="button" class="specs-btn" data-specs-id="${g.id}" aria-haspopup="dialog">View more</button>` : ''}
      </div>`).join('');

    grid.querySelectorAll('[data-garment-id]').forEach(card => {
      card.addEventListener('click', () => selectGarment(Number(card.dataset.garmentId)));
    });
    grid.querySelectorAll('[data-specs-id]').forEach(btn => {
      btn.addEventListener('click', () => openSpecs(Number(btn.dataset.specsId), btn));
    });
    syncOtherGarmentBox();
  } catch (err) {
    grid.innerHTML = `<div class="prereq-notice">
      <p>We couldn't load garments (${err.message || 'network error'}).</p>
      <button type="button" class="btn btn-dark btn-sm" id="retryGarmentsBtn">Retry</button>
    </div>`;
    document.getElementById('retryGarmentsBtn').addEventListener('click', loadGarments);
  }
}

// "View more": the supplier's full feature list (fabric, weight, fit) and size
// chart for a garment, in a dialog over the builder.
let specsReturnFocus = null;
function openSpecs(id, opener) {
  const g = state.garments.find(x => x.id === id);
  if (!g || !g.specs) return;
  const { features, sizeChart } = g.specs;
  const styleLine = [g.specs.brand || g.brand, g.specs.style || g.styleNumber].filter(Boolean).join(' ');
  closeSpecs();
  const host = document.createElement('div');
  host.className = 'specs-modal';
  host.id = 'specsModal';
  host.innerHTML = `
    <div class="specs-panel" role="dialog" aria-modal="true" aria-labelledby="specsTitle">
      <div class="specs-head">
        <div>
          <h2 id="specsTitle">${esc(g.name)}</h2>
          ${styleLine ? `<div class="muted">${esc(styleLine)}</div>` : ''}
        </div>
        <button type="button" class="specs-close" id="specsCloseBtn" aria-label="Close details">&times;</button>
      </div>
      <div class="specs-body">
        ${features.length ? `<h3>Details</h3><ul class="specs-list">${features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        ${sizeChart ? `<h3>Size guide</h3>
          <div class="specs-table-wrap"><table class="specs-table">
            <thead><tr><th scope="col"></th>${sizeChart.sizes.map(s => `<th scope="col">${esc(s)}</th>`).join('')}</tr></thead>
            <tbody>${sizeChart.rows.map(r => `<tr><th scope="row">${esc(r.name)}</th>${r.values.map(v => `<td>${esc(v) || '&ndash;'}</td>`).join('')}</tr>`).join('')}</tbody>
          </table></div>
          <p class="muted specs-note">Measurements are in inches and can vary slightly.</p>` : ''}
      </div>
      <div class="specs-foot">
        <button type="button" class="btn btn-primary btn-sm" id="specsChooseBtn">Choose this garment</button>
      </div>
    </div>`;
  document.body.appendChild(host);
  specsReturnFocus = opener || null;
  host.addEventListener('click', (e) => { if (e.target === host) closeSpecs(); });
  document.getElementById('specsCloseBtn').addEventListener('click', closeSpecs);
  document.getElementById('specsChooseBtn').addEventListener('click', () => { specsReturnFocus = null; closeSpecs(); selectGarment(id); });
  document.getElementById('specsCloseBtn').focus();
}
function closeSpecs() {
  const host = document.getElementById('specsModal');
  if (!host) return;
  host.remove();
  if (specsReturnFocus && document.contains(specsReturnFocus)) specsReturnFocus.focus();
  specsReturnFocus = null;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSpecs(); });

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
  // "Other" stays on this step so the customer can describe the garment.
  if (garment.isOther) {
    syncOtherGarmentBox();
    document.getElementById('otherGarmentDescription').focus();
    return;
  }
  syncOtherGarmentBox();
  // Auto-advance to whatever step follows 'garment' in the current order,
  // not a hardcoded index — Settings > Layout can move 'garment' anywhere.
  goToStep(STEPS.indexOf('garment') + 1);
}

function selectedGarmentIsOther() {
  const g = state.garments.find(x => x.id === state.selectedGarmentId);
  return !!(g && g.isOther);
}
function syncOtherGarmentBox() {
  const isOther = selectedGarmentIsOther();
  document.getElementById('otherGarmentBox').classList.toggle('hidden', !isOther);
  const input = document.getElementById('otherGarmentDescription');
  if (input.value !== (state.customGarmentDescription || '')) input.value = state.customGarmentDescription || '';
  document.getElementById('otherGarmentNextBtn').disabled = !(state.customGarmentDescription || '').trim();
}
document.getElementById('otherGarmentDescription').addEventListener('input', (e) => {
  state.customGarmentDescription = e.target.value;
  document.getElementById('otherGarmentNextBtn').disabled = !e.target.value.trim();
  saveState();
  updateSummary();
});
document.getElementById('customerSuppliedCheckbox').checked = !!state.customerSuppliedGarment;
document.getElementById('customerSuppliedCheckbox').addEventListener('change', (e) => {
  state.customerSuppliedGarment = e.target.checked;
  saveState();
  updateSummary();
});

// ---------------------------------------------------------------- STEP 2: color
// Garments synced from a supplier can carry 50+ colors, so the grid opens
// on the ten everyday ones — red, orange, yellow, green, blue, indigo (navy),
// violet, black, white, grey — and the rest sit behind "See all colors".
// Each family takes the color with the best-known name, else the closest
// shade; a family the garment has nothing close to is simply left out.
const POPULAR_COLOR_FAMILIES = [
  { hex: '#111111', names: ['black'] },
  { hex: '#FFFFFF', names: ['white'] },
  { hex: '#9A9A9A', names: ['sport grey', 'athletic heather', 'heather grey', 'grey', 'gray', 'dark heather grey', 'dark heather', 'graphite heather', 'charcoal'] },
  { hex: '#D0202E', names: ['red', 'true red', 'canvas red', 'cherry red'] },
  { hex: '#F2711C', names: ['orange', 'classic orange', 'safety orange'] },
  { hex: '#F7D417', names: ['yellow', 'daisy', 'gold', 'banana cream', 'safety yellow'] },
  { hex: '#1F9D4B', names: ['kelly green', 'irish green', 'kelly', 'green', 'forest green', 'forest'] },
  { hex: '#1F4FBF', names: ['royal', 'royal blue', 'true royal', 'blue'] },
  { hex: '#1B2447', names: ['navy', 'midnight navy', 'indigo'] },
  { hex: '#5B2A86', names: ['purple', 'purple rush', 'team purple', 'violet'] },
];
const POPULAR_COLOR_MAX_DISTANCE = 80; // how far (in RGB) a shade can be from a family and still stand in for it
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null;
}
function popularColorIds(colors) {
  const picked = new Set();
  for (const family of POPULAR_COLOR_FAMILIES) {
    const free = colors.filter(c => !picked.has(c.id));
    let best = null;
    for (const name of family.names) {
      best = free.find(c => String(c.name || '').trim().toLowerCase() === name);
      if (best) break;
    }
    if (!best) {
      const target = hexToRgb(family.hex);
      let bestDistance = POPULAR_COLOR_MAX_DISTANCE;
      for (const c of free) {
        const rgb = hexToRgb(c.hex);
        if (!rgb) continue;
        const distance = Math.hypot(rgb[0] - target[0], rgb[1] - target[1], rgb[2] - target[2]);
        if (distance < bestDistance) { best = c; bestDistance = distance; }
      }
    }
    if (best) picked.add(best.id);
  }
  return picked;
}

let colorsExpandedForGarment = null; // garment id whose full color list is open
function renderColorGrid() {
  const garment = state.garments.find(g => g.id === state.selectedGarmentId);
  const grid = document.getElementById('colorGrid');
  const toggle = document.getElementById('colorToggleBtn');
  if (!garment) { grid.innerHTML = ''; toggle.classList.add('hidden'); return; }
  // Short lists are shown whole: hiding only a handful of colors isn't worth a click.
  const popular = popularColorIds(garment.colors);
  const hasMore = popular.size > 0 && garment.colors.length - popular.size >= 5;
  const syncToggle = () => {
    const expanded = colorsExpandedForGarment === garment.id;
    grid.classList.toggle('collapsed', hasMore && !expanded);
    toggle.classList.toggle('hidden', !hasMore);
    toggle.textContent = expanded ? 'Show fewer colors' : `See all ${garment.colors.length} colors`;
    toggle.setAttribute('aria-expanded', String(expanded));
  };
  toggle.onclick = () => {
    colorsExpandedForGarment = colorsExpandedForGarment === garment.id ? null : garment.id;
    syncToggle();
  };
  syncToggle();
  grid.innerHTML = garment.colors.map(c => {
    const selected = state.selectedColors.some(sc => sc.id === c.id);
    return `<div class="color-swatch ${selected ? 'selected' : ''} ${hasMore && !popular.has(c.id) ? 'more-color' : ''}" data-color-id="${c.id}" data-name="${c.name}" data-hex="${c.hex}"
      role="button" tabindex="0" aria-pressed="${selected}" aria-label="Color: ${c.name}">
      <div class="chip" style="background:${c.hex}${c.swatchUrl ? ` url('${c.swatchUrl}') center/cover` : ''};"></div>
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
  const garment = state.garments.find(g => g.id === state.selectedGarmentId);
  wrap.innerHTML = state.selectedColors.map(c => {
    // Supplier stock for this color (S&S-linked garments only): a size with
    // no stock is disabled; asking for more than is in stock shows a note.
    const garmentColor = garment && garment.colors.find(gc => gc.id === c.id);
    const stock = garmentColor && garmentColor.stock ? garmentColor.stock : null;
    return `
    <div class="color-block">
      <div class="color-block-head">
        <div class="chip-sm" style="background:${c.hex}${garmentColor && garmentColor.swatchUrl ? ` url('${garmentColor.swatchUrl}') center/cover` : ''};"></div>
        <div class="color-block-title">${c.name}</div>
      </div>
      <div class="size-matrix" data-color-id="${c.id}">
        ${state.garmentSizes.map(s => {
          const qty = (state.sizesByColor[c.id] && state.sizesByColor[c.id][s.label]) || 0;
          const available = stock ? (stock[s.label] || 0) : null;
          const soldOut = available === 0;
          return `<div class="size-row${soldOut ? ' size-row-soldout' : ''}">
            <div>
              <div class="size-label">${s.label}</div>
              ${s.surcharge > 0 ? `<div class="size-surcharge">+$${s.surcharge.toFixed(2)}/shirt</div>` : ''}
              ${soldOut ? `<div class="size-surcharge">Out of stock</div>` : ''}
              <div class="size-surcharge stock-note" data-available="${available ?? ''}" ${available != null && qty > available && !soldOut ? '' : 'hidden'}>Only ${available ?? 0} in stock right now. We'll confirm with you.</div>
            </div>
            <div class="qty-stepper" data-size="${s.label}">
              <button type="button" data-delta="-1" ${soldOut ? 'disabled' : ''}>−</button>
              <input type="number" min="0" value="${soldOut ? 0 : qty}" inputmode="numeric" ${soldOut ? 'disabled' : ''} aria-label="${c.name} ${s.label} quantity${soldOut ? ' (out of stock)' : ''}">
              <button type="button" data-delta="1" ${soldOut ? 'disabled' : ''}>+</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
  }).join('');

  wrap.querySelectorAll('.size-matrix').forEach(matrix => {
    const colorId = Number(matrix.dataset.colorId);
    matrix.querySelectorAll('.qty-stepper').forEach(stepper => {
      const sizeLabel = stepper.dataset.size;
      const input = stepper.querySelector('input');
      const stockNote = stepper.closest('.size-row').querySelector('.stock-note');
      const commit = (val) => {
        const v = Math.max(0, Math.floor(Number(val) || 0));
        state.sizesByColor[colorId] = state.sizesByColor[colorId] || {};
        state.sizesByColor[colorId][sizeLabel] = v;
        input.value = v;
        if (stockNote && stockNote.dataset.available !== '') stockNote.hidden = !(v > Number(stockNote.dataset.available));
        saveState();
        onSizesChanged();
      };
      // A size that sold out since the customer's saved draft: drop its quantity.
      if (input.disabled && state.sizesByColor[colorId] && state.sizesByColor[colorId][sizeLabel]) {
        state.sizesByColor[colorId][sizeLabel] = 0;
        saveState();
      }
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
    // 1,000+ pieces: NOT blocked. The customer keeps building their order
    // normally, they just get routed to production review at the end
    // instead of instant checkout (see the Contact step's submit button).
    bulkBanner.classList.remove('hidden');
    bulkBanner.innerHTML = `<h4>Large Order: ${qty.toLocaleString('en-US')} Pieces</h4>
      <p>Orders of 1,000 pieces or more get a preliminary volume estimate. We'll review the details with you before checkout. Keep building your order below as usual.</p>`;
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
    return { id, designSize: (loc && !fixedDesignSize(loc.code) && state.designSizes[loc.code]) || 'standard' };
  });
}

// Widths come from Settings > Layout > Design Sizes (via /api/business-info).
const DESIGN_SIZE_OPTIONS = [
  { value: 'standard', label: 'Standard', dims: '' },
  { value: 'large', label: 'Large Graphic', dims: '' },
  { value: 'oversized', label: 'Oversized', dims: '' },
];
function applyDesignSizes() {
  if (!window.Placement) return;
  Placement.setSizes(state.businessInfo && state.businessInfo.designSizes);
  for (const o of DESIGN_SIZE_OPTIONS) o.dims = `${Placement.DESIGN_SIZES[o.value].wIn}in Width x Proportionate Height`;
}
applyDesignSizes();
// Chest and upper-back prints come in one size, so they have no size choice.
function fixedDesignSize(locationCode) {
  return window.Placement ? Placement.fixedSizeFor(locationCode) : null;
}

function designSizeSurchargeFor(value) {
  if (value === 'large') return state.businessInfo?.designSizeSurcharges?.large ?? 1.50;
  if (value === 'oversized') return state.businessInfo?.designSizeSurcharges?.oversized ?? 2.50;
  return 0;
}

function renderUploadSections() {
  const wrap = document.getElementById('uploadSections');
  const locs = selectedLocationObjects();
  locs.forEach(l => { if (!state.designSizes[l.code] || fixedDesignSize(l.code)) state.designSizes[l.code] = 'standard'; });

  wrap.innerHTML = locs.map(l => `
    <div class="upload-section" data-loc-code="${l.code}">
      <div class="color-block-title mb-0">${l.name.toUpperCase()} DESIGN</div>

      ${fixedDesignSize(l.code) ? `<div class="field mt-8 mb-0">
        <label>Design Size <span class="muted design-size-dims" style="font-weight:400;">${fixedDesignSize(l.code).label}: up to ${fixedDesignSize(l.code).wIn}in wide x ${fixedDesignSize(l.code).hIn}in tall</span></label>
      </div>` : `<div class="field mt-8 mb-0">
        <label>Design Size <span class="muted design-size-dims" style="font-weight:400;">${DESIGN_SIZE_OPTIONS.find(o => o.value === state.designSizes[l.code])?.dims || ''}</span></label>
        <div class="radio-pill-group" data-design-size-group="${l.code}">
          ${DESIGN_SIZE_OPTIONS.map(o => {
            const surcharge = designSizeSurchargeFor(o.value);
            const priceText = surcharge > 0 ? ` (+$${surcharge.toFixed(2)}/shirt)` : '';
            const selected = state.designSizes[l.code] === o.value;
            return `<div class="radio-pill ${selected ? 'selected' : ''}" data-value="${o.value}" title="${o.dims}" role="button" tabindex="0" aria-pressed="${selected}">${o.label}${priceText}</div>`;
          }).join('')}
        </div>
      </div>`}

      <div class="mt-8 file-list" data-loc-code-list="${l.code}">
        ${(state.uploads[l.code] || []).map(f => fileChipHtml(f, l.code)).join('')}
      </div>
      <div class="upload-dropzone mt-8" data-loc-code-drop="${l.code}">
        <div class="icon">📎</div>
        <div>
          <div class="ud-title">${(state.uploads[l.code] || []).length ? 'Upload another file' : 'Click to upload artwork'}</div>
          <div class="muted ud-types">PNG, JPG, PDF, or SVG</div>
        </div>
        <input type="file" accept=".png,.jpg,.jpeg,.pdf,.svg" style="display:none;">
      </div>
      <div class="pl-host" data-pl-host="${l.code}"></div>
    </div>
  `).join('');
  mountPlacementEditors(locs);

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

  // "I'll send it later" only applies while nothing is uploaded: once a
  // design is in, the option is hidden and no longer counts.
  const hasUploads = totalUploadsCount() > 0;
  if (hasUploads && state.artworkPending) { state.artworkPending = false; saveState(); }
  const laterCheckbox = document.getElementById('artworkLaterCheckbox');
  if (laterCheckbox) {
    laterCheckbox.checked = !!state.artworkPending;
    laterCheckbox.closest('.artwork-plan-field').classList.toggle('hidden', hasUploads);
  }
  const artworkTerms = document.getElementById('artworkTermsCheckbox');
  if (artworkTerms) artworkTerms.checked = !!state.artworkTermsAccepted;
  updateArtworkNextBtn();
}

// Design preview: once a picture is uploaded for a print location, show it
// on the garment photo inside that location's print area, where the customer
// can resize and move it. What they set is saved with the quote.
function mountPlacementEditors(locs) {
  if (!window.Placement) return;
  state.placements = state.placements || {};
  const garment = state.garments.find(g => g.id === state.selectedGarmentId);
  const colors = state.selectedColors.map(sc => {
    const gc = garment && garment.colors.find(c => c.id === sc.id);
    return { name: sc.name, hex: sc.hex, imageUrl: gc && gc.imageUrl };
  });
  for (const code of Object.keys(state.placements)) if (!locs.some(l => l.code === code)) delete state.placements[code];
  locs.forEach(l => {
    const host = document.querySelector(`[data-pl-host="${l.code}"]`);
    if (!host) return;
    const files = state.uploads[l.code] || [];
    const file = files.find(Placement.isPreviewableFile);
    if (!file || !garment || garment.isOther || state.customerSuppliedGarment) {
      delete state.placements[l.code];
      host.innerHTML = files.length && !file ? '<p class="muted pl-note">PDF files can\'t be previewed on the garment. Upload a PNG, JPG or SVG to see a preview.</p>' : '';
      return;
    }
    if (!Placement.supports(l.code)) {
      delete state.placements[l.code];
      host.innerHTML = '<p class="muted pl-note">There is no preview for this print location yet. We\'ll place your design using your notes.</p>';
      return;
    }
    const saved = state.placements[l.code];
    const sameArt = saved && saved.artworkUrl === file.url;
    Placement.mountEditor(host, {
      locationCode: l.code, locationName: l.name, designSize: state.designSizes[l.code], garmentMockup: garment.mockup,
      colors, colorName: saved && saved.colorName, artworkUrl: file.url,
      placement: sameArt ? { wIn: saved.wIn, xIn: saved.xIn, yIn: saved.yIn } : null,
      onChange: (record) => { state.placements[l.code] = record; saveState(); },
    });
    // With a preview showing, the upload button lives in its controls, under the heading.
    const title = host.querySelector('.pl-title');
    const dropzone = document.querySelector(`[data-loc-code-drop="${l.code}"]`);
    if (title && dropzone) { dropzone.classList.remove('mt-8'); title.after(dropzone); }
  });
  saveState();
}

/** Total artwork files uploaded across every print location so far. */
function totalUploadsCount() {
  return Object.values(state.uploads).reduce((sum, arr) => sum + (arr ? arr.length : 0), 0);
}

// A customer must explicitly do one of two things before advancing past
// Artwork: upload at least one file, or check "I'll send artwork later" —
// silently skipping the step (the old behavior) is no longer possible.
// Either way, they also agree to the artwork terms at the end of the step.
function updateArtworkNextBtn() {
  const btn = document.getElementById('artworkNextBtn');
  if (!btn) return;
  btn.disabled = !((totalUploadsCount() > 0 || state.artworkPending) && state.artworkTermsAccepted);
}
document.getElementById('artworkTermsCheckbox')?.addEventListener('change', (e) => {
  state.artworkTermsAccepted = e.target.checked;
  saveState();
  updateArtworkNextBtn();
});

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
// The page's heading, optional fields and "what's this order for" choices
// come from Settings > Contact Form (via /api/business-info). These defaults
// match the page's built-in markup and are used until that loads.
const DEFAULT_CONTACT_FORM = {
  title: 'Your Information',
  subtitle: "We'll use this to send your quote and keep you posted on your order.",
  businessName: { show: true, label: 'Business / Organization', required: false },
  neededByDate: { show: true, label: 'Needed By Date', required: false },
  orderPurpose: { show: true, label: "What's this order for?", options: ['Special Event', 'Branded Merch', 'Promotional', 'Retail', 'Something Else'] },
  additionalNotes: { show: true, label: 'Additional Notes', placeholder: 'Anything else we should know?' },
};
function contactFormConfig() {
  return (state.businessInfo && state.businessInfo.contactForm) || DEFAULT_CONTACT_FORM;
}
function applyContactFormConfig() {
  const cfg = contactFormConfig();
  const $ = (id) => document.getElementById(id);
  $('contactTitle').textContent = cfg.title;
  $('contactSubtitle').textContent = cfg.subtitle;
  for (const key of ['businessName', 'neededByDate']) {
    $(key + 'Field').classList.toggle('hidden', !cfg[key].show);
    $(key + 'Label').innerHTML = esc(cfg[key].label) + (cfg[key].required ? ' <span class="req">*</span>' : '');
    $(key).required = !!cfg[key].required;
  }
  $('orderPurposeField').classList.toggle('hidden', !cfg.orderPurpose.show || !cfg.orderPurpose.options.length);
  $('orderPurposeLabelText').textContent = cfg.orderPurpose.label;
  $('orderPurposeGroup').innerHTML = cfg.orderPurpose.options.map(o =>
    `<div class="radio-pill" data-value="${esc(o)}" role="button" tabindex="0" aria-pressed="false">${esc(o)}</div>`).join('');
  $('additionalNotesField').classList.toggle('hidden', !cfg.additionalNotes.show);
  $('additionalNotesLabel').textContent = cfg.additionalNotes.label;
  $('additionalNotes').placeholder = cfg.additionalNotes.placeholder;
  // Drop anything saved earlier that the form no longer offers.
  const c = state.contact;
  c.orderPurposes = cfg.orderPurpose.show ? (c.orderPurposes || []).filter(p => cfg.orderPurpose.options.includes(p)) : [];
  if (!cfg.businessName.show) c.businessName = '';
  if (!cfg.neededByDate.show) c.neededByDate = '';
  if (!cfg.additionalNotes.show) c.additionalNotes = '';
}
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
  if (selectedGarmentIsOther() && !(state.customGarmentDescription || '').trim()) {
    showError('Please tell us which garment you want on the Garment step.');
    goToStep(STEPS.indexOf('garment'));
    return;
  }
  if (totalUploadsCount() === 0 && !state.artworkPending) {
    showError("Please go back to the Artwork step and either upload your artwork or check \"I'll send artwork later.\"");
    goToStep(STEPS.indexOf('artwork'));
    return;
  }
  if (!state.artworkTermsAccepted) {
    goToStep(STEPS.indexOf('artwork'));
    showError('Please agree to the artwork terms at the bottom of the Artwork step.');
    return;
  }
  const missingContactField = ['businessName', 'neededByDate'].find(k => {
    const f = contactFormConfig()[k];
    return f.show && f.required && !String(c[k] || '').trim();
  });
  if (missingContactField) {
    showError(`Please fill in "${contactFormConfig()[missingContactField].label}".`);
    return;
  }
  const reviewOrder = isReviewOrder();
  if (c.fulfillmentMethod === 'shipping') {
    const sa = c.shippingAddress || {};
    if (!sa.line1?.trim() || !sa.city?.trim() || !sa.state?.trim() || !sa.zip?.trim()) {
      showError('Please provide a complete shipping address (street, city, state, ZIP), or choose Local Pickup.');
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
      placements: selectedLocationObjects().map(l => (state.placements || {})[l.code]).filter(Boolean),
      draftToken: state.draftToken,
      firstName: c.firstName.trim(), lastName: c.lastName.trim(), email: c.email.trim(), phone: c.phone.trim(),
      businessName: c.businessName.trim() || null, orderPurpose: (c.orderPurposes || []).join(', ') || null,
      neededByDate: c.neededByDate || null, notes: c.additionalNotes.trim() || null,
      fulfillmentMethod: c.fulfillmentMethod,
      shippingAddress: c.fulfillmentMethod === 'shipping' ? c.shippingAddress : null,
      termsAccepted,
      artworkPending: !!state.artworkPending,
      customGarmentDescription: selectedGarmentIsOther() ? (state.customGarmentDescription || '').trim() : null,
      customerSuppliedGarment: !!state.customerSuppliedGarment,
    };
    const result = await api('/quotes', { method: 'POST', body: payload });
    if (window.track3T) window.track3T('quote_generated', { quoteCode: result.quoteCode });
    clearSavedState();
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

  let html = `<div class="summary-line"><span class="l">Garment</span><span class="r">${garment.isOther && (state.customGarmentDescription || '').trim() ? esc(state.customGarmentDescription.trim().slice(0, 60)) : garment.name}${state.customerSuppliedGarment ? ' (your own)' : ''}</span></div>`;
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
      html += `<div class="summary-note">Before sales tax. Your itemized quote shows tax and an optional rush fee; shipping, if chosen, is added at checkout.</div>`;
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
    applyDesignSizes();
    if (isValidStepOrder(info.stepOrder)) STEPS = info.stepOrder;
  } catch (e) {}
  try {
    const { tiers } = await api('/quantity-tiers');
    state.quantityTiers = tiers;
  } catch (e) {}
  applyContactFormConfig();
  showResumeNotice();
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
