// public/js/print-builder.js — guided order flows for Stickers / Labels,
// Custom Posters / Prints, Custom Mylar Packs and Yard Signs
// (print.html?type=stickers|posters|mylar|yardsigns).
//
// The product type decides the flow (FLOWS below: which sections, in what
// order), the customer's configuration decides the price, and the server
// decides the total. What a product offers — sizes, price tables, option
// groups, add-ons, design methods and fees — comes from /api/print-catalog,
// edited in the admin under Print Products.
//
// There is one price: `price`, the server's answer to /api/estimate for the
// current configuration (the order itself plus rush, shipping and tax).
// Every screen — the summary, the review, the mobile bar — reads from it.
// The small prices printed on choice tiles are the catalog's list prices.
//
// Artwork is never altered: the product's print area is the canvas, and
// the customer's placement of the artwork on it (scale + position) is
// stored separately and sent with the order (see print-mockups.js).
//
// The whole in-progress order, including which section is open, is kept in
// localStorage, so a refresh reopens it where the customer left off.

const FAMILY_KEY = new URLSearchParams(location.search).get('type') || '';

// Each product type's sections, in order. "opt:<id>" is one of the
// product's option groups as its own section; option groups a flow does not
// list are chosen inside the Add-ons section instead (mylar lamination).
// "edit" is a separate artwork positioning section; posters and yard signs
// position the artwork inside the Artwork section itself. A section the
// chosen product has nothing for is skipped.
const FLOWS = {
  posters:   ['product', 'orientation', 'size', 'artwork', 'quantity', 'opt:finish', 'addons', 'contact', 'review'],
  stickers:  ['product', 'artwork', 'size', 'quantity', 'mockup', 'opt:finish', 'addons', 'contact', 'review'],
  mylar:     ['artwork', 'product', 'size', 'opt:color', 'quantity', 'opt:sides', 'edit', 'addons', 'contact', 'review'],
  yardsigns: ['product', 'size', 'quantity', 'opt:sides', 'artwork', 'addons', 'contact', 'review'],
};
const SCENE_FAMILIES = ['posters', 'yardsigns'];   // the Size section shows the size to scale
const INLINE_EDIT_FAMILIES = ['posters', 'yardsigns']; // upload and position in one section
const HIDE_UNIT_PRICE = ['mylar'];                  // show quantity and totals, not a price per piece
const MISPRINT_FAMILIES = ['mylar'];
const DESIGN_STYLES = ['Luxury', 'Cartoon', 'Bold', 'Minimal', 'Streetwear', 'Futuristic', 'Retro', 'Other'];
const BORDER_PRESETS = [0, 0.05, 0.1];
const TEMPLATE_CATEGORIES = {
  signature: ['Signature Designs', 'Original 3T designs created in-house and available for customization.'],
  reusable: ['Reusable Designs', 'Choose an existing template and add your logo or brand information.'],
};
const NO_ARTWORK_LINE = "Don't have artwork? Have 3T create it for you.";
const CONFIRM_TEXT = 'I have reviewed my artwork, size, quantity, orientation, spelling, positioning, selected options, and order details. I understand 3T Print Solutions will produce the order according to the information submitted here.';

