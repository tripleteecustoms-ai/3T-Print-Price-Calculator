// public/js/print-builder.js — guided order flows for Stickers / Labels,
// Custom Posters / Prints, Custom Mylar Packs and Yard Signs
// (print.html?type=stickers|posters|mylar|yardsigns).
//
// The product type decides the flow (FLOWS below: which steps, in what
// order), the customer's configuration decides the price, and the server
// decides the total. What a product offers — sizes, price tables, option
// groups, add-ons, design methods and fees — comes from /api/print-catalog,
// edited in the admin under Print Products. Prices shown on the cards are
// the catalog's list prices; the order total in the summary always comes
// from the server (/api/estimate).
//
// Artwork is never altered: the product's print area is the canvas, and
// the customer's placement of the artwork on it (scale + position) is
// stored separately and sent with the order (see print-mockups.js).

const FAMILY_KEY = new URLSearchParams(location.search).get('type') || '';

// Each product type's steps, in order. "opt:<id>" is one of the product's
// option groups (its own step); "edit" is the artwork positioning step. A
// step the chosen product has nothing for is skipped (one product, a
// one-choice group, no add-ons, no artwork image to position).
const FLOWS = {
  stickers:  ['product', 'artwork', 'size', 'edit', 'quantity', 'mockup', 'opt:finish', 'addons', 'contact', 'review'],
  posters:   ['product', 'size', 'quantity', 'artwork', 'edit', 'mockup', 'opt:finish', 'addons', 'contact', 'review'],
  mylar:     ['artwork', 'product', 'size', 'opt:color', 'quantity', 'opt:sides', 'edit', 'mockup', 'opt:lamination', 'addons', 'contact', 'review'],
  yardsigns: ['product', 'size', 'quantity', 'opt:sides', 'artwork', 'edit', 'mockup', 'addons', 'contact', 'review'],
};
const SCENE_FAMILIES = ['posters', 'yardsigns']; // the size step shows the size to scale, so it is always shown
const DESIGN_STYLES = ['Luxury', 'Cartoon', 'Bold', 'Minimal', 'Streetwear', 'Futuristic', 'Retro', 'Other'];
const BORDER_PRESETS = [0, 0.05, 0.1];
const TEMPLATE_CATEGORIES = {
  signature: ['Signature Designs', 'Original 3T designs created in-house and available for customization.'],
  reusable: ['Reusable Designs', 'Choose an existing template and add your logo or brand information.'],
};
const NO_ARTWORK_LINE = "Don't have artwork? Have 3T create it for you.";
const CONFIRM_TEXT = 'I have reviewed my artwork, size, quantity, orientation, spelling, positioning, selected options, and order details. I understand 3T Print Solutions will produce the order according to the information submitted here.';

// The in-progress order is kept per product type so a refresh, or coming
// back later on the same device, doesn't lose it (same idea as builder.js).
const STATE_KEY = '3t_print_v3_' + FAMILY_KEY;
const STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_STATE = {
  stepIndex: 0,
  draftToken: null,
  productId: null,
  sizeId: null,
  customSize: null,          // { w, h } in inches when a custom size is entered
  qty: null,
  options: {},               // { groupId: choiceId }
  addonIds: [],
  design: { method: 'upload', logo: 'upload', templateId: null, brief: {} },
  uploads: { front: null, back: null, logo: null, reference: [] },
  orientation: null,         // posters: portrait | landscape
  border: 0.05,              // stickers: white border around the artwork, inches
  backArtwork: 'same',       // double-sided signs: same | different
  placements: {},            // artwork placement on the print canvas: { front, back }
  wall: null,                // posters: where the poster hangs in the room preview
  designNotes: '',
  rush: false,
  contact: {
    firstName: '', lastName: '', email: '', phone: '', businessName: '', neededByDate: '',
    additionalNotes: '', fulfillmentMethod: 'pickup', shippingAddress: {},
  },
};
const state = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), loadState() || {});
let family = null;        // this product type, from the catalog
let businessInfo = null;
let estimate = null;      // the server's price for the current selection
let estimateError = '';
let STEPS = ['product'];
let confirmed = false;    // the review step's confirmation; never restored from a saved order
let viewSide = 'front';   // which side the editor / preview is showing
let galleryTab = 'signature';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(n) { return '$' + Number(n).toFixed(2); }
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...state, savedAt: Date.now() })); } catch (e) {}
}
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY));
    if (saved && Date.now() - (saved.savedAt || 0) < STATE_MAX_AGE_MS) return saved;
  } catch (e) {}
  return null;
}
function clearSavedState() { try { localStorage.removeItem(STATE_KEY); } catch (e) {} }

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
const $ = (id) => document.getElementById(id);
const body = $('stepBody');

