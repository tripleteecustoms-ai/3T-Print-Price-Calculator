// public/admin/js/admin-workflow.js
// Loaded after admin.js (and uses its helpers: api, esc, showToast, openModal,
// closeModal, fmtDate, fmtDateTime, money, rememberArtwork).
//
//  - Artwork: a review queue. Status changes are STAGED; nothing is saved and
//    no customer is emailed until "Activate Updates" is pressed.
//  - Emails: every email sent, with the full message.
//  - User Access: customer logins (password reset / verification emails).
//  - Garment Mockups: the print area on each garment's photo.
//  - The mockups on an order, and the Artwork / Mockups / Emails / Account /
//    Activity tabs on a customer profile.
//  - Live updates: orders refresh by themselves when a payment or status
//    change arrives from Shopify, Square or a new order request.

// ============================================================ artwork queue
const ARTWORK_CHOICES = [['pending_review', 'Pending'], ['needs_changes', 'Needs Review'], ['approved', 'Approved'], ['declined', 'Declined']];
const ARTWORK_BADGE = { Pending: 'badge-gray', 'Needs Review': 'badge-amber', Approved: 'badge-green', Declined: 'badge-red' };
// Older statuses shown under the choice they belong to.
const artworkChoiceFor = (status) => status === 'customer_revision_requested' ? 'needs_changes' : status === 'production_ready' ? 'approved' : status;
const stagedArtwork = new Map(); // file id -> the status it will get when updates are activated
const artworkSavedStatus = new Map(); // file id -> its saved status, to tell a real change from switching back

