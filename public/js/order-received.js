// public/js/order-received.js
const params = new URLSearchParams(location.search);
const quoteCode = params.get('id');

function money(n) { return '$' + Number(n).toFixed(2); }
function fmtDateTime(d) { return new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function detailItem(label, value) { return `<div class="detail-item"><div class="dl">${label}</div><div class="dv">${value}</div></div>`; }

async function load() {
  try {
    const resp = await fetch(`/api/quotes/${encodeURIComponent(quoteCode)}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    if (!data.quote.paidAt) {
      // not paid yet — send back to the quote page
      window.location.href = `/quote.html?id=${encodeURIComponent(quoteCode)}`;
      return;
    }

    document.getElementById('orderDetails').innerHTML = `
      ${detailItem('Order Number', '#' + quoteCode)}
      ${detailItem('Quote Number', '#' + quoteCode)}
      ${detailItem('Amount Paid', money(data.quote.amountPaid))}
      ${detailItem('Paid On', fmtDateTime(data.quote.paidAt))}
      ${detailItem('Fulfillment', data.quote.fulfillmentMethod === 'shipping' ? 'Shipping' : 'Local Pickup')}
      ${detailItem('Status', 'Paid — Pending Production Review')}
    `;

    document.getElementById('garmentSummary').innerHTML = `
      <div class="detail-grid">
        ${detailItem('Garment', data.garment.name)}
        ${detailItem('Quantity', data.pricing.totalQty)}
      </div>`;

    document.getElementById('artworkSummary').innerHTML = data.artwork.length
      ? data.artwork.map(f => `<div class="print-detail-row">
          <img src="${f.url}" onerror="this.style.display='none'">
          <div><div class="pd-name">${f.locationName || 'Artwork'}</div><div class="pd-file">${f.filename}</div></div>
        </div>`).join('')
      : '<p class="muted">No artwork uploaded.</p>';
  } catch (err) {
    document.querySelector('.quote-wrap').innerHTML = `<p class="text-center mt-24">${err.message || 'Could not load this order.'}</p>`;
  }
}
load();