// ---------------------------------------------------------------- selection
function product() { return family.products.find(p => p.id === state.productId) || null; }
// Until a product is picked, the steps and labels follow the first product.
function shownProduct() { return product() || family.products[0]; }
function sizeObj() { const p = product(); return p ? p.sizes.find(s => s.id === state.sizeId) || null : null; }
function unitLabel(p, qty) { return qty === 1 ? p.unit : p.unit + 's'; }
function design() { return shownProduct().design; }
function group(id) { return shownProduct().options.find(g => g.id === id) || null; }
function choiceOf(g) { return g.choices.find(c => c.id === state.options[g.id]) || g.choices[0]; }
function isImage(f) { return !!f && /^image\//.test(f.mimeType || ''); }
function method() { return design().enabled ? state.design.method : 'upload'; }
function swatchClass(swatch) { return ['holographic', 'silver', 'gold'].includes(swatch) ? swatch : ''; }

// --- display-only mirrors of the server's pricing rules (server/printProducts.js),
// --- used for the prices printed on cards; the order total never comes from here.
// The price table in force: for products priced from a table of option
// combinations (mylar: sides × finish), the one for the chosen combination.
function tableFor(p, size, options) {
  const tableGroups = p.options.filter(g => g.table);
  if (!tableGroups.length) return size.packs;
  const pick = options || state.options;
  const key = tableGroups.map(g => (g.choices.find(c => c.id === pick[g.id]) || g.choices[0]).id).join('|');
  const found = (size.tables || []).find(t => t.key === key);
  return found ? found.packs : [];
}
function listPrice(p, size, qty, options) {
  const table = tableFor(p, size, options);
  const exact = table.find(k => k.qty === qty);
  if (exact) return exact.price;
  const lower = [...table].reverse().find(k => k.qty <= qty);
  if (!p.customQty || !lower) return null;
  const next = table.find(k => k.qty > qty);
  const amount = Math.round((lower.price / lower.qty) * qty * 100) / 100;
  return next ? Math.min(amount, next.price) : amount;
}
function eachPrice(choice, qty) {
  if (!choice.each.length) return 0;
  const reached = choice.each.filter(b => b.minQty <= (qty || 1));
  return (reached.length ? reached[reached.length - 1] : choice.each[0]).price;
}
// A custom size is priced as the smallest listed size it fits inside.
function customFit(p, custom) {
  if (!custom || !(custom.w >= 0.5 && custom.h >= 0.5)) return null;
  const short = Math.min(custom.w, custom.h), long = Math.max(custom.w, custom.h);
  return p.sizes.filter(s => s.w && s.h && Math.min(s.w, s.h) >= short && Math.max(s.w, s.h) >= long)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
}
function pricingSize() { const p = product(); return p ? (state.customSize ? customFit(p, state.customSize) : sizeObj()) : null; }
function sizeChosen() { return !!pricingSize(); }
// The product's width × height as it will be made (posters can be turned landscape).
function dims() {
  const s = state.customSize || sizeObj();
  if (!s) return null;
  let w = Number(s.w) || 0, h = Number(s.h) || 0;
  if (!w || !h) return null;
  if (state.orientation === 'landscape') [w, h] = [Math.max(w, h), Math.min(w, h)];
  if (state.orientation === 'portrait') [w, h] = [Math.min(w, h), Math.max(w, h)];
  return { w, h };
}
// The print canvas the artwork is placed on: the whole product, or a
// listed size's own printable area (the label on a mylar bag).
function canvasDims() {
  const d = dims();
  if (!d) return null;
  const s = state.customSize ? null : sizeObj();
  if (family.key === 'mylar') return { w: (s && s.printW) || Math.round(d.w * 906) / 1000, h: (s && s.printH) || Math.round(d.h * 940) / 1000 };
  return d;
}
function sizeText() {
  if (state.customSize) return `${state.customSize.w}×${state.customSize.h} in (custom)`;
  const s = sizeObj();
  return s ? s.label : '';
}
function isDouble() { const g = group('sides'); return !!g && choiceOf(g).id === 'double'; }
// A second upload is needed when the back carries its own artwork: always
// for double-sided packs, and for double-sided signs when the customer says so.
function hasBackSlot() {
  if (method() !== 'upload' || !isDouble()) return false;
  return family.key !== 'yardsigns' || state.backArtwork === 'different';
}
// Mylar asks for the design first, before single / double-sided is chosen:
// the back design is optional there, and asked for again on the Printing
// step if the customer picks double-sided without one.
function sidesComeLater() {
  const flow = FLOWS[family.key];
  return !!group('sides') && flow.indexOf('artwork') < flow.indexOf('opt:sides');
}
function sidesShown() { return isDouble() ? ['front', 'back'] : ['front']; }
// The image for a side, if there is one we can draw.
function artFor(side) {
  if (method() === 'premade') {
    const t = design().templates.find(x => x.id === state.design.templateId);
    return t ? (side === 'back' ? t.backImageUrl : t.imageUrl) || null : null;
  }
  if (method() === 'custom') return null;
  const f = side === 'back' && hasBackSlot() ? state.uploads.back : state.uploads.front;
  return isImage(f) ? f.url : null;
}
// The sides whose artwork the customer can position (their own uploaded images).
function editableSides() {
  if (!product() || method() !== 'upload') return [];
  return (hasBackSlot() ? ['front', 'back'] : ['front']).filter(side => isImage(state.uploads[side]));
}
function selectionPayload() {
  const p = product();
  return {
    family: family.key, productId: state.productId, qty: state.qty,
    ...(state.customSize ? { customSize: state.customSize } : { sizeId: state.sizeId }),
    options: state.options, addonIds: state.addonIds,
    design: p.design.enabled ? state.design : null,
    orientation: family.key === 'posters' ? state.orientation : null,
    border: family.key === 'stickers' ? state.border : null,
    backArtwork: family.key === 'yardsigns' && isDouble() ? state.backArtwork : null,
    placements: state.placements,
    wall: family.key === 'posters' ? state.wall : null,
    artworkConfirmed: confirmed,
  };
}

// ---------------------------------------------------------------- steps
function computeSteps() {
  const p = shownProduct();
  const flow = FLOWS[family.key];
  const groups = p.options.filter(g => g.choices.length > 1);
  const steps = [];
  for (const s of flow) {
    if (s === 'product') { if (family.products.length > 1) steps.push(s); }
    else if (s === 'size') { if (p.sizes.length > 1 || p.customSize || SCENE_FAMILIES.includes(family.key)) steps.push(s); }
    else if (s === 'edit') { if (editableSides().length) steps.push(s); }
    else if (s.startsWith('opt:')) { if (groups.some(g => 'opt:' + g.id === s)) steps.push(s); }
    else if (s === 'addons') {
      // option groups the flow doesn't place get their own step here, so a
      // group added in the admin later shows up without changing this file
      groups.filter(g => !flow.includes('opt:' + g.id)).forEach(g => steps.push('opt:' + g.id));
      if (p.addons.length) steps.push(s);
    } else steps.push(s);
  }
  return steps;
}
function stepLabel(s) {
  if (s.startsWith('opt:')) { const g = group(s.slice(4)); return g ? g.name : 'Options'; }
  return { product: 'Product', size: 'Size', quantity: 'Quantity', artwork: design().premade ? 'Design' : 'Artwork', edit: 'Position', mockup: 'Preview', addons: 'Add-ons', contact: 'Info', review: 'Review' }[s];
}
// Drop anything saved earlier that the catalog no longer offers.
function reconcileSelection() {
  if (family.products.length === 1) state.productId = family.products[0].id;
  if (!product()) Object.assign(state, { productId: null, sizeId: null, customSize: null, qty: null, options: {}, addonIds: [] });
  const p = product();
  if (p) {
    if (p.sizes.length === 1 && !p.customSize) state.sizeId = p.sizes[0].id;
    if (state.sizeId && !sizeObj()) state.sizeId = null;
    if (state.customSize && !p.customSize) state.customSize = null;
    for (const id of Object.keys(state.options)) { const g = group(id); if (!g || !g.choices.some(c => c.id === state.options[id])) delete state.options[id]; }
    state.addonIds = state.addonIds.filter(id => {
      const a = p.addons.find(x => x.id === id);
      return a && !(a.minQty && (state.qty || 0) < a.minQty);
    });
    const d = p.design;
    if (!d.enabled || (state.design.method === 'premade' && !d.premade) || (state.design.method === 'custom' && !d.custom)) state.design.method = 'upload';
  }
  // a back design uploaded before the Printing step means double-sided, until the customer says otherwise
  if (sidesComeLater() && state.uploads.back && method() === 'upload' && !state.options.sides) state.options.sides = 'double';
  const current = STEPS[state.stepIndex];
  STEPS = computeSteps();
  // keep the customer on the step they were on when the list of steps changes around it
  if (current && STEPS.includes(current)) state.stepIndex = STEPS.indexOf(current);
}

function renderStepRail() {
  $('stepRail').innerHTML = STEPS.map((s, i) => {
    const cls = i === state.stepIndex ? 'active' : (i < state.stepIndex ? 'done' : '');
    return `<div class="step-pill ${cls}" data-step-index="${i}" role="button" tabindex="0">${esc(stepLabel(s))}</div>`;
  }).join('');
  $('headerStepLabel').textContent = `Step ${state.stepIndex + 1} of ${STEPS.length}`;
}
$('stepRail').addEventListener('click', (e) => {
  const pill = e.target.closest('[data-step-index]');
  if (pill) goToStep(Number(pill.dataset.stepIndex));
});
function activateOnKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('[role="button"]');
  if (!el) return;
  e.preventDefault();
  el.click();
}
$('stepRail').addEventListener('keydown', activateOnKey);
body.addEventListener('keydown', activateOnKey);
$('fulfillmentGroup').addEventListener('keydown', activateOnKey);

function currentStep() { return STEPS[state.stepIndex]; }
function goToStep(index) {
  clearError();
  // Going back from the first step returns to the "What are you ordering?" page.
  if (index < 0) { window.location.href = '/'; return; }
  state.stepIndex = Math.min(STEPS.length - 1, index);
  saveState();
  renderStep();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.track3T) window.track3T('step_view', { step: `${family.key}:${currentStep()}` });
}
function goToNamed(name) { const i = STEPS.indexOf(name); if (i >= 0) goToStep(i); }

// What still has to be chosen before a step can be shown, as [message, step to go to].
function missingFor(step) {
  const order = FLOWS[family.key];
  const position = order.indexOf(order.includes(step) ? step : 'addons');
  const after = (earlier) => order.indexOf(earlier) < position;
  if (after('product') && !product()) return ['Please choose a product first.', 'product'];
  if (after('size') && !sizeChosen() && STEPS.includes('size')) return ['Please choose a size first.', 'size'];
  if (after('quantity') && !state.qty) return ['Please choose a quantity first.', 'quantity'];
  // the Printing step itself collects a missing back design (see renderOptionStep), so the front is enough to open it
  const backAskedHere = step === 'opt:sides' && sidesComeLater() && method() === 'upload' && !!state.uploads.front;
  if (after('artwork') && step !== 'contact' && !backAskedHere && !artworkReady()) return ['Please add your artwork first.', 'artwork'];
  return null;
}

function renderStep() {
  const step = currentStep();
  const isContact = step === 'contact';
  $('dynStep').classList.toggle('active', !isContact);
  $('contactStep').classList.toggle('active', isContact);
  renderStepRail();
  if (isContact) { $('contactEyebrow').textContent = `Step ${state.stepIndex + 1}`; hydrateContactForm(); return; }

  $('stepEyebrow').textContent = `Step ${state.stepIndex + 1}`;
  stepMessage('');
  $('stepNextBtn').textContent = step === 'review' ? 'Confirm & Checkout' : 'Continue';
  $('stepBackBtn').textContent = 'Back';
  const missing = step === 'product' ? null : missingFor(step);
  if (missing) {
    setHead(stepLabel(step), '');
    body.innerHTML = `<div class="prereq-notice"><p>${missing[0]}</p><button type="button" class="btn btn-dark btn-sm" data-goto="${missing[1]}">Go to ${esc(stepLabel(missing[1]))}</button></div>`;
    setNext(false);
    return;
  }
  if (step.startsWith('opt:')) renderOptionStep(group(step.slice(4)));
  else ({ product: renderProducts, size: renderSizes, quantity: renderQuantity, artwork: renderArtworkStep, edit: renderEditStep, mockup: renderMockupStep, addons: renderAddons, review: renderReview })[step]();
}
function setHead(title, sub) { $('stepTitle').textContent = title; $('stepSub').textContent = sub || ''; }
function setNext(enabled) { $('stepNextBtn').disabled = !enabled; }
function stepMessage(msg) { const el = $('stepMsg'); el.textContent = msg || ''; el.classList.toggle('hidden', !msg); }

$('stepBackBtn').addEventListener('click', () => goToStep(state.stepIndex - 1));
$('stepNextBtn').addEventListener('click', () => {
  if ($('stepNextBtn').disabled) return;
  if (currentStep() === 'review') submitQuote(); else goToStep(state.stepIndex + 1);
});
$('contactBackBtn').addEventListener('click', () => goToStep(state.stepIndex - 1));

