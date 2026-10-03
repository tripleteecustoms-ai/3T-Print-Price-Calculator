// public/admin/js/order-ticket.js — the job ticket for one order
// (/admin/orders/<number>). Four views of the same data:
//   quote        the order exactly as approved: specs, sizes, prices, files
//   edit         the same, with the production notes, due date and file slots editable
//   mockups      every mockup, by item and print location
//   print-ready  every print-ready file, with upload / replace / download
// Each print slot shows three separate things: the customer's artwork (never
// changed here), the mockup, and the print-ready file.

const params = new URLSearchParams(location.search);
const CODE = params.get('code') || '';
let view = ['quote', 'edit', 'mockups', 'print-ready'].includes(params.get('view')) ? params.get('view') : 'quote';
let ticket = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);
const when = (d) => { if (!d) return ''; const s = String(d); const t = new Date(/T/.test(s) ? s : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s.replace(' ', 'T') + 'Z'); return Number.isNaN(t.getTime()) ? s : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
const bytes = (n) => !n ? '' : n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#303030;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:200;max-width:90vw;';
  $('toastHost').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const resp = await fetch('/api/admin' + path, { method: opts.method || 'GET', headers: isForm || !opts.body ? undefined : { 'Content-Type': 'application/json' }, body: isForm ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined });
  if (resp.status === 401) { location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Please log in.'); }
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

// ------------------------------------------------------------------ pieces
const IMAGE = /^image\/(png|jpe?g|svg\+xml|webp)$/;
function fileCard(ref, { extra = '', removable = false } = {}) {
  const ext = (ref.name.split('.').pop() || 'file').toUpperCase();
  const thumb = IMAGE.test(ref.mime || '')
    ? `<a href="${esc(ref.viewUrl)}" target="_blank" rel="noopener"><img class="jt-thumb" src="${esc(ref.previewUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;jt-thumb ph&quot;>${esc(ext)}</span>'"></a>`
    : `<a class="jt-thumb ph" href="${esc(ref.viewUrl)}" target="_blank" rel="noopener">${esc(ext)}</a>`;
  return `<div class="jt-file">${thumb}
    <div class="jt-name">${esc(ref.name)}</div>
    <div class="jt-meta">${[extra, bytes(ref.sizeBytes), ref.uploadedBy ? 'by ' + esc(ref.uploadedBy) : '', when(ref.uploadedAt)].filter(Boolean).join(' · ')}</div>
    <div class="jt-file-actions">
      <a class="btn btn-outline btn-sm" href="${esc(ref.viewUrl)}" target="_blank" rel="noopener">View</a>
      <a class="btn btn-outline btn-sm" href="${esc(ref.viewUrl)}?download=1">Download</a>
      ${removable && ref.removable ? `<button type="button" class="btn btn-ghost btn-sm" data-remove-asset="${ref.id}" data-name="${esc(ref.name)}" style="color:#c5280c;">Remove</button>` : ''}
    </div></div>`;
}
const ART_BADGE = { approved: ['badge-green', 'Approved'], production_ready: ['badge-green', 'Approved'], declined: ['badge-red', 'Declined'], needs_changes: ['badge-amber', 'Needs review'], customer_revision_requested: ['badge-amber', 'Needs review'], pending_review: ['badge-gray', 'Pending'] };
const uploader = (slot, kind, label) => `<label class="btn btn-dark btn-sm" style="cursor:pointer;">${label}<input type="file" hidden data-upload-slot="${esc(slot.key)}" data-kind="${kind}"
  accept="${kind === 'print_ready' ? '.png,.jpg,.jpeg,.svg,.pdf,.tif,.tiff,.psd,.ai,.eps,.webp' : '.png,.jpg,.jpeg,.webp,.pdf,.svg'}"></label>`;

function slotHtml(slot, { editable, only }) {
  const artwork = `<div class="jt-col"><div class="jt-col-title">Customer artwork</div>
      ${slot.customerArtwork.map(f => { const [cls, label] = ART_BADGE[f.status] || ['badge-gray', f.status]; return fileCard(f, { extra: `<span class="badge ${cls}">${label}</span>` }); }).join('') || '<p class="jt-empty">The customer did not upload a file for this location.</p>'}
      <p class="jt-empty" style="font-size:11.5px;">The original file. It is never changed.</p></div>`;
  const mockups = `<div class="jt-col"><div class="jt-col-title">Mockup</div>
      ${slot.mockups.map(m => fileCard(m, { extra: esc(m.sourceLabel || ''), removable: editable })).join('') || '<p class="jt-empty">No mockup yet.</p>'}
      ${editable ? uploader(slot, 'mockup', slot.mockups.some(m => m.source === 'admin') ? 'Replace shop mockup' : 'Upload a mockup') : ''}</div>`;
  const ready = `<div class="jt-col ${slot.printReady ? 'ready' : 'missing'}"><div class="jt-col-title">Print ready file</div>
      ${slot.printReady ? fileCard(slot.printReady, { extra: '<span class="badge badge-green">Print ready</span>', removable: editable }) : '<p class="jt-empty"><strong>Not uploaded yet.</strong> This is the file that goes to the printer.</p>'}
      ${editable ? uploader(slot, 'print_ready', slot.printReady ? 'Replace print ready file' : 'Upload print ready file') : ''}</div>`;
  const cols = only === 'mockups' ? mockups : only === 'print-ready' ? ready : artwork + mockups + ready;
  return `<div class="jt-slot">
    <div class="jt-slot-head"><h4>${esc(slot.label)}</h4><span class="muted" style="font-size:12.5px;">${esc(slot.dimensions || '')}</span></div>
    <div class="${only ? '' : 'jt-cols'}" ${only ? 'style="max-width:420px;"' : ''}>${cols}</div>
    ${only ? '' : editable
      ? `<div style="margin-top:10px;"><label class="jt-field"><span class="l">Production note for this location</span><textarea class="jt-note" data-slot-note="${esc(slot.key)}" placeholder="Optional">${esc(slot.note)}</textarea></label></div>`
      : slot.note ? `<p style="font-size:13px;margin:10px 0 0;"><strong>Production note:</strong> ${esc(slot.note)}</p>` : ''}
  </div>`;
}
const field = (label, value) => value ? `<div class="jt-field"><div class="l">${label}</div><div class="v">${value}</div></div>` : '';

// ------------------------------------------------------------------ the page
function render() {
  const t = ticket;
  document.title = `${t.orderNumber ? 'Order ' + t.orderNumber + ' · ' : ''}${t.quoteCode} — Job Ticket`;
  $('jtTitle').textContent = `${t.orderNumber ? 'Order ' + t.orderNumber + ' · ' : ''}Quote ${t.quoteCode}`;
  $('jtRevision').textContent = `Revision ${t.revision}`;
  const nav = (key, label, href) => `<a class="btn btn-outline btn-sm ${view === key ? 'current' : ''}" href="${href}" data-view="${key}">${label}</a>`;
  $('jtActions').innerHTML = nav('quote', 'View Quote', t.links.viewQuote) + nav('edit', 'Edit Quote', t.links.editQuote) + nav('mockups', 'View Mockups', t.links.mockups) + nav('print-ready', 'Print Ready Files', t.links.printReady)
    + `<a class="btn btn-dark btn-sm" href="${t.links.productionPdf}" target="_blank" rel="noopener">Production PDF</a>
       <a class="btn btn-dark btn-sm" href="${t.links.allFiles}">Download All Files</a>`;

  const p = t.production;
  const editable = view === 'edit' || view === 'print-ready' || view === 'mockups';
  const head = `<div class="admin-card">
      <div class="jt-grid">
        ${field('Customer', esc(t.customer.name) + (t.customer.business ? `<div class="muted" style="font-weight:400;font-size:12.5px;">${esc(t.customer.business)}</div>` : ''))}
        ${field('Phone / email', `${esc(t.customer.phone || '')}\n${esc(t.customer.email || '')}`)}
        ${field('Order date', when(t.orderDate))}
        ${field('Due date', t.dueDate ? when(t.dueDate) : 'None given')}
        ${field('Pickup / shipping', esc(t.fulfillment))}
        ${field('Rush', t.rush ? '<span class="badge badge-amber">Rush order</span>' : 'No')}
        ${field('Payment', esc(t.paymentStatus))}
        ${field('Order status', esc(t.orderStatus.replace(/_/g, ' ')))}
      </div>
      <div class="jt-stages" aria-label="Production status: ${esc(p.label)}">${p.stages.map((s, i) => `<span class="jt-stage ${i < p.index ? 'done' : i === p.index ? 'now' : ''}">${esc(i === p.index ? p.label : s)}</span>`).join('')}</div>
      <div class="muted" style="font-size:12.5px;margin-top:8px;">${p.printReadyCount} of ${p.slotCount} print location${p.slotCount === 1 ? '' : 's'} have a print ready file.
        ${p.declinedArtwork ? `<strong style="color:#c5280c;">${p.declinedArtwork} artwork file${p.declinedArtwork === 1 ? ' is' : 's are'} declined and waiting on the customer.</strong>` : ''}</div>
    </div>`;

  const items = t.items.map((item, i) => `<div class="admin-card">
      <h3>${t.items.length > 1 ? `Item ${i + 1} of ${t.items.length}: ` : ''}${esc(item.label)}</h3>
      ${view === 'mockups' || view === 'print-ready' ? '' : `<div class="jt-grid" style="margin-bottom:6px;">
        ${field('Product / garment', esc(item.product || item.label))}
        ${field('Brand / style', esc(item.brandStyle))}
        ${field('Color', esc(item.colors.join(', ')))}
        ${field('Quantity', `${item.quantity} ${esc(item.unit)}${item.quantity === 1 ? '' : 's'}`)}
        ${field('Size breakdown', esc(item.sizeBreakdown))}
        ${field('Print method', esc(item.printMethod))}
      </div>
      ${item.details.length ? `<p class="muted" style="font-size:13px;margin:6px 0 0;">${item.details.map(esc).join(' · ')}</p>` : ''}
      ${item.designBrief ? `<p style="font-size:13px;margin:8px 0 0;"><strong>Design brief:</strong> ${Object.entries(item.designBrief).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</p>` : ''}`}
      ${item.slots.map(slot => slotHtml(slot, { editable, only: view === 'mockups' ? 'mockups' : view === 'print-ready' ? 'print-ready' : null })).join('')}
    </div>`).join('');

  const orderMockups = t.orderMockups.length && view !== 'print-ready' ? `<div class="admin-card"><h3>Mockups sent to the customer for approval</h3>
      <div class="jt-cols">${t.orderMockups.map(m => `<div>${fileCard(m, { extra: esc(m.sourceLabel) + (m.customerNote ? ` · "${esc(m.customerNote)}"` : '') })}</div>`).join('')}</div></div>` : '';
  const references = t.references.length && (view === 'quote' || view === 'edit') ? `<div class="admin-card"><h3>Reference images from the customer</h3>
      <div class="jt-cols">${t.references.map(f => `<div>${fileCard(f)}</div>`).join('')}</div></div>` : '';

  const notesView = `<div class="admin-card"><h3>Notes</h3><div class="jt-grid">
      ${field('Production notes (shop)', esc(t.productionNotes) || '<span class="muted" style="font-weight:400;">None</span>')}
      ${field('Customer notes', esc(t.customerNotes))}${field('Design notes', esc(t.designNotes))}${field('Order is for', esc(t.orderPurpose))}${field('Reorder of', t.reorderOf ? `<a href="/admin/orders/${esc(t.reorderOf)}">#${esc(t.reorderOf)}</a>` : '')}
    </div></div>`;
  const notesEdit = `<div class="admin-card"><h3>Production details</h3>
      <div class="field-row">
        <div class="field"><label for="jtDue">Due date</label><input type="date" id="jtDue" value="${esc(t.dueDate)}"></div>
        <div class="field"><label>Order status, price and payment</label><a class="btn btn-outline btn-sm" href="/admin/dashboard.html#order=${esc(t.quoteCode)}">Open the full order controls</a></div>
      </div>
      <div class="field"><label for="jtNotes">Production notes (shop only; shown on the Production PDF)</label><textarea id="jtNotes" style="min-height:90px;">${esc(t.productionNotes)}</textarea></div>
      ${t.customerNotes ? `<p style="font-size:13px;"><strong>Customer notes:</strong> ${esc(t.customerNotes)}</p>` : ''}${t.designNotes ? `<p style="font-size:13px;"><strong>Design notes:</strong> ${esc(t.designNotes)}</p>` : ''}
      <button type="button" class="btn btn-dark btn-sm" id="jtSave">Save production details</button>
      <span class="muted" style="font-size:12.5px;margin-left:8px;">Saving raises the revision number.</span>
    </div>`;

  const pr = t.pricing;
  const priceRow = (label, amount, cls = '') => `<tr class="${cls}"><td>${label}</td><td>${amount}</td></tr>`;
  const pricing = view !== 'quote' ? '' : `<div class="admin-card" style="max-width:520px;"><h3>Pricing as approved</h3><table class="jt-price" style="width:100%;border-collapse:collapse;"><tbody>
      ${priceRow(`Items${pr.unit != null ? ` (${money(pr.unit)} each)` : ''}`, money(pr.base))}
      ${pr.lines.map(l => priceRow(esc(l.name), money(l.total))).join('')}
      ${pr.sizeSurcharges > 0 ? priceRow('Size adjustments', money(pr.sizeSurcharges)) : ''}
      ${pr.designSize.map(l => priceRow(esc(l.name), money(l.total))).join('')}
      ${pr.discount ? priceRow(`Discount (${esc(pr.discount.code)})`, '-' + money(pr.discount.amount)) : ''}
      ${priceRow('Order total', money(pr.orderTotal), 'total')}
      ${pr.rushFee > 0 ? priceRow('Rush fee', money(pr.rushFee)) : ''}
      ${priceRow('Sales tax', money(pr.tax))}
      ${pr.shipping > 0 ? priceRow('Shipping', money(pr.shipping)) : ''}
      ${priceRow('Grand total', money(pr.grandTotal), 'total')}
    </tbody></table>
    <p class="muted" style="font-size:12.5px;margin:10px 0 0;"><a href="${esc(t.links.customerQuotePage)}" target="_blank" rel="noopener">Open the page the customer sees</a></p></div>`;

  $('jtBody').innerHTML = head
    + (view === 'edit' ? notesEdit : '')
    + items + orderMockups + references
    + (view === 'quote' ? notesView + pricing : '');

  if (view === 'edit') $('jtSave').addEventListener('click', saveDetails);
}

async function saveDetails() {
  const slotNotes = Object.fromEntries([...document.querySelectorAll('[data-slot-note]')].map(el => [el.dataset.slotNote, el.value]));
  try {
    ticket = await api(`/orders/${encodeURIComponent(CODE)}/production`, { method: 'PUT', body: { productionNotes: $('jtNotes').value, dueDate: $('jtDue').value, slotNotes } });
    render();
    toast(`Saved. Now revision ${ticket.revision}.`);
  } catch (err) { toast(err.message); }
}

document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-upload-slot]');
  if (!input || !input.files[0]) return;
  const file = input.files[0];
  const kind = input.dataset.kind;
  const fd = new FormData();
  fd.append('slot', input.dataset.uploadSlot);
  fd.append('kind', kind);
  fd.append('file', file);
  toast(`Uploading ${file.name}…`);
  try {
    ticket = await api(`/orders/${encodeURIComponent(CODE)}/assets`, { method: 'POST', body: fd });
    render();
    toast(`${kind === 'print_ready' ? 'Print ready file' : 'Mockup'} saved. Now revision ${ticket.revision}.`);
  } catch (err) { toast(err.message); input.value = ''; }
});
document.addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove-asset]');
  if (remove) {
    if (!confirm(`Remove "${remove.dataset.name}" from this order?\n\nThe customer's original artwork is not affected.`)) return;
    try { ticket = await api(`/production/assets/${remove.dataset.removeAsset}`, { method: 'DELETE' }); render(); toast('Removed.'); } catch (err) { toast(err.message); }
    return;
  }
  // the four views switch in place (the address still changes, so each has its own link)
  const tab = e.target.closest('[data-view]');
  if (tab && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    view = tab.dataset.view;
    history.replaceState(null, '', `/admin/order.html?code=${encodeURIComponent(CODE)}&view=${view}`);
    render();
    window.scrollTo(0, 0);
  }
});

(async function init() {
  if (!CODE) { $('jtBody').innerHTML = '<p class="muted">No order was given.</p>'; return; }
  try { ticket = await api(`/orders/${encodeURIComponent(CODE)}/production`); render(); }
  catch (err) { $('jtBody').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
})();