function artworkStatusSelect(f) {
  artworkSavedStatus.set(Number(f.id), artworkChoiceFor(f.status));
  const current = stagedArtwork.get(Number(f.id)) || artworkChoiceFor(f.status);
  return `<select data-stage-art="${f.id}" aria-label="Status of ${esc(f.original_filename)}" style="font-size:12px;padding:4px;">
    ${ARTWORK_CHOICES.map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
}
function stageArtwork(id, status) {
  id = Number(id);
  if (artworkSavedStatus.get(id) === status) stagedArtwork.delete(id); else stagedArtwork.set(id, status);
  // keep every dropdown for this file (queue, open order) in step
  document.querySelectorAll(`[data-stage-art="${id}"]`).forEach(sel => { sel.value = status; const card = sel.closest('.art-card'); if (card) card.classList.toggle('is-staged', stagedArtwork.has(id)); });
  renderStagedBar();
}
function renderStagedBar() {
  const n = stagedArtwork.size;
  const label = n ? `${n} pending change${n === 1 ? '' : 's'}` : '';
  const count = document.getElementById('artworkStagedCount');
  if (count) count.textContent = label;
  const btn = document.getElementById('activateArtworkBtn');
  if (btn) btn.disabled = !n;
  const bar = document.getElementById('orderArtworkStageBar');
  if (bar) bar.innerHTML = n ? `<div class="warn-box" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <span style="flex:1;"><strong>${label}</strong>, not saved yet. The customer is emailed only when you activate.</span>
      <button type="button" class="btn btn-primary btn-sm" data-activate-art>Activate Updates</button></div>` : '';
}
async function activateArtworkUpdates() {
  if (!stagedArtwork.size) return;
  const changes = [...stagedArtwork].map(([id, status]) => ({ id, status }));
  document.querySelectorAll('#activateArtworkBtn,[data-activate-art]').forEach(b => { b.disabled = true; });
  try {
    const r = await api('/artwork/activate', { method: 'POST', body: { changes } });
    stagedArtwork.clear();
    showToast(`${r.saved} update${r.saved === 1 ? '' : 's'} saved. ${r.emailed} customer${r.emailed === 1 ? '' : 's'} emailed.${r.emailErrors.length ? ' Some emails failed: ' + r.emailErrors.join('; ') : ''}`);
    renderStagedBar();
    if (document.querySelector('.admin-panel.active[data-panel="artwork"]')) fetchArtwork();
    const host = document.getElementById('orderMockupsHost');
    if (host && !document.getElementById('modalHost').classList.contains('hidden')) openQuoteDetail(host.dataset.code);
  } catch (err) {
    showToast(err.message || 'Could not activate the updates.');
    renderStagedBar();
  }
}
async function deleteArtworkFile(id, after) {
  if (!confirm('Delete this submitted artwork?\n\nThe file is removed for good. This cannot be undone.')) return;
  try {
    await api(`/artwork/${id}`, { method: 'DELETE' });
    stagedArtwork.delete(Number(id));
    showToast('Artwork deleted.');
    renderStagedBar();
    if (after) after();
  } catch (err) { showToast(err.message || 'Could not delete this artwork.'); }
}

let artworkSearchTimer = null;
function loadArtwork() {
  document.getElementById('artworkFilter').onchange = fetchArtwork;
  document.getElementById('artworkSearch').oninput = () => { clearTimeout(artworkSearchTimer); artworkSearchTimer = setTimeout(fetchArtwork, 250); };
  document.getElementById('activateArtworkBtn').onclick = activateArtworkUpdates;
  fetchArtwork();
}
async function fetchArtwork() {
  const filter = document.getElementById('artworkFilter').value;
  const q = document.getElementById('artworkSearch').value.trim();
  const { artwork, counts } = await api(`/artwork?filter=${filter}${q ? '&q=' + encodeURIComponent(q) : ''}`);
  rememberArtwork(artwork);
  const select = document.getElementById('artworkFilter');
  const names = { active: 'All Active', pending: 'Pending', needs_review: 'Needs Review', declined: 'Declined', approved: 'Approved (history)' };
  [...select.options].forEach(o => { o.textContent = `${names[o.value]} (${counts[o.value]})`; });
  const nav = document.getElementById('navArtworkCount');
  if (nav) { nav.textContent = counts.active; nav.classList.toggle('hidden', !counts.active); }
  document.getElementById('artworkGrid').innerHTML = artwork.map(f => `
    <div class="option-card art-card ${stagedArtwork.has(Number(f.id)) ? 'is-staged' : ''}" style="cursor:default;">
      <button type="button" class="art-thumb-btn" data-view-art="${f.id}" title="View artwork" aria-label="View ${esc(f.original_filename)}">
        ${f.mime_type === 'application/pdf'
          ? `<div style="aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;border-radius:6px;background:#f3f4f6;font-weight:700;color:#6b7280;">PDF</div>`
          : `<img src="${f.url}" alt="" onerror="this.style.display='none'" style="aspect-ratio:1/1;object-fit:cover;border-radius:6px;width:100%;">`}
      </button>
      <div class="oc-title" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.original_filename)}</div>
      <div class="oc-sub"><a href="#" data-open-order="${esc(f.quote_code)}" style="font-weight:700;color:inherit;">#${esc(f.quote_code)}</a> · <a href="#" data-open-customer="${f.customer_id}" style="color:inherit;">${esc(f.first_name)} ${esc(f.last_name)}</a></div>
      <div class="oc-sub">${esc(f.location_name || '')} <span class="badge ${ARTWORK_BADGE[f.statusLabel] || 'badge-gray'}" style="margin-left:4px;">${esc(f.statusLabel)}</span></div>
      ${artworkStatusSelect(f)}
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
        <a class="btn btn-dark btn-sm" href="${f.downloadUrl}" style="text-align:center;">Download</a>
        <button type="button" class="btn btn-outline btn-sm" data-delete-art="${f.id}" style="color:var(--3t-red);border-color:var(--3t-red);">Delete File</button>
      </div>
    </div>`).join('') || `<p class="muted">${filter === 'approved' ? 'No approved artwork yet.' : 'Nothing waiting for review.'}</p>`;
  renderStagedBar();
}

// One handler for every artwork control, wherever it is drawn.
document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-stage-art]');
  if (sel) stageArtwork(sel.dataset.stageArt, sel.value);
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-activate-art]')) { activateArtworkUpdates(); return; }
  const del = e.target.closest('[data-delete-art]');
  if (del) {
    deleteArtworkFile(del.dataset.deleteArt, () => {
      const host = document.getElementById('orderMockupsHost');
      if (host && !document.getElementById('modalHost').classList.contains('hidden')) openQuoteDetail(host.dataset.code);
      else if (document.querySelector('.admin-panel.active[data-panel="artwork"]')) fetchArtwork();
    });
    return;
  }
  const order = e.target.closest('[data-open-order]');
  if (order) { e.preventDefault(); openQuoteDetail(order.dataset.openOrder); return; }
  const customer = e.target.closest('[data-open-customer]');
  if (customer && customer.dataset.openCustomer) { e.preventDefault(); openCustomerProfile(Number(customer.dataset.openCustomer)); return; }
  const email = e.target.closest('[data-view-email]');
  if (email) { e.preventDefault(); openEmailViewer(email.dataset.viewEmail); }
});
// Leaving the page with staged changes would silently drop them.
window.addEventListener('beforeunload', (e) => { if (stagedArtwork.size) { e.preventDefault(); e.returnValue = ''; } });

// ============================================================ mockups on an order
const WF_MOCKUP_LABEL = { pending_customer: 'Awaiting customer', approved: 'Approved', changes_requested: 'Changes requested' };
const WF_MOCKUP_BADGE = { pending_customer: 'badge-amber', approved: 'badge-green', changes_requested: 'badge-red' };
function mockupCards(list, { showOrder } = {}) {
  return list.map(m => `<div class="option-card" style="cursor:default;">
      <a href="${esc(m.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt="" onerror="this.style.display='none'" style="aspect-ratio:1/1;object-fit:contain;border-radius:6px;background:#f3f4f6;"></a>
      <div class="oc-title" style="font-size:12.5px;">${m.kind === 'approved_in_builder' ? esc(m.name) : 'Sent for approval'}</div>
      ${showOrder ? `<div class="oc-sub"><a href="#" data-open-order="${esc(m.quoteCode)}" style="color:inherit;font-weight:700;">#${esc(m.quoteCode)}</a></div>` : ''}
      <span class="badge ${WF_MOCKUP_BADGE[m.status] || 'badge-gray'}">${m.kind === 'approved_in_builder' ? 'Approved by customer' : (WF_MOCKUP_LABEL[m.status] || esc(m.status))}</span>
      ${m.customerNote ? `<div class="oc-sub mt-8" style="white-space:normal;"><strong>Note:</strong> ${esc(m.customerNote)}</div>` : ''}
      <div class="oc-sub">${fmtDateTime(m.at)}</div>
    </div>`).join('');
}
async function mountOrderWorkflow(code) {
  renderStagedBar();
  const host = document.getElementById('orderMockupsHost');
  if (!host) return;
  let mockups = [];
  try { ({ mockups } = await api(`/quotes/${encodeURIComponent(code)}/mockups`)); } catch (err) { host.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
  host.innerHTML = `
    ${mockups.length ? `<div class="option-grid">${mockupCards(mockups)}</div>` : '<p class="muted">No mockups on this order yet.</p>'}
    <div class="field-row mt-8" style="align-items:flex-end;">
      <div class="field mb-0"><label>Send a mockup for the customer to approve</label><input type="file" id="orderMockupFile" accept="image/png,image/jpeg,image/webp,image/svg+xml"></div>
      <button type="button" class="btn btn-dark btn-sm" id="orderMockupSend" style="height:fit-content;">Send for Approval</button>
    </div>`;
  document.getElementById('orderMockupSend').addEventListener('click', async (e) => {
    const file = document.getElementById('orderMockupFile').files[0];
    if (!file) { showToast('Choose an image to upload.'); return; }
    e.target.disabled = true;
    try {
      const fd = new FormData();
      fd.append('image', file);
      const result = await api(`/quotes/${encodeURIComponent(code)}/mockups`, { method: 'POST', body: fd });
      showToast(result.emailError ? `Mockup saved, but the email failed: ${result.emailError}` : 'Mockup sent to the customer for approval.');
      mountOrderWorkflow(code);
    } catch (err) { showToast(err.message || 'Could not send the mockup.'); e.target.disabled = false; }
  });
}

// ============================================================ customer profile tabs
async function mountCustomerFiles(customerId) {
  const host = document.getElementById('customerFilesHost');
  if (!host) return;
  let d;
  try { d = await api(`/customers/${customerId}/files`); } catch (err) { host.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
  rememberArtwork(d.artwork);
  const approved = d.artwork.filter(f => f.statusLabel === 'Approved');
  const a = d.account, p = a.profile || {};
  const addr = p.address && p.address.line1 ? `${esc(p.address.line1)}${p.address.line2 ? ', ' + esc(p.address.line2) : ''}, ${esc(p.address.city)}, ${esc(p.address.state)} ${esc(p.address.zip)}` : '';
  const item = (label, value) => value ? `<div class="detail-item"><div class="dl">${label}</div><div class="dv">${value}</div></div>` : '';
  const artCards = (list) => list.length ? `<div class="option-grid">${list.map(f => `<div class="option-card" style="cursor:default;">
      <button type="button" class="art-thumb-btn" data-view-art="${f.id}" aria-label="View ${esc(f.original_filename)}">${f.mime_type === 'application/pdf'
        ? '<div style="aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;border-radius:6px;background:#f3f4f6;font-weight:700;color:#6b7280;">PDF</div>'
        : `<img src="${f.url}" alt="" onerror="this.style.display='none'" style="aspect-ratio:1/1;object-fit:cover;border-radius:6px;width:100%;">`}</button>
      <div class="oc-title" style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.original_filename)}</div>
      <div class="oc-sub"><a href="#" data-open-order="${esc(f.quote_code)}" style="color:inherit;font-weight:700;">#${esc(f.quote_code)}</a> · ${esc(f.location_name || '')}</div>
      <span class="badge ${ARTWORK_BADGE[f.statusLabel] || 'badge-gray'}">${esc(f.statusLabel)}</span>
      <a class="btn btn-dark btn-sm" href="${f.downloadUrl}" style="margin-top:6px;text-align:center;">Download</a>
    </div>`).join('')}</div>` : '<p class="muted">Nothing here yet.</p>';
  const panels = {
    Artwork: () => artCards(d.artwork),
    Designs: () => `<p class="muted" style="font-size:13px;">Approved artwork, kept here after it leaves the Artwork queue.</p>` + artCards(approved),
    Mockups: () => d.mockups.length ? `<div class="option-grid">${mockupCards(d.mockups, { showOrder: true })}</div>` : '<p class="muted">No mockups yet.</p>',
    Emails: () => d.emails.length ? `<div class="admin-table-wrap"><table class="admin-table" style="min-width:480px;"><thead><tr><th>Subject</th><th>Order</th><th>Sent</th><th></th></tr></thead><tbody>${d.emails.map(e => `<tr>
        <td>${esc(e.subject)}</td><td>${e.quoteCode ? '#' + esc(e.quoteCode) : '—'}</td><td>${fmtDateTime(e.sentAt)}</td>
        <td><button type="button" class="btn btn-ghost btn-sm" data-view-email="${e.id}">View Email</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No emails sent to this customer yet.</p>',
    Account: () => `<div class="detail-grid">
        ${item('Login', a.hasAccount ? `${esc(a.email)} <span class="badge ${a.verified ? 'badge-green' : 'badge-amber'}">${a.verified ? 'Verified' : 'Not verified'}</span>` : 'No account (orders as a guest)')}
        ${a.hasAccount ? item('Account created', fmtDate(a.createdAt)) + item('Last login', a.lastLoginAt ? fmtDateTime(a.lastLoginAt) : 'Never') : ''}
        ${a.pendingEmail ? item('Waiting to verify', esc(a.pendingEmail)) : ''}
        ${item('Birthday', esc(p.birthday))}${item('Occupation / title', esc(p.occupation))}${item('Address', addr)}
        ${item('Marketing emails', p.marketingOptOut ? 'Unsubscribed' : 'Subscribed')}
      </div>
      ${p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" alt="Profile picture" style="width:72px;height:72px;border-radius:50%;object-fit:cover;margin-top:10px;">` : ''}
      ${p.bio ? `<div class="admin-card mt-8"><strong>Bio:</strong> ${esc(p.bio)}</div>` : ''}
      ${a.hasAccount ? `<div class="action-btn-row"><button type="button" class="btn btn-outline btn-sm" data-ua-one="reset" data-account="${a.accountId}">Send Password Reset</button>
        ${a.verified && !a.pendingEmail ? '' : `<button type="button" class="btn btn-outline btn-sm" data-ua-one="verification" data-account="${a.accountId}">Resend Verification</button>`}</div>` : ''}`,
    Activity: () => d.activity.length ? `<div style="max-height:320px;overflow-y:auto;font-size:12.5px;">${d.activity.map(ev => `<div style="padding:6px 0;border-top:1px solid var(--3t-border);">
        <span class="muted">${fmtDateTime(ev.created_at)}</span> · <a href="#" data-open-order="${esc(ev.quote_code)}" style="color:inherit;font-weight:700;">#${esc(ev.quote_code)}</a> · <strong>${esc(ev.event_type.replace(/_/g, ' '))}</strong>${ev.detail ? ' — ' + esc(ev.detail) : ''}</div>`).join('')}</div>` : '<p class="muted">No activity yet.</p>',
  };
  const counts = { Artwork: d.artwork.length, Designs: approved.length, Mockups: d.mockups.length, Emails: d.emails.length };
  let current = 'Artwork';
  const draw = () => {
    host.innerHTML = `<div class="wf-tabs" role="tablist">${Object.keys(panels).map(name =>
      `<button type="button" role="tab" data-wf-tab="${name}" class="${name === current ? 'active' : ''}">${name}${counts[name] != null ? ` (${counts[name]})` : ''}</button>`).join('')}</div>
      <div>${panels[current]()}</div>`;
    host.querySelectorAll('[data-wf-tab]').forEach(b => b.addEventListener('click', () => { current = b.dataset.wfTab; draw(); }));
    host.querySelectorAll('[data-ua-one]').forEach(b => b.addEventListener('click', () => sendUserAccess(b.dataset.uaOne, [Number(b.dataset.account)])));
  };
  draw();
}

// ============================================================ emails
let emailsSearchTimer = null;
function loadEmailsPanel() {
  document.getElementById('emailsSearch').oninput = () => { clearTimeout(emailsSearchTimer); emailsSearchTimer = setTimeout(fetchEmailsPanel, 250); };
  fetchEmailsPanel();
}
async function fetchEmailsPanel() {
  const q = document.getElementById('emailsSearch').value.trim();
  const { emails } = await api('/emails' + (q ? '?q=' + encodeURIComponent(q) : ''));
  document.getElementById('emailsPanelBody').innerHTML = emails.map(e => `<tr class="clickable" data-view-email="${e.id}">
      <td>${e.customerId ? `<a href="#" data-open-customer="${e.customerId}" style="color:inherit;font-weight:700;">${esc(e.customerName)}</a>` : '<span class="muted">—</span>'}</td>
      <td>${esc(e.to)}${e.copyTo ? `<div class="muted" style="font-size:11px;">copy to ${esc(e.copyTo)}</div>` : ''}</td>
      <td>${esc(e.subject)}</td>
      <td>${e.quoteCode ? `<a href="#" data-open-order="${esc(e.quoteCode)}" style="color:inherit;font-weight:700;">#${esc(e.quoteCode)}</a>` : '<span class="muted">—</span>'}</td>
      <td>${fmtDateTime(e.sentAt)}</td>
      <td><span class="badge ${e.status === 'Sent' ? 'badge-green' : 'badge-gray'}">${esc(e.status)}</span></td>
      <td><button type="button" class="btn btn-outline btn-sm" data-view-email="${e.id}">View Email</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No emails found.</td></tr>';
}
async function openEmailViewer(id) {
  let email;
  try { ({ email } = await api(`/emails/${id}`)); } catch (err) { showToast(err.message || 'Could not open this email.'); return; }
  const row = (label, value) => `<div class="detail-item"><div class="dl">${label}</div><div class="dv">${value}</div></div>`;
  openModal('Email', `
    <div class="detail-grid">
      ${row('To', esc(email.to) + (email.copyTo ? `<div class="muted" style="font-size:12px;">copy to ${esc(email.copyTo)}</div>` : ''))}
      ${row('Subject', esc(email.subject))}
      ${row('Sent', new Date(/T/.test(email.sentAt) ? email.sentAt : email.sentAt.replace(' ', 'T') + 'Z').toLocaleString('en-US'))}
      ${row('Status', esc(email.status))}
      ${row('Customer', email.customerId ? `<a href="#" data-open-customer="${email.customerId}">${esc(email.customerName)}</a>` : '—')}
      ${row('Order / quote', email.quoteCode ? `<a href="#" data-open-order="${esc(email.quoteCode)}">#${esc(email.quoteCode)}</a>` : '—')}
    </div>
    <h3 class="mt-16">Message</h3>
    <iframe class="email-frame" id="emailFrame" title="Email body" sandbox=""></iframe>`);
  // The message is shown in a sandboxed frame: it is displayed exactly as sent, and nothing in it can run.
  document.getElementById('emailFrame').srcdoc = email.bodyHtml;
}

// ============================================================ user access
const uaSelected = new Set();
let uaSearchTimer = null;
function loadUserAccess() {
  document.getElementById('userAccessSearch').oninput = () => { clearTimeout(uaSearchTimer); uaSearchTimer = setTimeout(fetchUserAccess, 250); };
  document.getElementById('uaSendReset').onclick = () => sendUserAccess('reset', [...uaSelected]);
  document.getElementById('uaSendVerify').onclick = () => sendUserAccess('verification', [...uaSelected]);
  document.getElementById('uaSelectAll').onchange = (e) => {
    document.querySelectorAll('#userAccessBody [data-ua-id]').forEach(box => { box.checked = e.target.checked; e.target.checked ? uaSelected.add(Number(box.dataset.uaId)) : uaSelected.delete(Number(box.dataset.uaId)); });
    syncUserAccessButtons();
  };
  fetchUserAccess();
}
function syncUserAccessButtons() {
  const n = uaSelected.size;
  document.getElementById('uaSendReset').disabled = document.getElementById('uaSendVerify').disabled = !n;
  document.getElementById('uaSelectedCount').textContent = n ? `${n} selected` : '';
}
async function fetchUserAccess() {
  const q = document.getElementById('userAccessSearch').value.trim();
  const { users } = await api('/user-access' + (q ? '?q=' + encodeURIComponent(q) : ''));
  document.getElementById('userAccessBody').innerHTML = users.map(u => `<tr>
      <td class="bulk-cell"><input type="checkbox" data-ua-id="${u.id}" ${uaSelected.has(u.id) ? 'checked' : ''} aria-label="Select ${esc(u.name)}"></td>
      <td><a href="#" data-open-customer="${u.customerId}" style="color:inherit;font-weight:700;">${esc(u.name)}</a></td>
      <td>${esc(u.businessName)}</td>
      <td>${esc(u.email)}${u.pendingEmail ? `<div class="muted" style="font-size:11px;">changing to ${esc(u.pendingEmail)}</div>` : ''}</td>
      <td><span class="badge ${u.verified ? 'badge-green' : 'badge-amber'}">${u.verified ? 'Verified' : 'Not verified'}</span></td>
      <td>${fmtDate(u.createdAt)}</td><td>${u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No customer has created an account yet.</td></tr>';
  document.querySelectorAll('#userAccessBody [data-ua-id]').forEach(box => box.addEventListener('change', () => {
    box.checked ? uaSelected.add(Number(box.dataset.uaId)) : uaSelected.delete(Number(box.dataset.uaId));
    syncUserAccessButtons();
  }));
  syncUserAccessButtons();
}
async function sendUserAccess(kind, accountIds) {
  if (!accountIds.length) return;
  const what = kind === 'reset' ? 'a password reset email' : 'a new verification email';
  if (!confirm(`Send ${what} to ${accountIds.length} user${accountIds.length === 1 ? '' : 's'}?`)) return;
  try {
    const r = await api('/user-access/send', { method: 'POST', body: { kind, accountIds } });
    showToast(`${r.sent} email${r.sent === 1 ? '' : 's'} sent.${r.skipped.length ? ` ${r.skipped.length} already verified.` : ''}`);
  } catch (err) { showToast(err.message || 'Could not send.'); }
}

// ============================================================ garment mockups
async function loadGarmentMockups() {
  const { garments } = await api('/garments');
  const grid = document.getElementById('garmentMockupsGrid');
  const photoOf = (g) => (g.colors.find(c => c.active && c.image_url) || g.colors.find(c => c.image_url) || {}).image_url || g.image_url || '';
  grid.innerHTML = garments.filter(g => !g.is_other).map(g => `<button type="button" class="option-card" data-gm-id="${g.id}">
      ${photoOf(g) ? `<img src="${esc(photoOf(g))}" alt="" onerror="this.style.display='none'">` : '<div style="aspect-ratio:1/1;border-radius:6px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;" class="muted">No photo</div>'}
      <div class="oc-title">${esc(g.name)}</div>
      <div class="oc-sub">${esc([g.brand, g.style_number].filter(Boolean).join(' '))}</div>
      <span class="badge ${g.mockup_json ? 'badge-green' : 'badge-gray'}">${g.mockup_json ? 'Custom print area' : 'Default print area'}</span>
    </button>`).join('') || '<p class="muted">No garments yet.</p>';
  grid.querySelectorAll('[data-gm-id]').forEach(card => card.addEventListener('click', () => openGarmentMockupEditor(garments.find(g => g.id === Number(card.dataset.gmId)), photoOf)));
}
function openGarmentMockupEditor(g, photoOf) {
  if (!window.Placement) { showToast('The placement editor did not load. Refresh and try again.'); return; }
  let config = {};
  try { config = g.mockup_json ? JSON.parse(g.mockup_json) : {}; } catch (e) { config = {}; }
  const photo = photoOf(g);
  const pct = (n) => n == null ? '' : Math.round(n * 1000) / 10;
  openModal(`${esc(g.name)}: print area`, `
    <div class="sub">Drag the dashed box to where the Standard print goes, and set its width. You can also type exact numbers. Everything is a percentage of the photo, so it stays right at any screen size. Larger sizes and chest prints follow this box, and its height follows the print size.</div>
    <div class="g-mockup-grid">
      ${['front', 'back'].map(view => `<div>
        <div class="g-mockup-title">${view === 'front' ? 'Front' : 'Back'}</div>
        <div id="gm-${view}"></div>
        <div class="field-row" style="grid-template-columns:repeat(3,1fr);margin-top:8px;">
          <div class="field mb-0"><label>X (center) %</label><input type="number" min="0" max="100" step="0.5" data-gm-num="${view}.cx"></div>
          <div class="field mb-0"><label>Y (top) %</label><input type="number" min="0" max="100" step="0.5" data-gm-num="${view}.top"></div>
          <div class="field mb-0"><label>Width %</label><input type="number" min="5" max="100" step="0.5" data-gm-num="${view}.w11"></div>
        </div>
      </div>`).join('')}
    </div>
    <div class="action-btn-row">
      <button type="button" class="btn btn-dark btn-sm" id="gmSave">Save Placement</button>
      <button type="button" class="btn btn-outline btn-sm" id="gmReset">Reset to Default</button>
    </div>`);
  const showNumbers = (view) => { for (const key of ['cx', 'top', 'w11']) { const input = document.querySelector(`[data-gm-num="${view}.${key}"]`); if (input && config[view]) input.value = pct(config[view][key]); } };
  const mount = (view) => {
    const host = document.getElementById('gm-' + view);
    const url = Placement.viewImageUrl(photo, view);
    if (!url) { host.innerHTML = '<p class="muted pl-note">No photo for this side. Link the garment to S&amp;S, or add a color photo, to set this.</p>'; return; }
    Placement.mountCalibrator(host, { imageUrl: url, view, config: config[view], onChange: (c) => { config[view] = c; showNumbers(view); } });
    showNumbers(view);
  };
  api('/settings/design-sizes').then(r => Placement.setSizes(r.designSizes)).catch(() => {}).then(() => { mount('front'); mount('back'); });
  document.querySelectorAll('[data-gm-num]').forEach(input => input.addEventListener('change', () => {
    const [view, key] = input.dataset.gmNum.split('.');
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    config[view] = { cx: 0.5, top: 0.25, w11: 0.3, ...(config[view] || {}), [key]: Math.min(1, Math.max(0, value / 100)) };
    mount(view);
  }));
  document.getElementById('gmSave').addEventListener('click', async () => {
    try {
      const r = await api(`/garments/${g.id}/mockup`, { method: 'PUT', body: { mockup: config } });
      g.mockup_json = r.mockup ? JSON.stringify(r.mockup) : null;
      showToast('Placement saved. New mockups use it right away.');
      closeModal();
      loadGarmentMockups();
    } catch (err) { showToast(err.message || 'Could not save the placement.'); }
  });
  document.getElementById('gmReset').addEventListener('click', () => { config = {}; document.querySelectorAll('[data-gm-num]').forEach(i => { i.value = ''; }); mount('front'); mount('back'); showToast('Defaults loaded. Click Save Placement to apply.'); });
}

// ============================================================ webhooks (Settings > Payment)
async function loadWebhookStatus() {
  if (!document.getElementById('whShopifyUrl')) return;
  try {
    const s = await api('/webhooks/status');
    document.getElementById('whShopifyUrl').value = s.shopify.url;
    document.getElementById('whSquareUrl').value = s.square.url;
    document.getElementById('whShopifyStatus').textContent = s.shopify.last ? `Last event from Shopify: ${s.shopify.last.topic}, ${fmtDateTime(s.shopify.last.received_at)}.` : 'No event received from Shopify yet.';
    document.getElementById('whSquareStatus').textContent = (s.square.keySaved ? 'Signature key saved. ' : 'No signature key saved yet. ')
      + (s.square.last ? `Last event from Square: ${s.square.last.topic}, ${fmtDateTime(s.square.last.received_at)}.` : 'No event received from Square yet.');
  } catch (e) { /* the card is informational */ }
}
document.getElementById('whShopifyRegister').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const r = await api('/webhooks/shopify/register', { method: 'POST', body: {} });
    const failed = r.results.filter(x => !x.ok);
    document.getElementById('whShopifyStatus').textContent = failed.length
      ? `Connected ${r.results.length - failed.length} of ${r.results.length}. Not connected: ${failed.map(x => `${x.topic} (${x.message})`).join('; ')}`
      : `Connected: Shopify will send ${r.results.length} kinds of events to this app.`;
  } catch (err) { showToast(err.message || 'Could not connect to Shopify.'); }
  e.target.disabled = false;
});
document.getElementById('whSquareSave').addEventListener('click', async () => {
  const key = document.getElementById('whSquareKey').value.trim();
  if (!key) { showToast('Paste the signature key first.'); return; }
  await api('/settings', { method: 'PUT', body: { square_webhook_signature_key: key, square_webhook_url: document.getElementById('whSquareUrl').value } });
  document.getElementById('whSquareKey').value = '';
  showToast('Square key saved.');
  loadWebhookStatus();
});
document.querySelectorAll('.tab-btn[data-tab="payment"]').forEach(btn => btn.addEventListener('click', loadWebhookStatus));

// ============================================================ live updates
// One stream from the server. When an order changes (a payment from Shopify
// or Square, a new order request), say so and refresh the list being shown.
(function connectLive() {
  if (!window.EventSource) return;
  const refreshers = { dashboard: loadDashboard, quotes: loadQuotes, orders: loadOrders, productionreview: loadProductionReview, customers: loadCustomers };
  const source = new EventSource('/api/admin/live');
  source.onmessage = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch (err) { return; }
    if (event.message) showToast(event.message);
    const active = document.querySelector('.admin-panel.active');
    const refresh = active && refreshers[active.dataset.panel];
    if (refresh) refresh();
    // An order that is open on screen is redrawn with its new status, unless something is being edited in it.
    const host = document.getElementById('orderMockupsHost');
    const modalOpen = !document.getElementById('modalHost').classList.contains('hidden');
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (host && modalOpen && host.dataset.code === event.orderNumber && !typing && !stagedArtwork.size) openQuoteDetail(event.orderNumber);
  };
})();

// The Artwork badge in the menu shows how much is waiting, from the first page load.
api('/artwork?filter=active').then(({ counts }) => {
  const nav = document.getElementById('navArtworkCount');
  if (nav) { nav.textContent = counts.active; nav.classList.toggle('hidden', !counts.active); }
}).catch(() => {});