// One click handler for everything drawn into the step body.
body.addEventListener('click', (e) => {
  const t = e.target.closest('[data-goto],[data-product-id],[data-size-id],[data-qty],[data-choice],[data-method],[data-logo],[data-template],[data-style],[data-slot-add],[data-slot-remove],[data-pill],[data-act]');
  if (!t) return;
  if (t.tagName === 'A') e.preventDefault();
  const d = t.dataset;
  if (d.goto) return goToNamed(d.goto);
  if (d.productId) return pickProduct(d.productId);
  if (d.sizeId) return pickSize(d.sizeId);
  if (d.qty) return pickQty(Number(d.qty));
  if (d.choice) return pickChoice(d.group, d.choice);
  if (d.method) return setMethod(d.method);
  if (d.logo) { state.design.logo = d.logo; refreshEstimate(); return renderStep(); }
  if (d.template) return openTemplate(d.template);
  if (d.style) { state.design.brief.style = d.style; saveState(); return renderStep(); }
  if (d.slotAdd) return chooseFile(d.slotAdd);
  if (d.slotRemove) return removeFile(d.slotRemove, d.fileId);
  if (d.pill) return pickPill(d.pill, d.value);
  if (d.act === 'center' && roomMock) roomMock.center();
});
function setMethod(m) {
  state.design.method = m;
  reconcileSelection();
  refreshEstimate();
  renderStep();
}

// ---------------------------------------------------------------- product
function renderProducts() {
  setHead('Choose Your Product', "Pick what you'd like us to print.");
  const from = (p) => Math.min(...p.sizes.flatMap(s => [...s.packs, ...(s.tables || []).flatMap(t => t.packs)].map(k => k.price)));
  body.innerHTML = `<div class="option-grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr));">${family.products.map(p => `
    <div class="option-card ${p.id === state.productId ? 'selected' : ''}" data-product-id="${esc(p.id)}" role="button" tabindex="0" aria-pressed="${p.id === state.productId}">
      ${family.key === 'mylar' && p.sizes[0].w ? `<div data-bag-thumb="${esc(p.id)}" style="height:110px;display:flex;justify-content:center;"></div>` : ''}
      <div class="oc-title">${esc(p.name)}</div>
      <div class="oc-sub">${esc(p.description)}</div>
      ${p.sizes[0].w && family.key === 'mylar' ? `<div class="oc-sub">About ${p.sizes[0].w}×${p.sizes[0].h} in</div>` : ''}
      <div class="oc-price">From ${money(from(p))}</div>
    </div>`).join('')}</div>`;
  body.querySelectorAll('[data-bag-thumb]').forEach(el => {
    const s = family.products.find(x => x.id === el.dataset.bagThumb).sizes[0];
    PrintMockups.bag(el, { w: s.w, h: s.h, printW: s.printW, printH: s.printH, swatch: '#111111' });
    el.querySelector('svg').style.cssText = 'height:110px;width:auto;';
  });
  setNext(!!product());
}
function pickProduct(id) {
  if (state.productId !== id) {
    Object.assign(state, { productId: id, sizeId: null, customSize: null, qty: null, options: {}, addonIds: [], placements: {} });
    estimate = null;
    // a premade design picked before the product only carries over if this product offers it
    const offered = family.products.find(p => p.id === id).design.templates;
    if (state.design.templateId && !offered.some(t => t.id === state.design.templateId)) state.design.templateId = null;
  }
  reconcileSelection();
  updateSummary();
  goToStep(STEPS.indexOf('product') + 1);
}

// ---------------------------------------------------------------- size
function renderSizes() {
  const p = product();
  setHead('Choose Your Size', p.description);
  // Each card: the size and its lowest price; once a quantity is picked, also what that quantity costs.
  const priceLine = (s) => {
    const table = tableFor(p, s);
    const from = table.length ? `From ${money(Math.min(...table.map(k => k.price)))}` : '';
    const amount = state.qty ? listPrice(p, s, state.qty) : null;
    return `<div class="oc-price">${from}</div>${amount != null ? `<div class="oc-sub">${money(amount)} for ${state.qty.toLocaleString('en-US')}</div>` : ''}`;
  };
  const c = state.customSize;
  body.innerHTML = `
    <div class="option-grid ${family.key === 'posters' ? 'size-grid-4' : ''}">${p.sizes.map(s => `
      <div class="option-card ${!c && s.id === state.sizeId ? 'selected' : ''}" data-size-id="${esc(s.id)}" role="button" tabindex="0" aria-pressed="${!c && s.id === state.sizeId}">
        <div class="oc-title" style="font-size:17px;">${esc(s.label.replace(/ in$/, ''))}</div>
        ${priceLine(s)}
      </div>`).join('')}</div>
    ${p.customSize ? `
    <div class="sub-heading">Custom size</div>
    <div class="inline-fields">
      <div class="field"><label for="customW">Width (in)</label><input type="number" id="customW" min="0.5" step="0.25" inputmode="decimal" value="${c ? c.w : ''}"></div>
      <div class="field"><label for="customH">Height (in)</label><input type="number" id="customH" min="0.5" step="0.25" inputmode="decimal" value="${c ? c.h : ''}"></div>
    </div>
    <p class="muted" id="customSizeNote" style="font-size:12.5px;margin-top:8px;"></p>` : ''}
    ${SCENE_FAMILIES.includes(family.key) ? '<div class="mock-wrap" id="sizeScene"></div><p class="mock-note">Size preview is an approximate visual representation.</p>' : ''}`;
  if (p.customSize) {
    const onInput = () => {
      const w = Number($('customW').value), h = Number($('customH').value);
      if (!$('customW').value && !$('customH').value) { state.customSize = null; }
      else { state.customSize = { w, h }; state.sizeId = null; }
      body.querySelectorAll('[data-size-id]').forEach(el => el.classList.toggle('selected', !state.customSize && el.dataset.sizeId === state.sizeId));
      afterSizeChange();
    };
    $('customW').addEventListener('input', onInput);
    $('customH').addEventListener('input', onInput);
  }
  afterSizeChange();
}
function afterSizeChange() {
  const p = product();
  const note = $('customSizeNote');
  if (note) {
    const fit = state.customSize ? customFit(p, state.customSize) : null;
    const biggest = [...p.sizes].filter(s => s.w && s.h).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    note.textContent = !state.customSize ? 'Enter a width and height for a size that is not listed.'
      : fit ? `Priced as ${fit.label}.`
      : (state.customSize.w >= 0.5 && state.customSize.h >= 0.5) ? `That is larger than we price online${biggest ? ` (up to ${biggest.label})` : ''}. Contact us for a custom quote.` : 'Enter both a width and a height.';
  }
  const scene = $('sizeScene');
  const d = dims();
  if (scene) {
    if (!d) scene.innerHTML = '<p class="muted" style="margin:0;font-size:13px;">Pick a size to see it to scale.</p>';
    else if (family.key === 'posters') PrintMockups.room(scene, { ...d, artworkUrl: artFor('front'), placement: state.placements.front, readonly: true });
    else PrintMockups.yard(scene, { ...d, artworkUrl: artFor('front'), placement: state.placements.front });
  }
  setNext(sizeChosen());
  refreshEstimate();
}
function pickSize(id) {
  state.sizeId = id;
  state.customSize = null;
  reconcileSelection();
  renderStep();
}