const STATE_KEY = '3t_print_v4_' + FAMILY_KEY;
const STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_STATE = {
  stepIndex: 0,
  draftToken: null,
  productId: null,
  sizeId: null,
  customSize: null,          // { w, h } in inches when a custom size is entered
  customOpen: false,         // the custom size boxes are showing
  moreSizes: false,          // phones: the rest of a long size list is showing
  qty: null,
  qtyOther: false,           // "Other" quantity is selected (shows the quantity box)
  options: {},               // { groupId: choiceId }
  addonIds: [],
  design: { method: 'upload', logo: 'upload', templateId: null, brief: {} },
  uploads: { front: null, back: null, logo: null, reference: [] },
  orientation: null,         // posters: portrait | landscape
  border: 0.05,              // stickers: white border around the artwork, inches
  backArtwork: 'same',       // double-sided signs: same | different
  placements: {},            // artwork placement on the print canvas: { front, back }
  insurance: true,           // order insurance, where the product offers it (on unless unticked)
  includeMisprints: false,
  discountCode: '',
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
let price = null;         // { estimate, checkout } from the server: the one price everything shows
let priceError = '';
let STEPS = ['product'];
let confirmed = false;    // the review confirmation; never restored from a saved order
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
const isPhone = () => window.matchMedia('(max-width: 600px)').matches;

// ---------------------------------------------------------------- selection
function product() { return family.products.find(p => p.id === state.productId) || null; }
// Until a product is picked, the sections and labels follow the first product.
function shownProduct() { return product() || family.products[0]; }
function sizeObj() { const p = product(); return p ? p.sizes.find(s => s.id === state.sizeId) || null : null; }
function unitLabel(p, qty) { return qty === 1 ? p.unit : p.unit + 's'; }
function design() { return shownProduct().design; }
function group(id) { return shownProduct().options.find(g => g.id === id) || null; }
function choiceOf(g) { return g.choices.find(c => c.id === state.options[g.id]) || g.choices[0]; }
function isImage(f) { return !!f && /^image\//.test(f.mimeType || ''); }
function method() { return design().enabled ? state.design.method : 'upload'; }
function swatchClass(swatch) { return ['holographic', 'silver', 'gold'].includes(swatch) ? swatch : ''; }
function hideUnit() { return HIDE_UNIT_PRICE.includes(family.key); }
const est = () => (price ? price.estimate : null);

// --- display-only mirrors of the server's pricing rules (server/printProducts.js),
// --- used for the prices printed on choice tiles; totals never come from here.
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
// What the configuration so far comes to with one option changed: the base
// price for that combination plus every per-piece / flat option already
// chosen (so a bag color surcharge never drops out of a tile's price).
function subtotalWith(p, size, override) {
  const options = { ...state.options, ...override };
  const base = listPrice(p, size, state.qty, options);
  if (base == null) return null;
  const extras = p.options.filter(g => !g.table).reduce((sum, g) => {
    const c = g.choices.find(x => x.id === options[g.id]) || g.choices[0];
    return sum + eachPrice(c, state.qty) * state.qty + c.flat;
  }, 0);
  return Math.round((base + extras) * 100) / 100;
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
function oriented(w, h) {
  if (state.orientation === 'landscape') return { w: Math.max(w, h), h: Math.min(w, h) };
  if (state.orientation === 'portrait') return { w: Math.min(w, h), h: Math.max(w, h) };
  return { w, h };
}
function dims() {
  const s = state.customSize || sizeObj();
  if (!s) return null;
  const w = Number(s.w) || 0, h = Number(s.h) || 0;
  return w && h ? oriented(w, h) : null;
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
  if (!s) return '';
  // a poster turned landscape reads 24×18 rather than 18×24
  if (family.key === 'posters' && s.w && s.h) { const d = oriented(s.w, s.h); return `${d.w}×${d.h} in`; }
  return s.label;
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
// section if the customer picks double-sided without one.
function sidesComeLater() {
  const flow = FLOWS[family.key];
  return !!group('sides') && flow.indexOf('artwork') < flow.indexOf('opt:sides');
}
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
  if (method() !== 'upload') return [];
  return (hasBackSlot() ? ['front', 'back'] : ['front']).filter(side => isImage(state.uploads[side]));
}
function selectionPayload() {
  const p = product();
  return {
    family: family.key, productId: state.productId, qty: state.qty,
    ...(state.customSize ? { customSize: state.customSize } : { sizeId: state.sizeId }),
    options: state.options, addonIds: state.addonIds,
    design: p.design.enabled ? state.design : null,
    insurance: p.insurancePct > 0 && state.insurance !== false,
    includeMisprints: MISPRINT_FAMILIES.includes(family.key) && !!state.includeMisprints,
    orientation: family.key === 'posters' ? state.orientation : null,
    border: family.key === 'stickers' ? state.border : null,
    backArtwork: family.key === 'yardsigns' && isDouble() ? state.backArtwork : null,
    placements: state.placements,
    artworkConfirmed: confirmed,
  };
}

// ---------------------------------------------------------------- sections
// Option groups (with a real choice to make) that the flow gives their own section.
function placedGroups(p) { return p.options.filter(g => g.choices.length > 1 && FLOWS[family.key].includes('opt:' + g.id)); }
// ...and the ones chosen inside the Add-ons section.
function addonGroups(p) { return p.options.filter(g => g.choices.length > 1 && !FLOWS[family.key].includes('opt:' + g.id)); }
function rushPct() { return (businessInfo && businessInfo.rushFeePct) || 0; }
function computeSteps() {
  const p = shownProduct();
  const steps = [];
  for (const s of FLOWS[family.key]) {
    if (s === 'product') { if (family.products.length > 1) steps.push(s); }
    else if (s === 'size') { if (p.sizes.length > 1 || p.customSize || SCENE_FAMILIES.includes(family.key)) steps.push(s); }
    else if (s === 'edit') { if (editableSides().length) steps.push(s); }
    else if (s.startsWith('opt:')) { if (placedGroups(p).some(g => 'opt:' + g.id === s)) steps.push(s); }
    else if (s === 'addons') { if (addonGroups(p).length || p.addons.length || rushPct() > 0 || MISPRINT_FAMILIES.includes(family.key)) steps.push(s); }
    else steps.push(s);
  }
  return steps;
}
function stepLabel(s) {
  if (s.startsWith('opt:')) { const g = group(s.slice(4)); return g ? g.name : 'Options'; }
  return {
    product: 'Product', orientation: 'Orientation', size: 'Size', quantity: 'Quantity',
    artwork: design().premade ? 'Design' : 'Artwork', edit: 'Position', mockup: 'Position & Cut',
    addons: 'Add-ons', contact: 'Info', review: 'Review',
  }[s];
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
  if (family.key === 'posters' && !state.orientation) state.orientation = 'portrait';
  // a back design uploaded before the Printing section means double-sided, until the customer says otherwise
  if (sidesComeLater() && state.uploads.back && method() === 'upload' && !state.options.sides) state.options.sides = 'double';
  const current = STEPS[state.stepIndex];
  STEPS = computeSteps();
  // keep the customer on the section they were on when the list of sections changes around it
  if (current && STEPS.includes(current)) state.stepIndex = STEPS.indexOf(current);
  state.stepIndex = Math.min(state.stepIndex, STEPS.length - 1);
}

// The progress bar: every section by name (tap one to jump to it) over a bar that fills as the order gets done.
function renderProgress() {
  $('stepRail').innerHTML = STEPS.map((s, i) => {
    const cls = i === state.stepIndex ? 'active' : (i < state.stepIndex ? 'done' : '');
    return `<div class="step-pill ${cls}" data-step-index="${i}" role="button" tabindex="0" ${i === state.stepIndex ? 'aria-current="step"' : ''}>${esc(stepLabel(s))}</div>`;
  }).join('');
  $('progressFill').style.width = `${STEPS.length > 1 ? Math.round(state.stepIndex / (STEPS.length - 1) * 100) : 100}%`;
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
  // Going back from the first section returns to the "What are you ordering?" page.
  if (index < 0) { window.location.href = '/'; return; }
  state.stepIndex = Math.min(STEPS.length - 1, index);
  if (currentStep() === 'edit') viewSide = 'front'; // positioning always starts with the front
  saveState();
  renderStep();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.track3T) window.track3T('step_view', { step: `${family.key}:${currentStep()}` });
}
function goToNamed(name) { const i = STEPS.indexOf(name); if (i >= 0) goToStep(i); }
// Continue / Next: normally the next section; while positioning a
// double-sided design, front goes to back before moving on.
function goNext() {
  if ($('stepNextBtn').disabled) return;
  if (currentStep() === 'review') return submitOrder();
  if (currentStep() === 'edit' && viewSide === 'front' && editableSides().includes('back')) {
    viewSide = 'back';
    renderStep();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  goToStep(state.stepIndex + 1);
}

// What still has to be chosen before a section can be shown, as [message, section to go to].
function missingFor(step) {
  const order = FLOWS[family.key];
  const position = order.indexOf(order.includes(step) ? step : 'addons');
  const after = (earlier) => order.indexOf(earlier) < position;
  if (after('product') && !product()) return ['Please choose a product first.', 'product'];
  if (after('size') && !sizeChosen() && STEPS.includes('size')) return ['Please choose a size first.', 'size'];
  if (after('quantity') && !state.qty) return ['Please choose a quantity first.', 'quantity'];
  // the Printing section itself collects a missing back design (see renderOptionStep), so the front is enough to open it
  const backAskedHere = step === 'opt:sides' && sidesComeLater() && method() === 'upload' && !!state.uploads.front;
  if (after('artwork') && step !== 'contact' && !backAskedHere && !artworkReady()) return ['Please add your artwork first.', 'artwork'];
  return null;
}

function renderStep() {
  const step = currentStep();
  const isContact = step === 'contact';
  $('dynStep').classList.toggle('active', !isContact);
  $('contactStep').classList.toggle('active', isContact);
  renderProgress();
  if (isContact) return hydrateContactForm();

  stepMessage('');
  $('stepNextBtn').textContent = step === 'review' ? 'Confirm & Checkout' : 'Continue';
  $('stepBackBtn').textContent = 'Back';
  $('mobileNextBtn').classList.toggle('hidden', step === 'review');
  const missing = step === 'product' ? null : missingFor(step);
  if (missing) {
    setHead(stepLabel(step), '');
    body.innerHTML = `<div class="prereq-notice"><p>${missing[0]}</p><button type="button" class="btn btn-dark btn-sm" data-goto="${missing[1]}">Go to ${esc(stepLabel(missing[1]))}</button></div>`;
    setNext(false);
    return;
  }
  if (step.startsWith('opt:')) renderOptionStep(group(step.slice(4)));
  else ({ product: renderProducts, orientation: renderOrientation, size: renderSizes, quantity: renderQuantity, artwork: renderArtworkStep, edit: renderEditStep, mockup: renderStickerStep, addons: renderAddons, review: renderReview })[step]();
}
function setHead(title, sub) { $('stepTitle').textContent = title; $('stepSub').textContent = sub || ''; }
function setNext(enabled) { $('stepNextBtn').disabled = !enabled; $('mobileNextBtn').disabled = !enabled; }
function stepMessage(msg) { const el = $('stepMsg'); el.textContent = msg || ''; el.classList.toggle('hidden', !msg); }

$('stepBackBtn').addEventListener('click', () => goToStep(state.stepIndex - 1));
$('stepNextBtn').addEventListener('click', goNext);
$('mobileNextBtn').addEventListener('click', goNext);
$('contactBackBtn').addEventListener('click', () => goToStep(state.stepIndex - 1));
$('backToTopBtn').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

// One click handler for everything drawn into the section body. A single
// tap on a tile selects it; a second tap on the same tile straight after
// (a double-tap) moves on to the next section.
let lastTap = { key: '', at: 0 };
body.addEventListener('click', (e) => {
  const t = e.target.closest('[data-goto],[data-product-id],[data-size-id],[data-qty],[data-choice],[data-orient],[data-method],[data-logo],[data-template],[data-style],[data-slot-add],[data-slot-remove],[data-pill],[data-act]');
  if (!t) return;
  if (t.tagName === 'A') e.preventDefault();
  const d = t.dataset;
  if (t.classList.contains('option-card') && !d.method && !d.template) {
    const key = JSON.stringify(d), now = Date.now();
    const again = key === lastTap.key && now - lastTap.at < 500;
    lastTap = { key, at: now };
    if (again && !$('stepNextBtn').disabled) { lastTap = { key: '', at: 0 }; return goNext(); }
  }
  if (d.goto) return goToNamed(d.goto);
  if (d.productId) return pickProduct(d.productId);
  if (d.sizeId) return pickSize(d.sizeId);
  if (d.qty) return pickQty(d.qty);
  if (d.choice) return pickChoice(d.group, d.choice);
  if (d.orient) { state.orientation = d.orient; saveState(); return renderStep(); }
  if (d.method) return setMethod(d.method);
  if (d.logo) { state.design.logo = d.logo; refreshPrice(); return renderStep(); }
  if (d.template) return openTemplate(d.template);
  if (d.style) { state.design.brief.style = d.style; saveState(); return renderStep(); }
  if (d.slotAdd) return chooseFile(d.slotAdd);
  if (d.slotRemove) return removeFile(d.slotRemove, d.fileId);
  if (d.pill) return pickPill(d.pill, d.value);
  if (d.act === 'customSize') { state.customOpen = !state.customOpen; if (!state.customOpen) state.customSize = null; saveState(); return renderStep(); }
  if (d.act === 'moreSizes') { state.moreSizes = true; saveState(); return renderStep(); }
  if (d.act === 'viewMockup') return viewMockup();
});
function setMethod(m) {
  state.design.method = m;
  reconcileSelection();
  refreshPrice();
  renderStep();
  // straight to the place where the files go, instead of leaving the customer at the cards
  if (m === 'upload') { const slot = body.querySelector('.slot'); if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
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
  // the pack pictures carry the design the customer already added
  body.querySelectorAll('[data-bag-thumb]').forEach(el => {
    const s = family.products.find(x => x.id === el.dataset.bagThumb).sizes[0];
    PrintMockups.bag(el, { w: s.w, h: s.h, printW: s.printW, printH: s.printH, swatch: '#111111', artworkUrl: artFor('front'), placement: state.placements.front });
    el.querySelector('svg').style.cssText = 'height:110px;width:auto;';
  });
  setNext(!!product());
}
function pickProduct(id) {
  if (state.productId !== id) {
    Object.assign(state, { productId: id, sizeId: null, customSize: null, qty: null, qtyOther: false, options: {}, addonIds: [], placements: {} });
    price = null;
    // a premade design picked before the product only carries over if this product offers it
    const offered = family.products.find(p => p.id === id).design.templates;
    if (state.design.templateId && !offered.some(t => t.id === state.design.templateId)) state.design.templateId = null;
  }
  reconcileSelection();
  refreshPrice();
  renderStep();
}

// ---------------------------------------------------------------- orientation (posters)
function renderOrientation() {
  setHead('Portrait or Landscape?', 'Which way will your poster hang? You can change this later.');
  const card = (value, label, w, h) => `<div class="option-card ${state.orientation === value ? 'selected' : ''}" data-orient="${value}" role="button" tabindex="0" aria-pressed="${state.orientation === value}" style="align-items:center;text-align:center;">
      <div class="shape-icon" style="width:${w}px;height:${h}px;"></div>
      <div class="oc-title">${label}</div>
    </div>`;
  body.innerHTML = `<div class="option-grid" style="grid-template-columns:repeat(2,minmax(0,220px));">${card('portrait', 'Portrait', 44, 62)}${card('landscape', 'Landscape', 62, 44)}</div>`;
  setNext(!!state.orientation);
}
function orientationPills() {
  return `<div class="sub-heading">Orientation</div>${pills('orientation', state.orientation || 'portrait', [['portrait', 'Portrait'], ['landscape', 'Landscape']])}`;
}

// ---------------------------------------------------------------- size
function renderSizes() {
  const p = product();
  setHead('Choose Your Size', family.key === 'stickers' ? 'Pricing shows once you pick a quantity.' : p.description);
  const plain = family.key === 'stickers'; // sticker tiles show the size only
  const label = (s) => (family.key === 'posters' && s.w && s.h ? (() => { const d = oriented(s.w, s.h); return `${d.w}×${d.h}`; })() : s.label.replace(/ in$/, ''));
  const priceLine = (s) => {
    if (plain) return '';
    const table = tableFor(p, s);
    const from = table.length ? `From ${money(Math.min(...table.map(k => k.price)))}` : '';
    const amount = state.qty ? listPrice(p, s, state.qty) : null;
    return `<div class="oc-price">${from}</div>${amount != null ? `<div class="oc-sub">${money(amount)} for ${state.qty.toLocaleString('en-US')}</div>` : ''}`;
  };
  const c = state.customSize;
  // phones show the first four of a long list, with the rest one tap away
  const collapsed = isPhone() && p.sizes.length > 4 && !state.moreSizes && family.key === 'yardsigns';
  const sizes = collapsed ? p.sizes.slice(0, 4) : p.sizes;
  const customOpen = p.customSize && (state.customOpen || !!c);
  body.innerHTML = `
    <div class="option-grid ${plain ? 'tile-grid' : family.key === 'posters' ? 'size-grid-4' : ''}">${sizes.map(s => `
      <div class="option-card ${!c && s.id === state.sizeId ? 'selected' : ''}" data-size-id="${esc(s.id)}" role="button" tabindex="0" aria-pressed="${!c && s.id === state.sizeId}">
        <div class="oc-title" style="font-size:${plain ? 15 : 17}px;">${esc(label(s))}</div>
        ${priceLine(s)}
      </div>`).join('')}</div>
    ${collapsed ? '<div style="margin-top:10px;"><button type="button" class="btn btn-outline btn-sm" data-act="moreSizes">View More Sizes</button></div>' : ''}
    ${p.customSize && !collapsed ? `<div style="margin-top:14px;"><button type="button" class="link-btn" data-act="customSize" aria-expanded="${customOpen}">${family.key === 'yardsigns' ? 'Other / Custom Size' : 'Custom Size'} ${customOpen ? '▲' : '▼'}</button></div>` : ''}
    ${customOpen ? `
    <div class="inline-fields" style="margin-top:10px;">
      <div class="field"><label for="customW">Width (in)</label><input type="number" id="customW" min="0.5" step="0.25" inputmode="decimal" value="${c ? c.w : ''}"></div>
      <div class="field"><label for="customH">Height (in)</label><input type="number" id="customH" min="0.5" step="0.25" inputmode="decimal" value="${c ? c.h : ''}"></div>
    </div>
    <p class="muted" id="customSizeNote" style="font-size:12.5px;margin-top:8px;"></p>` : ''}
    ${SCENE_FAMILIES.includes(family.key) ? `<div class="sub-heading" id="sceneHeading">${family.key === 'posters' ? 'Room Size Preview' : 'Size Preview'}</div><div class="mock-wrap" id="sizeScene" style="margin-top:0;"></div><p class="mock-note">Size preview is an approximate visual representation.</p>` : ''}`;
  if (customOpen) {
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
  drawScene($('sizeScene'));
  setNext(sizeChosen());
  refreshPrice();
}
// The room / yard picture for the current size, with the artwork if there is some.
function drawScene(host) {
  if (!host) return;
  const d = dims();
  if (!d) { host.innerHTML = '<p class="muted" style="margin:0;font-size:13px;">Pick a size to see it to scale.</p>'; return; }
  const side = hasBackSlot() && viewSide === 'back' ? 'back' : 'front';
  const opts = { ...d, artworkUrl: artFor(side), placement: state.placements[side] };
  if (family.key === 'posters') PrintMockups.room(host, { ...opts, readonly: true });
  else if (family.key === 'yardsigns') PrintMockups.yard(host, opts);
}
function pickSize(id) {
  state.sizeId = id;
  state.customSize = null;
  state.customOpen = false;
  reconcileSelection();
  renderStep();
  // show the size they just picked, to scale, without making them hunt for it
  const scene = $('sceneHeading');
  if (scene) scene.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- quantity
// The quantity buttons: the product's quick quantities (or the quantities
// in its price table), plus Other for any amount.
function quantityChoices(p, size) {
  const tableQtys = (s) => [...s.packs, ...(s.tables || []).flatMap(t => t.packs)].map(k => k.qty);
  const table = size ? tableFor(p, size) : [];
  if (p.quickQtys && p.quickQtys.length) return p.quickQtys;
  return (table.length ? table.map(k => k.qty) : [...new Set(p.sizes.flatMap(tableQtys))]).sort((a, b) => a - b);
}
function minQty(p, size) {
  const table = size ? tableFor(p, size) : [];
  return table.length ? table[0].qty : 1;
}
function renderQuantity() {
  const p = product(), size = pricingSize();
  const quantities = quantityChoices(p, size);
  const table = size ? tableFor(p, size) : [];
  const firstUnit = table.length ? table[0].price / table[0].qty : null;
  const other = p.customQty && (state.qtyOther || (state.qty && !quantities.includes(state.qty)));
  const otherLabel = family.key === 'stickers' ? 'Custom' : 'Other';
  const otherTile = p.customQty ? `<div class="option-card ${other ? 'selected' : ''}" data-qty="other" role="button" tabindex="0" aria-pressed="${!!other}"><div class="oc-big">${otherLabel}</div><div class="oc-sub">Any amount</div></div>` : '';
  const tiles = quantities.map(q => {
    const amount = size ? listPrice(p, size, q) : null;
    // savings against buying the smallest listed quantity over and over; left off when that
    // comparison is meaningless (a one-off single at a handling price makes everything "90% off")
    const rawSaving = amount != null && table.length && q > table[0].qty ? Math.round((firstUnit * q - amount) * 100) / 100 : 0;
    const saving = amount != null && rawSaving <= amount ? rawSaving : 0;
    const selected = !other && q === state.qty;
    return `<div class="option-card ${selected ? 'selected' : ''}" data-qty="${q}" role="button" tabindex="0" aria-pressed="${selected}">
      <div class="oc-big">${q.toLocaleString('en-US')}</div>
      ${amount != null ? `<div class="oc-price">${money(amount)}</div>${!hideUnit() && q > 1 ? `<div class="oc-sub">${money(amount / q)} each</div>` : ''}` : ''}
      ${saving > 0 && !hideUnit() ? `<div class="oc-save">Save ${money(saving)}</div>` : ''}
    </div>`;
  });
  setHead('How Many?', size ? `${sizeText() ? sizeText() + ' ' : ''}${unitLabel(p, 2)}.` : '');
  // stickers lead with Custom; everything else ends with Other
  body.innerHTML = `
    <div class="option-grid tile-grid">${family.key === 'stickers' ? otherTile + tiles.join('') : tiles.join('') + otherTile}</div>
    ${other ? `
    <div class="inline-fields" style="margin-top:14px;">
      <div class="field"><label for="customQty">${family.key === 'yardsigns' ? 'Specific Quantity' : 'Quantity'}</label><input type="number" id="customQty" min="${minQty(p, size)}" max="${p.maxQty}" step="1" inputmode="numeric" value="${state.qty || ''}"></div>
    </div>
    <p class="muted" id="customQtyNote" style="font-size:12.5px;margin-top:8px;"></p>` : ''}`;
  if (other) {
    $('customQty').addEventListener('input', () => {
      const q = Math.floor(Number($('customQty').value));
      state.qty = q >= 1 ? q : null;
      afterQtyChange();
    });
  }
  afterQtyChange();
}
function afterQtyChange() {
  const p = product(), size = pricingSize();
  reconcileSelection(); // drops an add-on this quantity doesn't qualify for
  const min = minQty(p, size);
  const note = $('customQtyNote');
  let ok = !!state.qty, msg = min > 1 ? `Minimum ${min}.` : '';
  if (state.qty && state.qty < min) { ok = false; msg = `The minimum order is ${min}.`; }
  else if (state.qty > p.maxQty) { ok = false; msg = `For more than ${p.maxQty.toLocaleString('en-US')}, contact us for a custom quote.`; }
  else if (state.qty && size) {
    const amount = listPrice(p, size, state.qty);
    if (amount != null) msg = `${state.qty.toLocaleString('en-US')} ${unitLabel(p, state.qty)}: ${money(amount)}${hideUnit() ? '' : ` (${money(amount / state.qty)} each)`}.`;
  }
  if (note) note.textContent = msg;
  setNext(ok);
  renderProgress();
  refreshPrice();
}
function pickQty(value) {
  if (value === 'other') { state.qtyOther = true; state.qty = null; }
  else { state.qtyOther = false; state.qty = Number(value); }
  saveState();
  renderStep();
  if (value === 'other' && $('customQty')) $('customQty').focus();
}

// ---------------------------------------------------------------- option groups
// What a choice costs on top of the group's first (standard) choice.
function choiceCostLabel(p, g, c) {
  const size = pricingSize();
  if (g.table) {
    if (!size || !state.qty) return '';
    const withThis = listPrice(p, size, state.qty, { ...state.options, [g.id]: c.id });
    const standard = listPrice(p, size, state.qty, { ...state.options, [g.id]: g.choices[0].id });
    if (withThis == null || standard == null) return '';
    const delta = Math.round((withThis - standard) * 100) / 100;
    return delta > 0 ? `+${money(delta)}` : delta < 0 ? `−${money(-delta)}` : 'Included';
  }
  const each = eachPrice(c, state.qty);
  const total = Math.round((each * (state.qty || 1) + c.flat) * 100) / 100;
  if (!total) return 'Included';
  return hideUnit() && state.qty ? `+${money(total)}` : [each > 0 ? `+${money(each)}/${esc(p.unit)}` : '', c.flat > 0 ? `+${money(c.flat)}` : ''].filter(Boolean).join(' ');
}
function renderOptionStep(g) {
  const p = product(), size = pricingSize();
  setHead(g.name, g.description);
  const current = choiceOf(g);
  const hasSwatches = g.choices.some(c => c.swatch);
  body.innerHTML = `<div class="option-grid" style="grid-template-columns:repeat(auto-fill,minmax(${hasSwatches ? 120 : 200}px,1fr));">${g.choices.map(c => {
    // a choice that sets the price table shows what the order comes to with it, everything else chosen included
    const total = g.table && size && state.qty ? subtotalWith(p, size, { [g.id]: c.id }) : null;
    return `<div class="option-card ${c.id === current.id ? 'selected' : ''}" data-group="${esc(g.id)}" data-choice="${esc(c.id)}" role="button" tabindex="0" aria-pressed="${c.id === current.id}">
      ${c.swatch ? `<span class="oc-swatch ${swatchClass(c.swatch)}" style="${swatchClass(c.swatch) ? '' : `background:${esc(c.swatch)};`}"></span>` : ''}
      <div class="oc-title">${esc(c.name)}</div>
      ${c.description ? `<div class="oc-sub">${esc(c.description)}</div>` : ''}
      <div class="oc-price">${total != null ? `${money(total)} total` : choiceCostLabel(p, g, c)}</div>
    </div>`;
  }).join('')}</div>
  ${g.id === 'color' && family.key === 'mylar' && dims() ? `<div class="sub-heading">Your pack in ${esc(current.name)}</div>${pills('side', viewSide, [['front', 'Front'], ['back', 'Back']])}<div class="mock-wrap" id="colorMock" style="max-width:240px;"></div>` : ''}
  ${g.id === 'sides' && family.key === 'yardsigns' && current.id === 'double' ? `
    <div class="sub-heading">Is the back the same as the front?</div>
    ${pills('backArtwork', state.backArtwork, [['same', 'Same artwork on both sides'], ['different', 'Different artwork on each side']])}` : ''}`;
  if ($('colorMock')) drawBag($('colorMock'), viewSide === 'back' ? 'back' : 'front');
  setNext(true);
  // Double-sided chosen after the design section, with no back design yet: ask for it here.
  if (g.id === 'sides' && sidesComeLater() && hasBackSlot() && !state.uploads.back) {
    body.insertAdjacentHTML('beforeend', `<div class="sub-heading">Add your back design</div>${slotHtml('back', 'Back Design')}`);
    setNext(false);
    stepMessage('Upload your back design to continue, or choose Single-Sided.');
  }
}
function pickChoice(groupId, choiceId) {
  state.options[groupId] = choiceId;
  reconcileSelection(); // single / double-sided changes which artwork is asked for
  refreshPrice();
  renderStep();
}
function pickPill(name, value) {
  if (name === 'border') state.border = Number(value);
  else if (name === 'side') viewSide = value;
  else if (name === 'gallery') galleryTab = value;
  else if (name.startsWith('opt:')) return pickChoice(name.slice(4), value);
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
// Finishing choices that are not their own section (mylar lamination),
// rush, the misprints preference, and the product's flat add-ons.
function renderAddons() {
  const p = product();
  setHead('Add-ons', 'Optional finishing and extras for this order.');
  const check = (id, attrs, checked, title, cost, text, locked) => `<div class="terms-row addon-row ${locked ? 'is-off' : ''}">
      <input type="checkbox" id="${id}" ${attrs} ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
      <label for="${id}"><strong style="color:var(--3t-black);">${title}</strong>${cost ? ` (${cost})` : ''}<br>${text}</label>
    </div>`;
  const pct = rushPct();
  body.innerHTML = addonGroups(p).map(g => `
      <div class="sub-heading">${esc(g.name)}</div>
      ${pills('opt:' + g.id, choiceOf(g).id, g.choices.map(c => [c.id, `${esc(c.name)} <span style="font-weight:400;margin-left:6px;">${choiceCostLabel(p, g, c)}</span>`]))}`).join('')
    + (addonGroups(p).length ? '<div class="sub-heading">Extras</div>' : '')
    + (pct > 0 ? check('rushBox', 'data-flag="rush"', state.rush, 'Rush Production', `+${pct}% of your order`, 'Need it faster? We move your order to the front of our production queue.') : '')
    + (MISPRINT_FAMILIES.includes(family.key) ? check('misprintBox', 'data-flag="includeMisprints"', state.includeMisprints, 'Include Misprints', 'free',
      'If usable extra or misprinted labels are produced during manufacturing, include them with my order: up to about 10% of the quantity ordered. Extras are not guaranteed.') : '')
    + p.addons.map(a => {
      const locked = !!(a.minQty && state.qty < a.minQty);
      return check(`addon_${esc(a.id)}`, `data-addon-id="${esc(a.id)}"`, state.addonIds.includes(a.id), esc(a.name), `+${money(a.price)}`,
        esc(a.description) + (locked ? ` <strong>Order ${a.minQty} or more to add this.</strong>` : ''), locked);
    }).join('');
  setNext(true);
}
body.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.addonId) {
    state.addonIds = el.checked ? [...new Set([...state.addonIds, el.dataset.addonId])] : state.addonIds.filter(x => x !== el.dataset.addonId);
    refreshPrice();
  } else if (el.dataset.flag) {
    state[el.dataset.flag] = el.checked;
    refreshPrice();
  } else if (el.id === 'confirmCheckbox') {
    confirmed = el.checked; setNext(confirmed && !!price);
  }
});
body.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.brief) { state.design.brief[el.dataset.brief] = el.value; saveState(); updateArtworkNext(); }
  else if (el.id === 'designNotes') { state.designNotes = el.value; saveState(); updateArtworkNext(); }
  else if (el.id === 'discountCode') { state.discountCode = el.value.trim(); saveState(); }
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
async function uploadFile(file, locationName) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('draftToken', await ensureDraftToken());
  fd.append('locationName', locationName);
  return (await api('/uploads', { method: 'POST', body: fd })).file;
}
$('slotFileInput').addEventListener('change', async () => {
  const input = $('slotFileInput');
  const file = input.files[0];
  input.value = '';
  if (!file || !pendingSlot) return;
  const slot = pendingSlot;
  try {
    const uploaded = await uploadFile(file, slotLocation(slot));
    if (slot === 'reference') state.uploads.reference.push(uploaded);
    else {
      const old = state.uploads[slot];
      state.uploads[slot] = uploaded;
      if (old) api(`/uploads/${old.id}`, { method: 'DELETE' }).catch(() => {});
      delete state.placements[slot]; // new artwork starts fitted and centered
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

// The editor for one side, with a live preview of the finished product under it.
function editorBlock(sides) {
  const side = sides.includes(viewSide) ? viewSide : sides[0];
  return `${sides.length > 1 ? pills('side', side, sides.map(s => [s, s === 'front' ? 'Front' : 'Back'])) : ''}
    <div class="mock-wrap" id="editorHost"></div>
    <p class="mock-note" style="text-align:center;">Drag or use the arrows to move your artwork; pinch or use the slider to size it. The dashed outline is the ${family.key === 'mylar' ? 'label' : 'print'} area and empty space prints white.</p>`;
}
function mountEditor(sides, onChange) {
  const side = sides.includes(viewSide) ? viewSide : sides[0];
  const c = canvasDims();
  if (!c || !$('editorHost')) return;
  PrintMockups.editor($('editorHost'), {
    w: c.w, h: c.h, artworkUrl: artFor(side), placement: state.placements[side],
    onChange: (placement) => { state.placements[side] = placement; saveState(); if (onChange) onChange(); },
  });
}

function renderArtworkStep() {
  const d = design();
  const m = method();
  const inline = INLINE_EDIT_FAMILIES.includes(family.key);
  const notes = `<div class="field mt-16"><label for="designNotes">Design Notes - Optional</label>
    <textarea id="designNotes" placeholder="Describe any design details, preferences, or specifications we should be aware of.">${esc(state.designNotes)}</textarea></div>`;
  // One quiet line under the upload area, gone as soon as the artwork is uploaded.
  const needsArt = !state.uploads.front || (hasBackSlot() && !state.uploads.back);
  const createLine = d.enabled && d.custom && needsArt
    ? `<p class="no-art-line"><a href="#" data-method="custom">${NO_ARTWORK_LINE}</a>${d.customFee > 0 ? ` <span class="muted">(+${money(d.customFee)} design fee)</span>` : ''}</p>` : '';
  const backOptional = sidesComeLater() && !state.options.sides; // single / double-sided not chosen yet
  const sides = editableSides();
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
  const revisionLine = d.revisions === 1
    ? 'Custom Design includes one revision after the initial proof. Additional revisions may require an additional design fee.'
    : d.revisions > 1 ? `Custom Design includes ${d.revisions} revisions after the initial proof. Additional revisions may require an additional design fee.` : '';

  let detail = '';
  if (m === 'upload') {
    // posters and yard signs: upload and position in the same place, with the finished product shown underneath
    detail = uploadSlots() + notes + (inline && sides.length && canvasDims() ? `
      <div class="sub-heading">Position your artwork</div>
      ${family.key === 'posters' && canvasDims().w !== canvasDims().h ? orientationPills() : ''}
      ${editorBlock(sides)}
      <div class="sub-heading">${family.key === 'posters' ? 'On your wall' : 'In your yard'}</div>
      <div class="mock-wrap" id="liveScene" style="margin-top:0;"></div>
      <p class="mock-note">Preview is an approximate size reference. Actual appearance may vary.</p>` : '');
  }
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
      ${briefField('brandInfo', 'Brand Information - Optional', 'Brand name, product name, tagline or anything else to put on the design.', true)}${notes}`;
  }
  if (m === 'custom') {
    detail = `<div class="design-request">
      <p style="font-size:13.5px;margin:0 0 12px;"><strong>3T will create your artwork${d.customFee > 0 ? ` (+${money(d.customFee)} design fee)` : ''}.</strong> Custom artwork is produced after checkout; it is not an instant proof. We'll send you a proof to approve before anything is printed. ${revisionLine}
        ${d.premade ? '' : '<a href="#" data-method="upload">I have my own artwork instead.</a>'}</p>
      <div class="field-row">${briefField('designName', 'Design Name', 'What should we call this design?')}${briefField('theme', 'Product / Flavor / Theme Name', 'e.g. Blue Razz')}</div>
      <div class="field-row">${briefField('primaryColors', 'Primary Colors', 'e.g. electric blue, black')}${briefField('secondaryColors', 'Secondary Colors', 'e.g. silver, white')}</div>
      <div class="field"><label>Design Style</label><div class="radio-pill-group">${DESIGN_STYLES.map(s =>
        `<div class="radio-pill ${brief.style === s ? 'selected' : ''}" data-style="${s}" role="button" tabindex="0" aria-pressed="${brief.style === s}">${s}</div>`).join('')}</div></div>
      ${briefField('inspiration', 'Design Inspiration', 'Describe the look you have in mind.', true)}
      ${slotHtml('reference', 'Reference Images - Optional', 'Examples, sketches or inspiration')}
      ${logoChoices([['upload', 'Upload existing logo'], ['text', 'Use text only'], ['design', `Design a logo for me${logoFee}`]])}
      ${briefField('instructions', 'Additional Instructions - Optional', 'Anything else we should know?', true)}
    </div>`;
  }
  // Products with premade designs choose a design method first; the rest just upload.
  const methods = d.premade ? [
    ['upload', 'Upload My Design', isDouble() || backOptional ? 'Send your own front and back artwork.' : 'Send your own artwork.', 'Free'],
    ['premade', 'Use Premade Design', 'Pick one of our designs. Adding your existing logo is free.', 'Free'],
    d.custom ? ['custom', 'Custom Design', 'We create the artwork for you. One revision included.', d.customFee > 0 ? `+${money(d.customFee)}` : 'Free'] : null,
  ].filter(Boolean) : [];
  setHead(d.premade ? 'Your Design' : (m === 'custom' ? 'Tell Us What You Need' : inline ? 'Upload & Position Artwork' : 'Upload Your Artwork'),
    d.premade ? 'How would you like to handle the artwork?' : (m === 'custom' ? '' : 'PNG, JPG, PDF, or SVG.'));
  body.innerHTML = (methods.length ? `<div class="option-grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr));margin-bottom:18px;">${methods.map(([v, title, sub, cost]) => `
    <div class="option-card ${m === v ? 'selected' : ''}" data-method="${v}" role="button" tabindex="0" aria-pressed="${m === v}">
      <div class="oc-title">${title}</div><div class="oc-sub">${sub}</div><div class="oc-price">${cost}</div>
    </div>`).join('')}</div>` : '') + detail;
  if ($('editorHost')) {
    drawScene($('liveScene'));
    mountEditor(sides, () => drawScene($('liveScene')));
  }
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

// ---------------------------------------------------------------- position (mylar: front, then back)
function renderEditStep() {
  const sides = editableSides();
  const side = sides.includes(viewSide) ? viewSide : sides[0];
  const label = sides.length > 1 ? (side === 'front' ? 'Front' : 'Back') : '';
  setHead(`Position Your ${label ? label + ' ' : ''}Artwork`, sides.length > 1 && side === 'front' ? 'Start with the front. Continue takes you to the back.' : 'Place it the way you want it printed.');
  if (!canvasDims()) { body.innerHTML = '<p class="muted">Choose a product to position your artwork.</p>'; return setNext(true); }
  body.innerHTML = `${editorBlock(sides)}
    <div class="sub-heading">On your pack</div>
    <div class="mock-wrap" id="editBag" style="max-width:240px;margin-top:0;"></div>`;
  drawBag($('editBag'), side);
  mountEditor(sides, () => drawBag($('editBag'), side));
  setNext(true);
}

// ---------------------------------------------------------------- previews
function drawBag(host, side) {
  if (!host) return;
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
function drawSticker() {
  const host = $('stickerHost');
  const d = dims();
  if (host && d && artFor('front')) PrintMockups.sticker(host, { ...d, artworkUrl: artFor('front'), placement: state.placements.front, border: state.border });
}
// The finished product as the customer configured it, for the review.
function drawFinal(host) {
  if (family.key === 'mylar') return drawBag(host, 'front');
  drawScene(host);
}

// ---------------------------------------------------------------- stickers: position + white border / cut line
function renderStickerStep() {
  setNext(true);
  setHead('Position & Cut', 'Place your artwork, then choose your white border. The pink line is where the sticker is cut.');
  if (!dims()) { body.innerHTML = '<p class="muted">A preview is not available for this size. You can continue with your order.</p>'; return; }
  if (!artFor('front')) {
    body.innerHTML = `<p class="muted">${method() === 'custom' ? "We'll set the cut line once your artwork is designed, and show it on your proof." : "We can't preview this file type here. We'll set the cut line and send a proof if anything looks off."}</p>`;
    return;
  }
  const custom = !BORDER_PRESETS.includes(state.border);
  body.innerHTML = `${editorBlock(['front'])}
    <div class="sub-heading">White Border</div>
    <p style="font-size:13.5px;margin:0 0 10px;"><strong>A white border adds a solid white layer around the outside edge of your entire design. The cutter follows the outside perimeter of that shape instead of cutting every small interior opening or detail.</strong></p>
    <div class="mock-tools" style="margin-top:0;">
      ${pills('border', custom ? 'custom' : state.border, BORDER_PRESETS.map(b => [b, b === 0 ? 'None' : `${b}"`]))}
      <div class="field" style="margin:0;width:120px;"><input type="number" id="customBorder" min="0" max="2" step="0.01" inputmode="decimal" placeholder="Custom (in)" aria-label="Custom border in inches" value="${custom ? state.border : ''}"></div>
    </div>
    <div class="mock-wrap" id="stickerHost"></div>
    <p class="mock-note">Holes inside letters and small interior gaps are not cut out, so the sticker comes off in one piece. Preview is approximate; we check every file before cutting.</p>`;
  let pending = null; // redraw the cut line once the artwork stops moving
  mountEditor(['front'], () => { clearTimeout(pending); pending = setTimeout(drawSticker, 120); });
  drawSticker();
}

// ---------------------------------------------------------------- review
function itemRows() {
  const p = product(), o = est() ? est().printOrder : null;
  const rows = [];
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
  rows.push(['Artwork', files.length ? files.map(([slot, f]) => (slotLocation(slot) === 'Artwork' ? '' : `${esc(slotLocation(slot))}: `) + esc(f.filename)).join('<br>') : 'Created by 3T Print Solutions']);
  for (const a of p.addons) if (state.addonIds.includes(a.id)) rows.push(['Add-on', esc(a.name)]);
  if (state.includeMisprints && MISPRINT_FAMILIES.includes(family.key)) rows.push(['Misprints', 'Include if available']);
  if (state.rush) rows.push(['Rush', 'Yes']);
  rows.push(['Delivery', state.contact.fulfillmentMethod === 'shipping' ? 'Ground Shipping' : 'Local Pickup']);
  return { rows, files };
}
function hasFinalMock() { return !!dims() && (family.key !== 'stickers' || !!artFor('front')); }
function renderReview() {
  const p = product();
  setHead('Review Your Order', 'Check everything below. This is what we will produce.');
  $('stepBackBtn').textContent = 'Edit Order';
  if (!price) {
    body.innerHTML = `<div class="prereq-notice"><p>${esc(priceError || 'We could not price this order yet.')}</p><button type="button" class="btn btn-dark btn-sm" data-goto="${STEPS[0]}">Edit Order</button></div>`;
    return setNext(false);
  }
  const { rows, files } = itemRows();
  const e = est(), c = price.checkout, b = e.printOrder.breakdown;
  const row = (k, v, cls) => `<div class="review-row ${cls || ''}"><span class="rk">${k}</span><span class="rv">${v}</span></div>`;
  const isSticker = family.key === 'stickers';
  const insurancePct = Number(p.insurancePct) || 0;
  // what insurance would cost if it were (still) ticked, so the box can say its price either way
  const insuranceAmount = b.insurance || Math.round((b.products + b.options + b.design + b.addons) * insurancePct) / 100;
  body.innerHTML = `
    <div class="review-list" style="padding-top:12px;padding-bottom:12px;">
      <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;">
        ${hasFinalMock() ? `<div id="${isSticker ? 'stickerHost' : 'reviewMock'}" style="width:${family.key === 'mylar' ? 130 : 210}px;flex-shrink:0;"></div>` : ''}
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:900;font-size:16px;margin-bottom:4px;">${esc(p.name)}</div>
          ${rows.map(([k, v]) => `<div style="font-size:13.5px;padding:2px 0;"><span class="muted">${k}:</span> <strong>${v}</strong></div>`).join('')}
          ${hasFinalMock() ? '<button type="button" class="link-btn" data-act="viewMockup" style="margin-top:8px;">View Approved Mockup</button>' : ''}
        </div>
      </div>
    </div>
    ${files.length ? `<div class="review-art">${files.map(([slot, f]) => `<figure>${isImage(f) ? `<img src="${esc(f.url)}" alt="">` : `<div style="width:96px;height:96px;border:1.5px solid var(--3t-border);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;">${esc((f.filename.split('.').pop() || '').toUpperCase())}</div>`}<figcaption>${esc(slotLocation(slot))}</figcaption></figure>`).join('')}</div>` : ''}
    <div class="review-list">
      ${row('Products', money(b.products))}
      ${b.design > 0 ? row('Design', money(b.design)) : ''}
      ${b.options + b.addons > 0 ? row('Add-ons', money(b.options + b.addons)) : ''}
      ${b.insurance > 0 ? row('Insurance', money(b.insurance)) : ''}
      ${e.discount ? row(`Discount (${esc(e.discount.code)})`, `−${money(e.discountAmount)}`) : ''}
      ${c.rushFee > 0 ? row('Rush', money(c.rushFee)) : ''}
      ${row('Shipping', c.shippingFee > 0 ? money(c.shippingFee) : 'Local pickup, free')}
      ${row('Estimated Tax', money(c.taxAmount))}
      ${row('Estimated Total', money(c.grandTotal), 'total')}
    </div>
    <div class="field" style="max-width:260px;"><label for="discountCode">Discount Code - Optional</label><input type="text" id="discountCode" value="${esc(state.discountCode)}" style="text-transform:uppercase;" autocomplete="off"></div>
    ${insurancePct > 0 ? `<div class="terms-row">
      <input type="checkbox" id="insuranceBox" data-flag="insurance" ${state.insurance !== false ? 'checked' : ''}>
      <label for="insuranceBox"><strong style="color:var(--3t-black);">Order Insurance - ${money(insuranceAmount)}</strong> (${insurancePct}% of your order)<br>
        Covers eligible order issues according to the applicable order-insurance terms.</label>
    </div>` : ''}
    <div class="terms-row">
      <input type="checkbox" id="confirmCheckbox" ${confirmed ? 'checked' : ''}>
      <label for="confirmCheckbox">${CONFIRM_TEXT} Read our <a href="/terms.html" target="_blank">Custom Order Terms</a>.</label>
    </div>
    <p class="muted" style="font-size:12.5px;">Confirm &amp; Checkout takes you straight to secure payment. A copy of this order is emailed to you.</p>`;
  if (hasFinalMock()) { if (isSticker) drawSticker(); else drawFinal($('reviewMock')); }
  setNext(confirmed);
}

// ---- the approved mockup: a picture of exactly what the customer saw on
// ---- the review, saved with the order so it is never redrawn differently later
function toDataUrl(url) {
  return fetch(url).then(r => r.blob()).then(blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  }));
}
async function mockupBlob() {
  const host = $('stickerHost') || $('reviewMock');
  if (!host) return null;
  const canvas = host.querySelector('canvas');
  if (canvas) return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const svg = host.querySelector('svg');
  if (!svg) return null;
  // a standalone copy of the drawing, with the artwork embedded, drawn onto a canvas
  const copy = svg.cloneNode(true);
  for (const image of copy.querySelectorAll('image')) {
    const href = image.getAttribute('href');
    if (href && !href.startsWith('data:')) image.setAttribute('href', await toDataUrl(href));
  }
  const box = svg.viewBox.baseVal;
  const width = 1000, height = Math.round(width * box.height / box.width);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', width); copy.setAttribute('height', height);
  copy.removeAttribute('style');
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise(resolve => out.toBlob(resolve, 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
async function viewMockup() {
  const tab = window.open('', '_blank');
  try {
    const blob = await mockupBlob();
    if (!blob) throw new Error('No mockup');
    if (tab) tab.location = URL.createObjectURL(blob);
  } catch (err) {
    if (tab) tab.close();
    showToast('Could not open the mockup.');
  }
}

// ---------------------------------------------------------------- contact
// Optional fields follow Settings > Contact Form, like the apparel builder.
function contactFormConfig() { return (businessInfo && businessInfo.contactForm) || null; }
function optionalLabel(label) { return /optional/i.test(label) ? label : `${label} - Optional`; }
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
  $('additionalNotesLabel').textContent = optionalLabel(cfg.additionalNotes.label);
  $('additionalNotes').placeholder = cfg.additionalNotes.placeholder;
  if (!cfg.additionalNotes.show) state.contact.additionalNotes = '';
  const rate = (businessInfo && Number(businessInfo.shippingFlatRate)) || 0;
  $('shippingNote').textContent = `Local Pickup has no extra cost. Ground Shipping is ${rate > 0 ? `a flat ${money(rate)} per order` : 'free'}.`;
}
function hydrateContactForm() {
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
// 'change' as well as 'input': browser autofill does not always fire 'input'
['firstName', 'lastName', 'email', 'phone', 'businessName', 'neededByDate', 'additionalNotes'].forEach(id => {
  ['input', 'change'].forEach(type => $(id).addEventListener(type, (e) => { state.contact[id] = e.target.value; saveState(); }));
});
['shipLine1', 'shipLine2', 'shipCity', 'shipState', 'shipZip'].forEach(id => {
  const key = id.replace('ship', '').charAt(0).toLowerCase() + id.replace('ship', '').slice(1); // shipLine1 -> line1
  ['input', 'change'].forEach(type => $(id).addEventListener(type, (e) => {
    state.contact.shippingAddress = state.contact.shippingAddress || {};
    state.contact.shippingAddress[key] = e.target.value;
    saveState();
  }));
});
$('fulfillmentGroup').addEventListener('click', (e) => {
  const pill = e.target.closest('.radio-pill');
  if (!pill) return;
  state.contact.fulfillmentMethod = pill.dataset.value;
  hydrateContactForm();
  refreshPrice();
});

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
function contactNext() {
  const problem = contactProblem();
  if (problem) return showError(problem);
  goToStep(state.stepIndex + 1);
}
$('contactNextBtn').addEventListener('click', contactNext);
$('contactMobileNextBtn').addEventListener('click', contactNext);

// ---------------------------------------------------------------- confirm & checkout
// Saves the approved mockup, creates the order, and goes straight to
// payment: no second confirmation page in between. If anything after the
// order is created goes wrong, the customer lands on their order page
// (where they can still pay) instead of losing it.
async function submitOrder() {
  clearError();
  if (!price) return showError(priceError || 'Please finish choosing your size and quantity.');
  if (!artworkReady()) { goToNamed('artwork'); return showError('Please finish the artwork section first.'); }
  const problem = contactProblem();
  if (problem) { goToNamed('contact'); return showError(problem); }
  if (!confirmed) return showError('Please confirm your order details before checkout.');
  const c = state.contact;
  const btn = $('stepNextBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Starting checkout…';
  let quoteCode = null;
  try {
    try {
      const blob = await mockupBlob();
      if (blob) await uploadFile(new File([blob], 'approved-mockup.png', { type: 'image/png' }), 'Approved Mockup');
    } catch (err) { /* the order still goes through without the picture */ }

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
    quoteCode = result.quoteCode;
    if (window.track3T) window.track3T('quote_generated', { quoteCode });
    const discount = state.discountCode;
    clearSavedState();
    if (discount) await api(`/quotes/${quoteCode}/apply-discount`, { method: 'POST', body: { code: discount } });
    await api(`/quotes/${quoteCode}/checkout-started`, { method: 'POST', body: {} });
    if (window.track3T) window.track3T('checkout_started', { quoteCode });
    const checkout = await api(`/quotes/${quoteCode}/checkout`, { method: 'POST', body: { termsAccepted: true } });
    // window.top: payment pages refuse to load inside another site's frame
    window.top.location.href = checkout.checkoutUrl;
  } catch (err) {
    if (quoteCode) { window.location.href = `/quote.html?id=${encodeURIComponent(quoteCode)}`; return; }
    showError(err.message || 'Something went wrong starting checkout.');
    btn.textContent = 'Confirm & Checkout';
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- the price
let priceSeq = 0;
async function refreshPrice() {
  saveState();
  if (!product() || !state.qty || !sizeChosen()) { price = null; priceError = ''; updateSummary(); return; }
  const seq = ++priceSeq;
  try {
    const result = await api('/estimate', { method: 'POST', body: { printSelection: selectionPayload(), rush: !!state.rush, fulfillmentMethod: state.contact.fulfillmentMethod } });
    if (seq !== priceSeq) return; // a newer change is already being priced
    price = result; priceError = '';
  } catch (err) {
    if (seq !== priceSeq) return;
    price = null; priceError = err.message || "We couldn't update your price. Please try again.";
  }
  updateSummary();
  if (currentStep() === 'review') renderStep();
}
function updateSummary() {
  const host = $('summaryBody');
  const bar = $('mobileSummaryBar');
  const p = product();
  if (!p) { host.innerHTML = '<p class="summary-empty">Your order appears here as you build it.</p>'; bar.classList.add('hidden'); return; }
  const line = (l, r) => `<div class="summary-line"><span class="l">${l}</span><span class="r">${r}</span></div>`;
  let html = line('Product', esc(p.name));
  if ((p.sizes.length > 1 || state.customSize) && sizeText()) html += line('Size', esc(sizeText()));
  if (state.qty) html += line('Quantity', `${state.qty.toLocaleString('en-US')} ${esc(unitLabel(p, state.qty))}`);
  for (const g of p.options) if (g.choices.length > 1 && state.options[g.id]) html += line(esc(g.name), esc(choiceOf(g).name));
  if (price) {
    const e = est(), c = price.checkout;
    if (!hideUnit()) html += line('Price each', money(e.printOrder.unitPrice));
    html += line('Base price', money(e.baseLineTotal));
    for (const a of e.addonLines) html += line(esc(a.name), `+${money(a.total)}`);
    html += line('Subtotal', money(e.subtotal));
    if (c.rushFee > 0) html += line('Rush', `+${money(c.rushFee)}`);
    html += line('Shipping', c.shippingFee > 0 ? `+${money(c.shippingFee)}` : 'Local pickup, free');
    html += line('Estimated Tax', `+${money(c.taxAmount)}`);
    html += `<div class="summary-total"><span class="l">Estimated Total</span><span class="r">${money(c.grandTotal)}</span></div>`;
    $('mobileSummaryCount').textContent = `${e.totalQty.toLocaleString('en-US')} ${unitLabel(p, e.totalQty)}`;
    $('mobileSummaryTotal').textContent = money(c.grandTotal);
  } else if (priceError) {
    html += `<div class="summary-note" style="color:#ffb4a8;">${esc(priceError)}</div>`;
  }
  bar.classList.toggle('hidden', !price);
  host.innerHTML = html;
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
  // reopen where the customer left off (a refresh must not restart the order)
  clearError();
  renderStep();
  await refreshPrice();
}
init();
