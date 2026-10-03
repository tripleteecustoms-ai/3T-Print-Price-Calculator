// public/js/account.js — the customer account page (/account): orders,
// quotes, saved designs and artwork, approved mockups, profile, and reorder.
// Everything shown comes from /api/account/dashboard for the signed-in
// customer only. Prices on a reorder are always worked out fresh by the server.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);
const fmtDate = (d) => d ? new Date(/T/.test(d) ? d : String(d).replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

let data = null;
let tab = 'current';

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const resp = await fetch('/api/account' + path, {
    method: opts.method || 'GET',
    headers: isForm || !opts.body ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (resp.status === 401) { location.href = '/login?next=/account'; throw new Error('Please log in.'); }
  if (!resp.ok) throw new Error(json.error || 'Something went wrong. Please try again.');
  return json;
}
function note(text, isError) {
  const el = $('acctNote');
  el.textContent = text || '';
  el.className = 'acct-note' + (isError ? ' err' : '') + (text ? '' : ' hidden');
  if (text) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const TABS = [
  ['current', 'Current Orders', d => d.currentOrders.length],
  ['past', 'Past Orders', d => d.pastOrders.length],
  ['quotes', 'Quotes', d => d.quotes.length],
  ['designs', 'Saved Designs', d => d.designs.length],
  ['artwork', 'Artwork', d => d.artwork.length],
  ['mockups', 'Approved Mockups', d => d.mockups.length],
  ['profile', 'Profile', null],
  ['account', 'Account', null],
];

function renderHead() {
  const p = data.profile;
  $('acctName').textContent = `${p.firstName} ${p.lastName}`.trim() || 'My Account';
  $('acctSub').textContent = [p.businessName, p.email].filter(Boolean).join(' · ');
  $('avatarHost').innerHTML = p.avatarUrl
    ? `<img class="acct-avatar" src="${esc(p.avatarUrl)}" alt="">`
    : `<div class="acct-avatar" aria-hidden="true">${esc(((p.firstName || '?')[0] + (p.lastName || '')[0]).toUpperCase())}</div>`;
  $('acctTabs').innerHTML = TABS.map(([key, label, count]) =>
    `<button type="button" role="tab" data-tab="${key}" aria-selected="${key === tab}">${label}${count ? `<span class="count">${count(data)}</span>` : ''}</button>`).join('');
}

function orderRows(list, empty, { quote } = {}) {
  if (!list.length) return `<p class="muted">${empty}</p>`;
  return list.map(o => `<div class="order-row">
    <div class="or-main">
      <div class="or-num">#${esc(o.orderNumber)} <span class="badge badge-gray" style="margin-left:6px;">${esc(o.statusText)}</span></div>
      <div class="or-sub">${o.quantity} × ${esc(o.item)} · ${money(o.total)} · ${fmtDate(o.paidAt || o.createdAt)}</div>
      ${o.balanceDue > 0 ? `<div class="or-sub"><strong>Balance due: ${money(o.balanceDue)}</strong></div>` : ''}
      ${o.reorderOf ? `<div class="or-sub">Reorder of #${esc(o.reorderOf)}</div>` : ''}
    </div>
    <div class="or-actions">
      <a class="btn btn-outline btn-sm" href="/quote.html?id=${encodeURIComponent(o.orderNumber)}">${quote ? 'View &amp; Pay' : 'View'}</a>
      ${o.canReorder ? `<button type="button" class="btn btn-dark btn-sm" data-reorder="${esc(o.orderNumber)}">Reorder</button>` : ''}
    </div>
  </div>`).join('');
}
function fileCards(list, empty, { designs } = {}) {
  if (!list.length) return `<p class="muted">${empty}</p>`;
  const badge = { approved: ['badge-green', 'Approved'], production_ready: ['badge-green', 'Approved'], declined: ['badge-red', 'Needs a revision'], needs_changes: ['badge-amber', 'Being reviewed'], customer_revision_requested: ['badge-amber', 'Being reviewed'], pending_review: ['badge-gray', 'Waiting for review'] };
  return `<div class="file-grid">${list.map((f, i) => {
    const [cls, label] = badge[f.status] || ['badge-gray', f.status];
    return `<div class="file-card">
      ${f.isImage ? `<a href="${esc(f.url)}" target="_blank" rel="noopener"><img src="${esc(f.url)}" alt="" loading="lazy"></a>` : `<a class="ph" href="${esc(f.url)}" target="_blank" rel="noopener">${esc((f.name.split('.').pop() || 'FILE').toUpperCase())}</a>`}
      <div class="fc-name" title="${esc(f.name)}">${designs ? `Design ${list.length - i}` : esc(f.label)}</div>
      <div><span class="badge ${cls}">${label}</span></div>
      <div class="muted">Used on order #${esc(f.orderNumber)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <a class="btn btn-outline btn-sm" href="${esc(f.url)}" target="_blank" rel="noopener">View</a>
        ${f.canReorder ? `<button type="button" class="btn btn-dark btn-sm" data-reorder="${esc(f.orderNumber)}">Reorder</button>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function profileForm() {
  const p = data.profile, a = p.address || {};
  const field = (id, label, value, attrs = '') => `<div class="field"><label for="${id}">${label}</label><input ${/type=/.test(attrs) ? '' : 'type="text"'} id="${id}" value="${esc(value)}" ${attrs}></div>`;
  return `<form id="profileForm" novalidate>
    <div class="field"><label>Profile picture or logo</label>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <input type="file" id="pictureInput" accept="image/png,image/jpeg,image/webp" style="max-width:260px;">
        <span class="muted" style="font-size:12px;">PNG, JPG or WEBP, up to 5 MB.</span>
      </div>
    </div>
    <div class="field-row">${field('pFirst', 'First name', p.firstName, 'autocomplete="given-name"')}${field('pLast', 'Last name', p.lastName, 'autocomplete="family-name"')}</div>
    <div class="field-row">${field('pEmail', 'Email', p.email, 'type="email" autocomplete="email"')}${field('pPhone', 'Phone', p.phone, 'type="tel" autocomplete="tel"')}</div>
    ${p.pendingEmail ? `<p class="muted" style="font-size:13px;margin-top:-8px;">Waiting for you to verify <strong>${esc(p.pendingEmail)}</strong>. Until then your login stays ${esc(p.email)}.</p>` : ''}
    <div class="field-row">${field('pBusiness', 'Business / company', p.businessName, 'autocomplete="organization"')}${field('pOccupation', 'Occupation / title', p.occupation, 'autocomplete="organization-title"')}</div>
    <div class="field-row">${field('pBirthday', 'Birthday', p.birthday, 'type="date" autocomplete="bday"')}<div></div></div>
    ${field('pLine1', 'Address', a.line1, 'autocomplete="address-line1" placeholder="Street address"')}
    ${field('pLine2', 'Apartment, suite, etc.', a.line2, 'autocomplete="address-line2"')}
    <div class="field-row">${field('pCity', 'City', a.city, 'autocomplete="address-level2"')}
      <div class="field-row">${field('pState', 'State', a.state, 'autocomplete="address-level1"')}${field('pZip', 'ZIP', a.zip, 'autocomplete="postal-code" inputmode="numeric"')}</div></div>
    <div class="field"><label for="pBio">Bio / description</label><textarea id="pBio" maxlength="1000">${esc(p.bio)}</textarea></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:16px;"><input type="checkbox" id="pOptOut" ${p.marketingOptOut ? 'checked' : ''} style="width:18px;height:18px;"> Do not send me marketing emails (order updates still come through)</label>
    <button type="submit" class="btn btn-primary">Save profile</button>
  </form>`;
}
function accountPanel() {
  const p = data.profile;
  return `<p><strong>Login email:</strong> ${esc(p.email)}<br><span class="muted" style="font-size:13px;">Member since ${fmtDate(p.memberSince)}. Change your email on the Profile tab; the new address has to be verified before it takes effect.</span></p>
    <h3 style="margin:18px 0 10px;">Change password</h3>
    <form id="passwordForm" novalidate style="max-width:380px;">
      <div class="field"><label for="curPw">Current password</label><input type="password" id="curPw" autocomplete="current-password"></div>
      <div class="field"><label for="newPw">New password</label><input type="password" id="newPw" autocomplete="new-password"><div class="muted" style="font-size:12px;margin-top:6px;">At least 8 characters.</div></div>
      <button type="submit" class="btn btn-dark">Update password</button>
    </form>`;
}

function renderBody() {
  const body = $('acctBody');
  const d = data;
  body.innerHTML = {
    current: () => orderRows(d.currentOrders, 'No orders in progress. <a href="/" style="color:inherit;font-weight:700;">Start one</a>.'),
    past: () => orderRows(d.pastOrders, 'Finished orders show up here.'),
    quotes: () => orderRows(d.quotes, 'Quotes you have not paid for yet show up here.', { quote: true }),
    designs: () => `<p class="muted" style="margin-top:0;">Artwork we approved for printing, ready to use again.</p>` + fileCards(d.designs, 'Once we approve artwork on one of your orders it is saved here.', { designs: true }),
    artwork: () => fileCards(d.artwork, 'Artwork you upload with an order is kept here.'),
    mockups: () => fileCards(d.mockups, 'Mockups you approve are kept here.'),
    profile: profileForm,
    account: accountPanel,
  }[tab]();

  if (tab === 'profile') {
    $('profileForm').addEventListener('submit', saveProfile);
    $('pictureInput').addEventListener('change', uploadPicture);
  }
  if (tab === 'account') $('passwordForm').addEventListener('submit', changePassword);
}

async function saveProfile(e) {
  e.preventDefault();
  const v = (id) => $(id).value;
  try {
    const result = await api('/profile', { method: 'PUT', body: {
      firstName: v('pFirst'), lastName: v('pLast'), email: v('pEmail'), phone: v('pPhone'), businessName: v('pBusiness'), occupation: v('pOccupation'),
      birthday: v('pBirthday'), bio: v('pBio'), marketingOptOut: $('pOptOut').checked,
      address: { line1: v('pLine1'), line2: v('pLine2'), city: v('pCity'), state: v('pState'), zip: v('pZip') },
    } });
    data.profile = result.profile;
    renderHead(); renderBody();
    note(result.emailChange ? `Saved. We sent a link to ${result.emailChange}: click it to finish changing your email.` : 'Profile saved.');
  } catch (err) { note(err.message, true); }
}
async function uploadPicture(e) {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  try {
    const { avatarUrl } = await api('/profile/picture', { method: 'POST', body: fd });
    data.profile.avatarUrl = avatarUrl;
    renderHead();
    note('Picture updated.');
  } catch (err) { note(err.message, true); }
}
async function changePassword(e) {
  e.preventDefault();
  try {
    await api('/change-password', { method: 'POST', body: { currentPassword: $('curPw').value, newPassword: $('newPw').value } });
    $('curPw').value = ''; $('newPw').value = '';
    note('Password updated.');
  } catch (err) { note(err.message, true); }
}

// ------------------------------------------------------------------ reorder
function closeModal() { $('modalHost').innerHTML = ''; }
function openReorder(orderNumber) {
  const order = [...data.currentOrders, ...data.pastOrders].find(o => o.orderNumber === orderNumber);
  $('modalHost').innerHTML = `<div class="acct-modal" role="dialog" aria-modal="true" aria-label="Reorder">
    <div class="box">
      <h2 style="margin-top:0;">Reorder #${esc(orderNumber)}</h2>
      <p class="muted">${order ? `${order.quantity} × ${esc(order.item)}` : ''}</p>
      <p style="font-size:14px;">This starts a <strong>new order</strong> with the same details. Your original order is not changed. The price is worked out at today's pricing, and you confirm it before paying.</p>
      <div id="reorderError" class="acct-note err hidden"></div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:14px;">
        <button type="button" class="btn btn-primary" id="reorderAsIs">Reorder As-Is</button>
        <button type="button" class="btn btn-outline" id="reorderChange">Make Changes</button>
        <button type="button" class="btn btn-ghost" id="reorderCancel">Cancel</button>
      </div>
    </div></div>`;
  $('reorderCancel').addEventListener('click', closeModal);
  $('modalHost').firstChild.addEventListener('click', (e) => { if (e.target.classList.contains('acct-modal')) closeModal(); });
  const fail = (err) => { const el = $('reorderError'); el.textContent = err.message; el.classList.remove('hidden'); $('reorderAsIs').disabled = $('reorderChange').disabled = false; };
  const start = async () => { $('reorderAsIs').disabled = $('reorderChange').disabled = true; return api(`/orders/${encodeURIComponent(orderNumber)}/reorder`, { method: 'POST', body: {} }); };

  $('reorderAsIs').addEventListener('click', async () => {
    try {
      const pkg = await start();
      // The same request the order form sends: the server prices it and creates the new order request.
      const resp = await fetch('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...pkg.payload, termsAccepted: true, reviewAgreed: true }) });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(/phone/i.test(json.error || '') ? 'Add a phone number on the Profile tab first, then reorder.' : (json.error || 'Could not start the reorder.'));
      location.href = `/quote.html?id=${encodeURIComponent(json.quoteCode)}`;
    } catch (err) { fail(err); }
  });
  $('reorderChange').addEventListener('click', async () => {
    try {
      const pkg = await start();
      if (pkg.kind === 'print') await openPrintBuilder(pkg); else await openApparelBuilder(pkg);
    } catch (err) { fail(err); }
  });
}

// "Make Changes": hand the order form a saved order in the shape it already
// restores from, then open it. The customer edits anything and submits as usual.
function contactFrom(p) {
  return {
    firstName: p.firstName || '', lastName: p.lastName || '', email: p.email || '', phone: p.phone || '', businessName: p.businessName || '',
    orderPurposes: p.orderPurpose ? String(p.orderPurpose).split(',').map(s => s.trim()).filter(Boolean) : [],
    neededByDate: '', additionalNotes: '', fulfillmentMethod: p.fulfillmentMethod || 'pickup',
    shippingAddress: p.shippingAddress || { line1: '', line2: '', city: '', state: '', zip: '' },
  };
}
async function openApparelBuilder(pkg) {
  const p = pkg.payload;
  const [{ garments }, { printLocations }] = await Promise.all([
    fetch('/api/garments').then(r => r.json()), fetch('/api/print-locations?qty=1').then(r => r.json()),
  ]);
  const garment = garments.find(g => g.id === p.garmentId);
  if (!garment) throw new Error('That garment is no longer offered. Start a new order to pick a similar one.');
  const selectedColors = [], sizesByColor = {};
  for (const sel of p.colorSelections || []) {
    const color = garment.colors.find(c => c.name === sel.colorName);
    if (!color) continue; // a color that is no longer offered is left for the customer to re-pick
    selectedColors.push({ id: color.id, name: color.name, hex: color.hex });
    sizesByColor[color.id] = Object.fromEntries(sel.sizes.filter(s => garment.sizes.some(g => g.label === s.label)).map(s => [s.label, s.qty]));
  }
  const codeOf = (id) => (printLocations.find(l => l.id === id) || {}).code;
  const uploads = {}, references = [];
  for (const f of pkg.artwork) {
    const record = { id: f.id, filename: f.filename, url: f.url, sizeBytes: f.sizeBytes, mimeType: f.mimeType };
    if (f.locationName === 'Reference') { references.push(record); continue; }
    const code = codeOf(f.printLocationId);
    if (code) (uploads[code] = uploads[code] || []).push(record);
  }
  const state = {
    stepIndex: 0, draftToken: p.draftToken, reorderOf: p.reorderOf,
    // the form restores a saved order as-is, so every field it expects is here
    garments: [], printLocations, estimate: null, businessInfo: null, quantityTiers: [],
    selectedGarmentId: garment.id, garmentSizes: garment.sizes, selectedColors, sizesByColor,
    selectedLocationIds: (p.printLocationIds || []).map(l => l.id).filter(id => printLocations.some(x => x.id === id)),
    designSizes: Object.fromEntries((p.printLocationIds || []).map(l => [codeOf(l.id), l.designSize]).filter(([code]) => code)),
    decoration: p.decoration || 'dtf',
    uploads, references,
    placements: Object.fromEntries((p.placements || []).map(pl => [pl.locationCode, pl])),
    designNotes: p.designNotes || '', artworkPending: !Object.keys(uploads).length, artworkTermsAccepted: false,
    customGarmentDescription: p.customGarmentDescription || '', customerSuppliedGarment: !!p.customerSuppliedGarment,
    rush: false, contact: contactFrom(p), savedAt: Date.now(),
  };
  localStorage.setItem('3t_builder_state', JSON.stringify(state));
  location.href = '/index.html';
}
async function openPrintBuilder(pkg) {
  const p = pkg.payload, sel = p.printSelection;
  const side = (name) => pkg.artwork.find(f => new RegExp(`${name}$`, 'i').test(f.locationName || ''));
  const items = (Array.isArray(sel.items) && sel.items.length ? sel.items : [sel]).map(it => ({
    productId: it.productId, sizeId: it.sizeId || null, customSize: it.customSize || null, customOpen: !!it.customSize,
    qty: it.qty, qtyOther: false, options: it.options || {}, addonIds: it.addonIds || [],
    design: it.design || { method: 'upload', logo: 'upload', templateId: null, brief: {} },
    // Artwork is added again in the form, so the preview and placement are rebuilt from the file itself.
    uploads: { front: null, back: null, logo: null, reference: [] },
    orientation: it.orientation || null, border: it.border != null ? it.border : 0.05, backArtwork: it.backArtwork || 'same',
    placements: {}, includeMisprints: !!it.includeMisprints, designNotes: it.designNotes || '',
  }));
  void side;
  const state = { stepIndex: 0, draftToken: null, reorderOf: p.reorderOf, items, active: 0, insurance: sel.insurance !== false, discountCode: '', rush: false, contact: contactFrom(p), savedAt: Date.now() };
  localStorage.setItem('3t_print_v5_' + pkg.family, JSON.stringify(state));
  location.href = '/print.html?type=' + encodeURIComponent(pkg.family);
}

// ------------------------------------------------------------------ wiring
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { tab = tabBtn.dataset.tab; note(''); renderHead(); renderBody(); return; }
  const reorder = e.target.closest('[data-reorder]');
  if (reorder) openReorder(reorder.dataset.reorder);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('logoutLink').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/account/logout', { method: 'POST' });
  location.href = '/login';
});

(async function init() {
  try {
    data = await api('/dashboard');
  } catch (err) { $('acctBody').innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
  if (!data.currentOrders.length && data.quotes.length) tab = 'quotes';
  renderHead();
  renderBody();
  if (new URLSearchParams(location.search).get('verified') === '1') note('Your email is verified. Welcome!');
})();