// ---------------------------------------------------------------- quantity
function renderQuantity() {
  const p = product();
  // Before a size is chosen the cards show "from" prices.
  const size = pricingSize();
  const allQtys = (s) => [...s.packs, ...(s.tables || []).flatMap(t => t.packs)].map(k => k.qty);
  const table = size ? tableFor(p, size) : [];
  const quantities = (table.length ? table.map(k => k.qty) : [...new Set(p.sizes.flatMap(allQtys))]).sort((a, b) => a - b);
  const firstUnit = table.length ? table[0].price / table[0].qty : null;
  const isPreset = quantities.includes(state.qty);
  setHead('How Many?', size ? `Prices for ${sizeText()}.` : 'Pick a quantity. Your price is set once you choose a size.');
  body.innerHTML = `
    <div class="option-grid pack-grid">${quantities.map(q => {
      const amount = size ? listPrice(p, size, q) : Math.min(...p.sizes.map(s => listPrice(p, s, q)).filter(v => v != null));
      // savings against buying the smallest listed quantity over and over; left off when that
      // comparison is meaningless (a one-off single at a handling price makes everything "90% off")
      const rawSaving = table.length && q > table[0].qty && amount != null ? Math.round((firstUnit * q - amount) * 100) / 100 : 0;
      const saving = rawSaving <= amount ? rawSaving : 0;
      return `<div class="option-card ${q === state.qty ? 'selected' : ''}" data-qty="${q}" role="button" tabindex="0" aria-pressed="${q === state.qty}">
        <div class="oc-big">${q.toLocaleString('en-US')}</div>
        <div class="oc-sub">${esc(unitLabel(p, q))}</div>
        ${Number.isFinite(amount) ? `<div class="oc-price">${size ? '' : 'From '}${money(amount)}</div>${q > 1 ? `<div class="oc-sub">${money(amount / q)} each</div>` : ''}` : ''}
        ${saving > 0 ? `<div class="oc-save">You save ${money(saving)}</div>` : ''}
      </div>`;
    }).join('')}</div>
    ${p.customQty ? `
    <div class="sub-heading">Custom quantity</div>
    <div class="inline-fields">
      <div class="field"><label for="customQty">Enter quantity</label><input type="number" id="customQty" min="${quantities[0]}" max="${p.maxQty}" step="1" inputmode="numeric" value="${state.qty && !isPreset ? state.qty : ''}"></div>
    </div>
    <p class="muted" id="customQtyNote" style="font-size:12.5px;margin-top:8px;"></p>` : ''}`;
  if (p.customQty) {
    $('customQty').addEventListener('input', () => {
      const q = Math.floor(Number($('customQty').value));
      state.qty = q >= 1 ? q : null;
      body.querySelectorAll('[data-qty]').forEach(el => el.classList.toggle('selected', Number(el.dataset.qty) === state.qty));
      afterQtyChange(quantities[0]);
    });
  }
  afterQtyChange(quantities[0]);
}
function afterQtyChange(min) {
  const p = product(), size = pricingSize();
  reconcileSelection(); // drops an add-on this quantity doesn't qualify for
  const note = $('customQtyNote');
  let ok = !!state.qty, msg = min > 1 ? `Minimum ${min}. ` : '';
  if (state.qty && state.qty < min) { ok = false; msg = `The minimum order is ${min}.`; }
  else if (state.qty > p.maxQty) { ok = false; msg = `For more than ${p.maxQty.toLocaleString('en-US')}, contact us for a custom quote.`; }
  else if (state.qty && size && !tableFor(p, size).some(k => k.qty === state.qty)) {
    const amount = listPrice(p, size, state.qty);
    msg = amount != null ? `${state.qty.toLocaleString('en-US')} ${unitLabel(p, state.qty)}: ${money(amount)} (${money(amount / state.qty)} each).` : '';
  } else msg += 'Any quantity works. Bigger orders get the lower per-piece price automatically.';
  if (note) note.textContent = msg;
  setNext(ok);
  renderStepRail();
  refreshEstimate();
}
function pickQty(q) {
  state.qty = q;
  if ($('customQty')) $('customQty').value = '';
  body.querySelectorAll('[data-qty]').forEach(el => el.classList.toggle('selected', Number(el.dataset.qty) === q));
  afterQtyChange(Math.min(...[...body.querySelectorAll('[data-qty]')].map(el => Number(el.dataset.qty))));
}

// ---------------------------------------------------------------- option groups
function renderOptionStep(g) {
  const p = product(), size = pricingSize();
  setHead(g.name, g.description);
  const current = choiceOf(g);
  const hasSwatches = g.choices.some(c => c.swatch);
  body.innerHTML = `<div class="option-grid" style="grid-template-columns:repeat(auto-fill,minmax(${hasSwatches ? 120 : 200}px,1fr));">${g.choices.map(c => {
    let priceHtml;
    if (g.table) {
      // this choice selects the price table: show what the order comes to with it
      const amount = size && state.qty ? listPrice(p, size, state.qty, { ...state.options, [g.id]: c.id }) : null;
      priceHtml = amount != null ? `<div class="oc-price">${money(amount)} total</div><div class="oc-sub">${money(amount / state.qty)} each</div>` : '';
    } else {
      const each = eachPrice(c, state.qty);
      const cost = [each > 0 ? `+${money(each)}/${esc(p.unit)}` : '', c.flat > 0 ? `+${money(c.flat)}` : ''].filter(Boolean).join(' ');
      priceHtml = `<div class="oc-price">${cost || 'Included'}</div>${each > 0 && state.qty ? `<div class="oc-sub">${money(each * state.qty + c.flat)} for ${state.qty.toLocaleString('en-US')}</div>` : ''}`;
    }
    return `<div class="option-card ${c.id === current.id ? 'selected' : ''}" data-group="${esc(g.id)}" data-choice="${esc(c.id)}" role="button" tabindex="0" aria-pressed="${c.id === current.id}">
      ${c.swatch ? `<span class="oc-swatch ${swatchClass(c.swatch)}" style="${swatchClass(c.swatch) ? '' : `background:${esc(c.swatch)};`}"></span>` : ''}
      <div class="oc-title">${esc(c.name)}</div>
      ${c.description ? `<div class="oc-sub">${esc(c.description)}</div>` : ''}
      ${priceHtml}
    </div>`;
  }).join('')}</div>
  ${g.id === 'color' && family.key === 'mylar' && dims() ? '<div class="mock-wrap" id="colorMock" style="max-width:220px;"></div>' : ''}
  ${g.id === 'sides' && family.key === 'yardsigns' && current.id === 'double' ? `
    <div class="sub-heading">Is the back the same as the front?</div>
    ${pills('backArtwork', state.backArtwork, [['same', 'Same artwork on both sides'], ['different', 'Different artwork on each side']])}` : ''}`;
  if ($('colorMock')) drawBag($('colorMock'), 'front');
  setNext(true);
  // Double-sided chosen after the design step, with no back design yet: ask for it here.
  if (g.id === 'sides' && sidesComeLater() && hasBackSlot() && !state.uploads.back) {
    body.insertAdjacentHTML('beforeend', `<div class="sub-heading">Add your back design</div>${slotHtml('back', 'Back Design')}`);
    setNext(false);
    stepMessage('Upload your back design to continue, or choose Single-Sided.');
  }
}
function pickChoice(groupId, choiceId) {
  state.options[groupId] = choiceId;
  reconcileSelection(); // single / double-sided changes which artwork is asked for
  refreshEstimate();
  renderStep();
}
function pickPill(name, value) {
  if (name === 'border') state.border = Number(value);
  else if (name === 'side') viewSide = value;
  else if (name === 'gallery') galleryTab = value;
  else state[name] = value;
  reconcileSelection();
  saveState();
  renderStep();
}
function pills(name, current, list) {
  return `<div class="radio-pill-group">${list.map(([v, l]) =>
    `<div class="radio-pill ${String(current) === String(v) ? 'selected' : ''}" data-pill="${name}" data-value="${v}" role="button" tabindex="0" aria-pressed="${String(current) === String(v)}">${l}</div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- add-ons
function renderAddons() {
  const p = product();
  setHead('Add-ons', 'Optional extras for this order.');
  body.innerHTML = p.addons.map(a => {
    const locked = !!(a.minQty && state.qty < a.minQty);
    return `<div class="terms-row addon-row ${locked ? 'is-off' : ''}">
      <input type="checkbox" id="addon_${esc(a.id)}" data-addon-id="${esc(a.id)}" ${state.addonIds.includes(a.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}>
      <label for="addon_${esc(a.id)}"><strong style="color:var(--3t-black);">${esc(a.name)}</strong> (+${money(a.price)})<br>
        ${esc(a.description)}${locked ? ` <strong>Order ${a.minQty} or more to add this.</strong>` : ''}</label>
    </div>`;
  }).join('');
  setNext(true);
}
body.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.addonId) {
    state.addonIds = el.checked ? [...new Set([...state.addonIds, el.dataset.addonId])] : state.addonIds.filter(x => x !== el.dataset.addonId);
    refreshEstimate();
  } else if (el.id === 'confirmCheckbox') {
    confirmed = el.checked; setNext(confirmed && !!estimate);
  }
});
body.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.brief) { state.design.brief[el.dataset.brief] = el.value; saveState(); updateArtworkNext(); }
  else if (el.id === 'designNotes') { state.designNotes = el.value; saveState(); updateArtworkNext(); }
  else if (el.id === 'customBorder') { state.border = Math.min(2, Math.max(0, Number(el.value) || 0)); saveState(); drawSticker(); }
});

