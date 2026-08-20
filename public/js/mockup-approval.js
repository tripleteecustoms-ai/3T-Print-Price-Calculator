// public/js/mockup-approval.js — no-login mockup approval page reached from
// the emailed approval link. The token in the URL IS the credential (same
// trust model as the quote_code links used elsewhere in this app).

const params = new URLSearchParams(location.search);
const token = params.get('token');
const initialAction = params.get('action'); // 'approve' lets the emailed "APPROVE MOCKUP" button one-click approve

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

function showError(message) {
  document.getElementById('loadingState').classList.add('hidden');
  document.getElementById('errorState').classList.remove('hidden');
  if (message) document.getElementById('errorMessage').textContent = message;
}

async function load() {
  if (!token) { showError('This link is missing its approval token.'); return; }
  try {
    const { mockup, quote } = await api(`/mockups/${encodeURIComponent(token)}`);
    render(mockup, quote);
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('mockupState').classList.remove('hidden');

    if (initialAction === 'approve' && mockup.status === 'pending_customer') {
      await approve();
    }
  } catch (err) {
    showError(err.message || 'This link is invalid or has expired.');
  }
}

function render(mockup, quote) {
  document.getElementById('quoteCode').textContent = '#' + quote.code;
  document.getElementById('garmentSummary').textContent = `${quote.totalQty} × ${quote.garmentName}`;
  document.getElementById('mockupImage').src = mockup.url;

  const badge = document.getElementById('statusBadge');
  if (mockup.status !== 'pending_customer') {
    badge.classList.remove('hidden');
    if (mockup.status === 'approved') { badge.textContent = 'Approved'; badge.className = 'badge badge-green'; }
    else { badge.textContent = 'Changes Requested'; badge.className = 'badge badge-amber'; }

    document.getElementById('respondCard').classList.add('hidden');
    document.getElementById('respondedCard').classList.remove('hidden');
    document.getElementById('respondedMessage').textContent = mockup.status === 'approved'
      ? "You've already approved this mockup — we're moving forward with production. Thank you!"
      : `You already requested changes on this mockup${mockup.customerNote ? `: "${mockup.customerNote}"` : '.'} We'll follow up shortly.`;
  }
}

async function approve() {
  const approveBtn = document.getElementById('approveBtn');
  if (approveBtn) { approveBtn.disabled = true; approveBtn.textContent = 'Approving…'; }
  try {
    await api(`/mockups/${encodeURIComponent(token)}/approve`, { method: 'POST', body: {} });
    document.getElementById('respondCard').classList.add('hidden');
    document.getElementById('respondedCard').classList.remove('hidden');
    document.getElementById('respondedMessage').textContent = "Thanks — you've approved this mockup and we're moving forward with production!";
    const badge = document.getElementById('statusBadge');
    badge.classList.remove('hidden');
    badge.textContent = 'Approved';
    badge.className = 'badge badge-green';
  } catch (err) {
    showToast(err.message || 'Could not approve the mockup.');
    if (approveBtn) { approveBtn.disabled = false; approveBtn.textContent = 'Approve Mockup'; }
  }
}

document.getElementById('approveBtn').addEventListener('click', approve);

document.getElementById('showChangesBtn').addEventListener('click', () => {
  document.getElementById('changesForm').classList.remove('hidden');
});

document.getElementById('submitChangesBtn').addEventListener('click', async () => {
  const btn = document.getElementById('submitChangesBtn');
  const note = document.getElementById('changesNote').value.trim();
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    await api(`/mockups/${encodeURIComponent(token)}/request-changes`, { method: 'POST', body: { note } });
    document.getElementById('respondCard').classList.add('hidden');
    document.getElementById('respondedCard').classList.remove('hidden');
    document.getElementById('respondedMessage').textContent = "Got it — we'll review your requested changes and follow up shortly.";
    const badge = document.getElementById('statusBadge');
    badge.classList.remove('hidden');
    badge.textContent = 'Changes Requested';
    badge.className = 'badge badge-amber';
  } catch (err) {
    showToast(err.message || 'Could not submit your changes.');
    btn.disabled = false;
    btn.textContent = 'Submit Change Request';
  }
});

load();