// ---------------------------------------------------------------- artwork / design
async function ensureDraftToken() {
  if (!state.draftToken) {
    state.draftToken = (await api('/draft-token', { method: 'POST', body: {} })).draftToken;
    saveState();
  }
  return state.draftToken;
}
function formatBytes(n) { if (!n) return ''; if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'; return (n / 1024 / 1024).toFixed(1) + ' MB'; }
// The name each upload is filed under on the order (what the shop sees).
function slotLocation(slot) {
  if (slot === 'front') return group('sides') ? 'Front' : 'Artwork';
  return { back: 'Back', logo: 'Logo', reference: 'Reference' }[slot];
}
function fileChip(f, slot) {
  return `<div class="file-chip">
    ${isImage(f) ? `<img src="${esc(f.url)}" alt="">` : `<div style="width:40px;height:40px;border-radius:4px;background:var(--3t-light-gray);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;">${esc((f.filename.split('.').pop() || '').toUpperCase())}</div>`}
    <div class="fc-info"><div class="fc-name">${esc(f.filename)}</div><div class="fc-meta">${formatBytes(f.sizeBytes)}</div></div>
    ${slot === 'reference' ? '' : `<button type="button" data-slot-add="${slot}" style="color:var(--3t-black);">Replace</button>`}
    <button type="button" data-slot-remove="${slot}" data-file-id="${f.id}">Remove</button>
  </div>`;
}
function slotHtml(slot, label, hint) {
  const many = slot === 'reference';
  const files = many ? state.uploads.reference : (state.uploads[slot] ? [state.uploads[slot]] : []);
  return `<div class="slot">
    <div class="sub-heading" style="margin:0 0 8px;font-size:13.5px;">${esc(label)}</div>
    ${files.map(f => fileChip(f, slot)).join('')}
    ${!files.length || many ? `<div class="upload-dropzone ${files.length ? 'mt-8' : ''}" data-slot-add="${slot}" role="button" tabindex="0" aria-label="Upload ${esc(label)}">
      <div class="icon">⬆</div>
      <div><div class="ud-title">${many ? 'Add a reference image' : 'Upload'}</div><div class="muted ud-types">${esc(hint || 'PNG, JPG, PDF, or SVG')}</div></div>
    </div>` : ''}
  </div>`;
}
let pendingSlot = null;
function chooseFile(slot) { pendingSlot = slot; $('slotFileInput').click(); }
$('slotFileInput').addEventListener('change', async () => {
  const input = $('slotFileInput');
  const file = input.files[0];
  input.value = '';
  if (!file || !pendingSlot) return;
  const slot = pendingSlot;
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('draftToken', await ensureDraftToken());
    fd.append('locationName', slotLocation(slot));
    const { file: uploaded } = await api('/uploads', { method: 'POST', body: fd });
    if (slot === 'reference') state.uploads.reference.push(uploaded);
    else {
      const old = state.uploads[slot];
      state.uploads[slot] = uploaded;
      if (old) api(`/uploads/${old.id}`, { method: 'DELETE' }).catch(() => {});
      delete state.placements[slot]; // new artwork starts fitted and centered
      if (slot === 'front') detectOrientation(uploaded);
    }
    reconcileSelection();
    saveState();
    renderStep();
  } catch (err) { showToast(err.message || 'Upload failed.'); }
});
async function removeFile(slot, fileId) {
  try {
    await api(`/uploads/${fileId}`, { method: 'DELETE' });
  } catch (err) { /* already gone on the server: still clear it here */ }
  if (slot === 'reference') state.uploads.reference = state.uploads.reference.filter(f => String(f.id) !== String(fileId));
  else { state.uploads[slot] = null; delete state.placements[slot]; }
  reconcileSelection();
  saveState();
  renderStep();
}
// Posters start in the uploaded artwork's own orientation; the customer can change it afterwards.
function detectOrientation(file) {
  if (family.key !== 'posters' || !isImage(file)) return;
  const probe = new Image();
  probe.onload = () => {
    if (probe.naturalWidth === probe.naturalHeight) return;
    state.orientation = probe.naturalWidth > probe.naturalHeight ? 'landscape' : 'portrait';
    saveState();
  };
  probe.src = file.url;
}

function renderArtworkStep() {
  const d = design();
  const m = method();
  const notes = `<div class="field mt-16"><label for="designNotes">Design Notes</label>
    <textarea id="designNotes" placeholder="Describe any design details, preferences, or specifications we should be aware of.">${esc(state.designNotes)}</textarea></div>`;
  // One quiet line under the upload area, gone as soon as the artwork is uploaded.
  const needsArt = !state.uploads.front || (hasBackSlot() && !state.uploads.back);
  const createLine = d.enabled && d.custom && needsArt
    ? `<p class="no-art-line"><a href="#" data-method="custom">${NO_ARTWORK_LINE}</a>${d.customFee > 0 ? ` <span class="muted">(+${money(d.customFee)} design fee)</span>` : ''}</p>` : '';
  const backOptional = sidesComeLater() && !state.options.sides; // single / double-sided not chosen yet
  const uploadSlots = () => (hasBackSlot() || backOptional
    ? slotHtml('front', 'Front Design') + slotHtml('back', backOptional ? 'Back Design (optional, for double-sided packs)' : 'Back Design')
    : slotHtml('front', group('sides') ? 'Front Design' : 'Artwork')) + createLine;
  const logoFee = d.logoFee > 0 ? ` (+${money(d.logoFee)})` : '';
  const logoChoices = (choices) => `<div class="sub-heading">Logo</div>
    <div class="radio-pill-group">${choices.map(([v, l]) =>
      `<div class="radio-pill ${state.design.logo === v ? 'selected' : ''}" data-logo="${v}" role="button" tabindex="0" aria-pressed="${state.design.logo === v}">${l}</div>`).join('')}</div>
    ${state.design.logo === 'upload' ? `<div style="margin-top:12px;">${slotHtml('logo', 'Your Logo')}</div>` : ''}`;
  const brief = state.design.brief;
  const briefField = (key, label, placeholder, area) => `<div class="field"><label for="brief_${key}">${label}</label>
    ${area ? `<textarea id="brief_${key}" data-brief="${key}" placeholder="${esc(placeholder)}">${esc(brief[key] || '')}</textarea>`
      : `<input type="text" id="brief_${key}" data-brief="${key}" placeholder="${esc(placeholder)}" value="${esc(brief[key] || '')}">`}</div>`;

  let detail = '';
  if (m === 'upload') detail = uploadSlots() + notes;
  if (m === 'premade') {
    const shown = d.templates.filter(t => t.category === galleryTab);
    const [, blurb] = TEMPLATE_CATEGORIES[galleryTab];
    const picked = d.templates.find(t => t.id === state.design.templateId);
    detail = `<div class="sub-heading">Premade designs</div>
      ${pills('gallery', galleryTab, Object.entries(TEMPLATE_CATEGORIES).map(([key, [name]]) => [key, name]))}
      <p class="muted" style="font-size:13px;margin:8px 0;">${blurb}</p>
      <div class="tpl-scroll">${shown.length ? `<div class="tpl-grid">${shown.map(t => `
        <div class="option-card tpl-card ${t.id === state.design.templateId ? 'selected' : ''}" data-template="${esc(t.id)}" role="button" tabindex="0" aria-label="Preview ${esc(t.name)}">
          ${t.imageUrl ? `<img src="${esc(t.imageUrl)}" alt="">` : '<div class="tpl-blank"></div>'}<div class="oc-title">${esc(t.name)}</div>
        </div>`).join('')}</div>` : `<p class="muted" style="font-size:13.5px;margin:0;">No ${esc(TEMPLATE_CATEGORIES[galleryTab][0].toLowerCase())} are listed yet. Describe the design you want in the notes below and we'll match it.</p>`}</div>
      ${picked ? `<p style="font-size:13.5px;font-weight:700;margin:10px 0 0;">Selected: ${esc(picked.name)}</p>` : ''}
      ${logoChoices([['upload', 'Upload my logo (free)'], ['text', 'No logo, text only'], ['design', `Create my logo${logoFee}`]])}
      ${briefField('brandInfo', 'Brand Information', 'Brand name, product name, tagline or anything else to put on the design.', true)}${notes}`;
  }
  if (m === 'custom') {
    detail = `<div class="design-request">
      <p style="font-size:13.5px;margin:0 0 12px;"><strong>3T will create your artwork${d.customFee > 0 ? ` (+${money(d.customFee)} design fee)` : ''}.</strong> Custom artwork is produced after checkout; it is not an instant proof. We'll send you a proof to approve before anything is printed${d.revisions ? `, with ${d.revisions} revision${d.revisions === 1 ? '' : 's'} included` : ''}.
        ${d.premade ? '' : '<a href="#" data-method="upload">I have my own artwork instead.</a>'}</p>
      <div class="field-row">${briefField('designName', 'Design Name', 'What should we call this design?')}${briefField('theme', 'Product / Flavor / Theme Name', 'e.g. Blue Razz')}</div>
      <div class="field-row">${briefField('primaryColors', 'Primary Colors', 'e.g. electric blue, black')}${briefField('secondaryColors', 'Secondary Colors', 'e.g. silver, white')}</div>
      <div class="field"><label>Design Style</label><div class="radio-pill-group">${DESIGN_STYLES.map(s =>
        `<div class="radio-pill ${brief.style === s ? 'selected' : ''}" data-style="${s}" role="button" tabindex="0" aria-pressed="${brief.style === s}">${s}</div>`).join('')}</div></div>
      ${briefField('inspiration', 'Design Inspiration', 'Describe the look you have in mind.', true)}
      ${slotHtml('reference', 'Reference Images (optional)', 'Examples, sketches or inspiration')}
      ${logoChoices([['upload', 'Upload existing logo'], ['text', 'Use text only'], ['design', `Design a logo for me${logoFee}`]])}
      ${briefField('instructions', 'Additional Instructions', 'Anything else we should know?', true)}
    </div>`;
  }
  // Products with premade designs choose a design method first; the rest just upload.
  const methods = d.premade ? [
    ['upload', 'Upload My Design', isDouble() || backOptional ? 'Send your own front and back artwork.' : 'Send your own artwork.', 'Free'],
    ['premade', 'Use Premade Design', 'Pick one of our designs. Adding your existing logo is free.', 'Free'],
    d.custom ? ['custom', 'Custom Design', 'We create the artwork for you after checkout.', d.customFee > 0 ? `+${money(d.customFee)}` : 'Free'] : null,
  ].filter(Boolean) : [];
  setHead(d.premade ? 'Your Design' : (m === 'custom' ? 'Tell Us What You Need' : 'Upload Your Artwork'), d.premade ? 'How would you like to handle the artwork?' : (m === 'custom' ? '' : 'PNG, JPG, PDF, or SVG.'));
  body.innerHTML = (methods.length ? `<div class="option-grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr));margin-bottom:18px;">${methods.map(([v, title, sub, cost]) => `
    <div class="option-card ${m === v ? 'selected' : ''}" data-method="${v}" role="button" tabindex="0" aria-pressed="${m === v}">
      <div class="oc-title">${title}</div><div class="oc-sub">${sub}</div><div class="oc-price">${cost}</div>
    </div>`).join('')}</div>` : '') + detail;
  updateArtworkNext();
}
// What each design path needs before moving on.
function artworkReady() {
  const m = method();
  if (m === 'upload') return !!state.uploads.front && (!hasBackSlot() || !!state.uploads.back);
  if (m === 'premade') return design().templates.length ? !!state.design.templateId : !!state.designNotes.trim();
  const b = state.design.brief;
  return !!((b.designName || '').trim() || (b.theme || '').trim() || (b.inspiration || '').trim());
}
function updateArtworkNext() {
  if (currentStep() !== 'artwork') return;
  const ready = artworkReady();
  setNext(ready);
  const m = method();
  stepMessage(ready ? '' : m === 'premade' ? (design().templates.length ? 'Choose a design to continue.' : 'Tell us which design you want in the notes to continue.')
    : m === 'custom' ? 'Give us a design name, theme or some inspiration to continue.'
    : hasBackSlot() ? 'Upload your front and back designs to continue.' : '');
}

// Premade design preview: a larger look at the design, front and back, with "Select This Design".
function openTemplate(id) {
  const t = design().templates.find(x => x.id === id);
  if (!t) return;
  let side = 'front';
  const modal = document.createElement('div');
  modal.className = 'tpl-modal';
  const draw = () => {
    const url = side === 'back' ? t.backImageUrl : t.imageUrl;
    modal.innerHTML = `<div class="tpl-modal-box" role="dialog" aria-modal="true" aria-label="${esc(t.name)}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;">
        <strong style="font-size:16px;">${esc(t.name)}</strong>
        <button type="button" class="btn btn-ghost btn-sm" data-close aria-label="Close preview">Close ✕</button>
      </div>
      ${url ? `<img src="${esc(url)}" alt="${esc(t.name)}, ${side}" class="tpl-modal-img">` : '<div class="tpl-modal-img tpl-blank"></div>'}
      ${t.backImageUrl ? `<div class="radio-pill-group" style="justify-content:center;margin-top:12px;">
        <div class="radio-pill ${side === 'front' ? 'selected' : ''}" data-side="front" role="button" tabindex="0">Front</div>
        <div class="radio-pill ${side === 'back' ? 'selected' : ''}" data-side="back" role="button" tabindex="0">Back</div></div>` : ''}
      <button type="button" class="btn btn-primary btn-block" data-select style="margin-top:14px;">Select This Design</button>
    </div>`;
  };
  draw();
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) return close();
    const pill = e.target.closest('[data-side]');
    if (pill) { side = pill.dataset.side; return draw(); }
    if (e.target.closest('[data-select]')) { state.design.templateId = t.id; saveState(); close(); renderStep(); }
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(modal);
  modal.querySelector('[data-select]').focus();
}

// ---------------------------------------------------------------- position (the artwork editor)
function sideToggle(sides) {
  if (sides.length < 2) return '';
  if (!sides.includes(viewSide)) viewSide = sides[0];
  return pills('side', viewSide, sides.map(s => [s, s === 'front' ? 'Front' : 'Back']));
}
function renderEditStep() {
  const sides = editableSides();
  const toggle = sideToggle(sides);
  const side = sides.includes(viewSide) ? viewSide : sides[0];
  const c = canvasDims();
  setHead('Position Your Artwork', 'Drag to move it, and size it the way you want it printed. Empty space prints white.');
  if (!c) { body.innerHTML = '<p class="muted">Choose a size to position your artwork.</p>'; return setNext(true); }
  body.innerHTML = `${toggle}
    <div class="mock-wrap" id="editorHost"></div>
    <p class="mock-note" style="text-align:center;">The dashed outline is the ${family.key === 'mylar' ? 'label' : 'print'} area. Your file is not changed; only its placement is saved.</p>`;
  PrintMockups.editor($('editorHost'), {
    w: c.w, h: c.h, artworkUrl: artFor(side), placement: state.placements[side],
    onChange: (placement) => { state.placements[side] = placement; saveState(); },
  });
  setNext(true);
}

// ---------------------------------------------------------------- preview (mockup)
let roomMock = null;
function drawBag(host, side) {
  const d = dims() || { w: 4, h: 5 };
  const s = sizeObj() || {};
  const color = group('color');
  PrintMockups.bag(host, {
    w: d.w, h: d.h, printW: s.printW, printH: s.printH, swatch: color ? choiceOf(color).swatch : '#111111',
    artworkUrl: artFor(side), placement: state.placements[side],
    label: method() === 'custom' ? 'CUSTOM DESIGN' : (side === 'back' ? 'BACK DESIGN' : 'YOUR DESIGN'),
    blank: side === 'back' && !isDouble(), // single-sided: the back is the plain bag
  });
}
function drawMockup(host, side, readonly) {
  const d = dims();
  if (family.key === 'posters') {
    return PrintMockups.room(host, { ...d, artworkUrl: artFor('front'), placement: state.placements.front, wall: state.wall, readonly, onChange: (pos) => { state.wall = pos; saveState(); } });
  }
  // a double-sided sign with the same artwork on both sides shows the front placement on the back too
  if (family.key === 'yardsigns') return PrintMockups.yard(host, { ...d, artworkUrl: artFor(side), placement: state.placements[hasBackSlot() ? side : 'front'] });
  if (family.key === 'mylar') return drawBag(host, side);
  return null;
}
function drawSticker() {
  const host = $('stickerHost');
  const d = dims();
  if (host && d && artFor('front')) PrintMockups.sticker(host, { ...d, artworkUrl: artFor('front'), placement: state.placements.front, border: state.border });
}
function renderMockupStep() {
  const d = dims();
  const hasArt = !!artFor('front');
  setNext(true);
  if (!d) {
    setHead('Preview', '');
    body.innerHTML = '<p class="muted">A preview is not available for this size. You can continue with your order.</p>';
    return;
  }

  if (family.key === 'stickers') {
    setHead('White Border & Cut Preview', 'This is roughly where your sticker will be cut.');
    if (!hasArt) {
      body.innerHTML = `<p class="muted">${method() === 'custom' ? "We'll set the cut line once your artwork is designed, and show it on your proof." : "We can't preview this file type here. We'll set the cut line and send a proof if anything looks off."}</p>`;
      return;
    }
    const custom = !BORDER_PRESETS.includes(state.border);
    body.innerHTML = `<div class="sub-heading">White Border</div>
      <p style="font-size:13.5px;margin:0 0 10px;"><strong>A white border adds a solid white layer around the outside edge of your entire design. The cutter follows the outside perimeter of that shape instead of cutting every small interior opening or detail.</strong></p>
      <div class="mock-tools" style="margin-top:0;">
        ${pills('border', custom ? 'custom' : state.border, BORDER_PRESETS.map(b => [b, b === 0 ? 'None' : `${b}"`]))}
        <div class="field" style="margin:0;width:120px;"><input type="number" id="customBorder" min="0" max="2" step="0.01" inputmode="decimal" placeholder="Custom (in)" aria-label="Custom border in inches" value="${custom ? state.border : ''}"></div>
      </div>
      <div class="mock-wrap" id="stickerHost"></div>
      <div class="sub-heading">Is your artwork positioned correctly?</div>
      <div class="mock-tools" style="margin-top:0;">
        <button type="button" class="btn btn-outline btn-sm" data-goto="edit">Edit Artwork</button>
        <span class="muted" style="font-size:13px;">If it looks good, continue.</span>
      </div>
      <p class="mock-note">Holes inside letters and small interior gaps are not cut out, so the sticker comes off in one piece. Preview is approximate; we check every file before cutting.</p>`;
    $('stepNextBtn').textContent = 'Looks Good';
    return drawSticker();
  }

  const sides = family.key === 'mylar' ? ['front', 'back'] : sidesShown();
  const toggle = sideToggle(sides);
  const side = sides.includes(viewSide) ? viewSide : 'front';
  if (family.key === 'posters') {
    setHead('Orientation & Room Preview', 'Your poster on a wall above a 6 ft sofa. Drag it to move it.');
    body.innerHTML = `${d.w === d.h ? '' : `<div class="sub-heading">Orientation</div>${pills('orientation', d.w > d.h ? 'landscape' : 'portrait', [['portrait', 'Portrait'], ['landscape', 'Landscape']])}`}
      <div class="mock-wrap" id="mockHost"></div>
      <div class="mock-tools"><button type="button" class="btn btn-outline btn-sm" data-act="center">Center on wall</button>
        ${editableSides().length ? '<button type="button" class="btn btn-outline btn-sm" data-goto="edit">Edit Artwork Position</button>' : ''}
        <span class="muted" style="font-size:13px;">${d.w}×${d.h} in</span></div>
      <p class="mock-note">Room preview is provided as an approximate size reference. Actual appearance may vary.</p>`;
  } else if (family.key === 'yardsigns') {
    setHead('Yard Preview', 'Your sign to scale next to a person.');
    body.innerHTML = `${toggle}<div class="mock-wrap" id="mockHost"></div>
      <p class="mock-note">Size preview is an approximate visual representation.</p>`;
  } else {
    setHead('Pack Preview', 'Roughly how your pack will look. This is a visualization, not a production proof.');
    const note = method() === 'custom' ? "Your custom design is created after checkout; we'll send a proof to approve."
      : side === 'back' && !isDouble() ? 'Single-sided: the back of the pack is not printed.'
      : hasArt || artFor(side) ? '' : 'Your artwork appears here once an image is added.';
    body.innerHTML = `${toggle}<div class="mock-wrap" id="mockHost" style="max-width:340px;"></div>
      <p class="mock-note" style="text-align:center;">${note}</p>
      ${editableSides().length ? '<div class="mock-tools" style="justify-content:center;"><button type="button" class="btn btn-outline btn-sm" data-goto="edit">Edit Artwork Position</button></div>' : ''}`;
  }
  roomMock = drawMockup($('mockHost'), side, false) || null;
}

// ---------------------------------------------------------------- review
function reviewRows() {
  const p = product(), o = estimate ? estimate.printOrder : null;
  const rows = [['Product', esc(p.name)]];
  if (p.sizes.length > 1 || state.customSize) rows.push(['Size', esc(sizeText()) + (o && o.pricedAsSize ? ` <span class="muted" style="font-weight:400;">(priced as ${esc(o.pricedAsSize)})</span>` : '')]);
  if (family.key === 'posters' && state.orientation) rows.push(['Orientation', state.orientation === 'landscape' ? 'Landscape' : 'Portrait']);
  rows.push(['Quantity', `${state.qty.toLocaleString('en-US')} ${esc(unitLabel(p, state.qty))}`]);
  for (const g of p.options) if (g.choices.length > 1) rows.push([esc(g.name), esc(choiceOf(g).name)]);
  if (family.key === 'yardsigns' && isDouble()) rows.push(['Back of sign', state.backArtwork === 'different' ? 'Different artwork' : 'Same as front']);
  if (family.key === 'stickers' && artFor('front')) rows.push(['White border', state.border > 0 ? `${state.border} in` : 'None']);
  if (o && o.design && (o.design.method !== 'upload' || p.design.premade)) {
    rows.push(['Design', esc(o.design.methodLabel) + (o.design.templateName ? `: ${esc(o.design.templateName)}` : '')]);
    if (o.design.logoLabel) rows.push(['Logo', esc(o.design.logoLabel)]);
  }
  const files = [['front', method() === 'upload' ? state.uploads.front : null], ['back', hasBackSlot() ? state.uploads.back : null], ['logo', method() !== 'upload' && state.design.logo === 'upload' ? state.uploads.logo : null]].filter(([, f]) => f);
  rows.push(['Artwork', files.length ? files.map(([slot, f]) => `${esc(slotLocation(slot))}: ${esc(f.filename)}`).join('<br>') : 'Created by 3T Print Solutions']);
  for (const a of p.addons) if (state.addonIds.includes(a.id)) rows.push(['Add-on', esc(a.name)]);
  rows.push(['Rush', state.rush ? 'Yes' : 'No']);
  rows.push(['Delivery', state.contact.fulfillmentMethod === 'shipping' ? 'Ground Shipping' : 'Local Pickup']);
  return { rows, files };
}
function renderReview() {
  setHead('Review Your Order', 'Check everything below. This is what we will produce.');
  $('stepBackBtn').textContent = 'Edit Order';
  if (!estimate) {
    body.innerHTML = `<div class="prereq-notice"><p>${esc(estimateError || 'We could not price this order yet.')}</p><button type="button" class="btn btn-dark btn-sm" data-goto="${STEPS[0]}">Edit Order</button></div>`;
    return setNext(false);
  }
  const { rows, files } = reviewRows();
  const t = totals();
  const money2 = [
    [`${estimate.totalQty.toLocaleString('en-US')} × ${money(estimate.printOrder.unitPrice)} each`, money(estimate.baseLineTotal)],
    ...estimate.addonLines.map(l => [esc(l.name) + (l.perPiece ? ` <span class="muted" style="font-weight:400;">(${l.qty} × ${money(l.each)})</span>` : ''), money(l.total)]),
    ['Subtotal', money(estimate.subtotal)],
    ...(t.rush > 0 ? [['Rush fee', money(t.rush)]] : []),
    ...(t.shipping > 0 ? [['Ground Shipping', money(t.shipping)]] : []),
  ];
  const isSticker = family.key === 'stickers';
  const showMock = dims() && (!isSticker || artFor('front'));
  body.innerHTML = `
    ${showMock ? `<div class="mock-wrap" id="${isSticker ? 'stickerHost' : 'reviewMock'}" style="margin:0 auto 14px;max-width:${family.key === 'mylar' ? 240 : isSticker ? 320 : 520}px;"></div>` : ''}
    ${files.length ? `<div class="review-art">${files.map(([slot, f]) => `<figure>${isImage(f) ? `<img src="${esc(f.url)}" alt="">` : `<div style="width:110px;height:110px;border:1.5px solid var(--3t-border);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;">${esc((f.filename.split('.').pop() || '').toUpperCase())}</div>`}<figcaption>${esc(slotLocation(slot))}</figcaption></figure>`).join('')}</div>` : ''}
    <div class="review-list">${rows.map(([k, v]) => `<div class="review-row"><span class="rk">${k}</span><span class="rv">${v}</span></div>`).join('')}</div>
    <div class="review-list">
      ${money2.map(([k, v]) => `<div class="review-row"><span class="rk">${k}</span><span class="rv">${v}</span></div>`).join('')}
      <div class="review-row total"><span class="rk">Total before tax</span><span class="rv">${money(t.total)}</span></div>
    </div>
    <p class="muted" style="font-size:12.5px;">Sales tax is added on the next page.</p>
    <div class="terms-row">
      <input type="checkbox" id="confirmCheckbox" ${confirmed ? 'checked' : ''}>
      <label for="confirmCheckbox">${CONFIRM_TEXT} Read our <a href="/terms.html" target="_blank">Custom Order Terms</a>.</label>
    </div>`;
  if (showMock) { if (isSticker) drawSticker(); else drawMockup($('reviewMock'), 'front', true); }
  setNext(confirmed);
}

// ---------------------------------------------------------------- contact
// Optional fields follow Settings > Contact Form, like the apparel builder.
function contactFormConfig() { return (businessInfo && businessInfo.contactForm) || null; }
function applyContactFormConfig() {
  const cfg = contactFormConfig();
  if (!cfg) return;
  $('contactTitle').textContent = cfg.title;
  $('contactSubtitle').textContent = cfg.subtitle;
  for (const key of ['businessName', 'neededByDate']) {
    $(key + 'Field').classList.toggle('hidden', !cfg[key].show);
    $(key + 'Label').innerHTML = esc(cfg[key].label) + (cfg[key].required ? ' <span class="req">*</span>' : '');
    $(key).required = !!cfg[key].required;
    if (!cfg[key].show) state.contact[key] = '';
  }
  $('additionalNotesField').classList.toggle('hidden', !cfg.additionalNotes.show);
  $('additionalNotesLabel').textContent = cfg.additionalNotes.label;
  $('additionalNotes').placeholder = cfg.additionalNotes.placeholder;
  if (!cfg.additionalNotes.show) state.contact.additionalNotes = '';
  const rate = shippingRate();
  $('shippingNote').textContent = `Local Pickup has no extra cost. Ground Shipping is ${rate > 0 ? `a flat ${money(rate)} per order` : 'free'}.`;
}
// Display mirrors of the checkout rules (server/checkoutRules.js): rush is a
// percent of the order, shipping one flat rate per shipped order.
function shippingRate() { return (businessInfo && Number(businessInfo.shippingFlatRate)) || 0; }
function totals() {
  const pct = (businessInfo && businessInfo.rushFeePct) || 0;
  const rush = estimate && state.rush ? Math.round(estimate.total * pct) / 100 : 0;
  const shipping = state.contact.fulfillmentMethod === 'shipping' ? shippingRate() : 0;
  return { rush, shipping, total: estimate ? Math.round((estimate.total + rush + shipping) * 100) / 100 : 0 };
}
function syncRushOption() {
  const pct = (businessInfo && businessInfo.rushFeePct) || 0;
  $('builderRushCheckbox').checked = !!state.rush;
  $('builderRushDetail').textContent = pct ? `(+${pct}% of your order${estimate ? `, ${money(Math.round(estimate.total * pct) / 100)}` : ''})` : '';
  $('rushRow').classList.toggle('hidden', !pct);
  $('rushHeading').classList.toggle('hidden', !pct);
}
function hydrateContactForm() {
  syncRushOption();
  const c = state.contact;
  for (const id of ['firstName', 'lastName', 'email', 'phone', 'businessName', 'neededByDate', 'additionalNotes']) $(id).value = c[id] || '';
  document.querySelectorAll('#fulfillmentGroup .radio-pill').forEach(p => {
    const isSelected = p.dataset.value === c.fulfillmentMethod;
    p.classList.toggle('selected', isSelected);
    p.setAttribute('aria-pressed', String(isSelected));
  });
  const sa = c.shippingAddress || {};
  $('shipLine1').value = sa.line1 || '';
  $('shipLine2').value = sa.line2 || '';
  $('shipCity').value = sa.city || '';
  $('shipState').value = sa.state || '';
  $('shipZip').value = sa.zip || '';
  $('shippingAddressField').classList.toggle('hidden', c.fulfillmentMethod !== 'shipping');
}
['firstName', 'lastName', 'email', 'phone', 'businessName', 'neededByDate', 'additionalNotes'].forEach(id => {
  $(id).addEventListener('input', (e) => { state.contact[id] = e.target.value; saveState(); });
});
['shipLine1', 'shipLine2', 'shipCity', 'shipState', 'shipZip'].forEach(id => {
  const key = id.replace('ship', '').charAt(0).toLowerCase() + id.replace('ship', '').slice(1); // shipLine1 -> line1
  $(id).addEventListener('input', (e) => {
    state.contact.shippingAddress = state.contact.shippingAddress || {};
    state.contact.shippingAddress[key] = e.target.value;
    saveState();
  });
});
$('fulfillmentGroup').addEventListener('click', (e) => {
  const pill = e.target.closest('.radio-pill');
  if (!pill) return;
  state.contact.fulfillmentMethod = pill.dataset.value;
  saveState();
  hydrateContactForm();
  updateSummary();
});
$('builderRushCheckbox').addEventListener('change', (e) => { state.rush = e.target.checked; saveState(); updateSummary(); });

// Returns the first problem with the contact details, or '' when they are complete.
function contactProblem() {
  const c = state.contact;
  if (!c.firstName.trim() || !c.lastName.trim() || !c.email.trim() || !c.phone.trim()) return 'Please fill in your first name, last name, email, and phone number.';
  const cfg = contactFormConfig();
  const missing = cfg && ['businessName', 'neededByDate'].find(k => cfg[k].show && cfg[k].required && !String(c[k] || '').trim());
  if (missing) return `Please fill in "${cfg[missing].label}".`;
  if (c.fulfillmentMethod === 'shipping') {
    const sa = c.shippingAddress || {};
    if (!sa.line1?.trim() || !sa.city?.trim() || !sa.state?.trim() || !sa.zip?.trim()) return 'Please provide a complete shipping address (street, city, state, ZIP), or choose Local Pickup.';
  }
  return '';
}
$('contactNextBtn').addEventListener('click', () => {
  const problem = contactProblem();
  if (problem) return showError(problem);
  goToStep(state.stepIndex + 1);
});

async function submitQuote() {
  clearError();
  if (!estimate) return showError(estimateError || 'Please finish choosing your size and quantity.');
  if (!artworkReady()) { goToNamed('artwork'); return showError('Please finish the artwork step first.'); }
  const problem = contactProblem();
  if (problem) { goToNamed('contact'); return showError(problem); }
  if (!confirmed) return showError('Please confirm your order details before checkout.');
  const c = state.contact;
  const btn = $('stepNextBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Getting your quote…';
  try {
    const result = await api('/quotes', { method: 'POST', body: {
      printSelection: selectionPayload(),
      designNotes: state.designNotes,
      draftToken: state.draftToken,
      firstName: c.firstName.trim(), lastName: c.lastName.trim(), email: c.email.trim(), phone: c.phone.trim(),
      businessName: (c.businessName || '').trim() || null,
      rush: !!state.rush, reviewAgreed: true,
      neededByDate: c.neededByDate || null, notes: (c.additionalNotes || '').trim() || null,
      fulfillmentMethod: c.fulfillmentMethod,
      shippingAddress: c.fulfillmentMethod === 'shipping' ? c.shippingAddress : null,
      termsAccepted: true,
      artworkPending: false,
    } });
    if (window.track3T) window.track3T('quote_generated', { quoteCode: result.quoteCode });
    clearSavedState();
    window.location.href = `/quote.html?id=${encodeURIComponent(result.quoteCode)}`;
  } catch (err) {
    showError(err.message || 'Something went wrong generating your quote.');
    btn.textContent = 'Confirm & Checkout';
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- estimate + summary
let estimateSeq = 0;
async function refreshEstimate() {
  saveState();
  if (!product() || !state.qty || !sizeChosen()) { estimate = null; estimateError = ''; updateSummary(); return; }
  const seq = ++estimateSeq;
  try {
    const result = (await api('/estimate', { method: 'POST', body: { printSelection: selectionPayload() } })).estimate;
    if (seq !== estimateSeq) return; // a newer change is already being priced
    estimate = result; estimateError = '';
  } catch (err) {
    if (seq !== estimateSeq) return;
    estimate = null; estimateError = err.message || "We couldn't update your price. Please try again.";
  }
  updateSummary();
  if (currentStep() === 'review') renderStep();
}
function updateSummary() {
  const host = $('summaryBody');
  const bar = $('mobileSummaryBar');
  const p = product();
  if (!p) { host.innerHTML = '<p class="summary-empty">Choose a product to get started.</p>'; bar.classList.add('hidden'); return; }
  const line = (l, r) => `<div class="summary-line"><span class="l">${l}</span><span class="r">${r}</span></div>`;
  let html = line('Product', esc(p.name));
  if ((p.sizes.length > 1 || state.customSize) && sizeText()) html += line('Size', esc(sizeText()));
  if (state.qty) html += line('Quantity', `${state.qty.toLocaleString('en-US')} ${esc(unitLabel(p, state.qty))}`);
  for (const g of p.options) if (g.choices.length > 1 && state.options[g.id]) html += line(esc(g.name), esc(choiceOf(g).name));
  if (estimate) {
    const t = totals();
    html += line('Price each', money(estimate.printOrder.unitPrice));
    html += line('Base price', money(estimate.baseLineTotal));
    for (const a of estimate.addonLines) html += line(esc(a.name), `+${money(a.total)}`);
    html += line('Subtotal', money(estimate.subtotal));
    if (t.rush > 0) html += line('Rush Fee', `+${money(t.rush)}`);
    html += line('Shipping', state.contact.fulfillmentMethod === 'shipping' ? `+${money(t.shipping)}` : 'Local pickup, free');
    html += `<div class="summary-total"><span class="l">Estimated Total</span><span class="r">${money(t.total)}</span></div>`;
    html += '<div class="summary-note">Before sales tax, which is shown on your quote.</div>';
    $('mobileSummaryCount').textContent = `${estimate.totalQty.toLocaleString('en-US')} ${unitLabel(p, estimate.totalQty)}`;
    $('mobileSummaryTotal').textContent = money(t.total);
  } else if (estimateError) {
    html += `<div class="summary-note" style="color:#ffb4a8;">${esc(estimateError)}</div>`;
  }
  bar.classList.toggle('hidden', !estimate);
  host.innerHTML = html;
  syncRushOption();
}
$('mobileViewOrderBtn').addEventListener('click', () => {
  $('summaryPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------------------------------------------------------------- init
async function init() {
  let catalog = { families: [] };
  try {
    [businessInfo, catalog] = await Promise.all([api('/business-info'), api('/print-catalog')]);
  } catch (e) { /* handled below: no family means "not available" */ }
  family = catalog.families.find(f => f.key === FAMILY_KEY) || null;
  if (!family || !FLOWS[family.key] || !family.active || !family.products.length) {
    if (family) $('unavailableTitle').textContent = `${family.name}: not available online yet`;
    $('unavailableState').classList.remove('hidden');
    return;
  }
  $('familyTagline').textContent = family.name;
  document.title = `${family.name} — 3T Print Solutions`;
  $('builderWrap').classList.remove('hidden');
  applyContactFormConfig();
  STEPS = computeSteps();
  reconcileSelection();
  goToStep(state.stepIndex || 0);
  await refreshEstimate();
}
init();
