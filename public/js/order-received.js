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
      ${data.quote.balanceDue > 0 ? detailItem('Balance Due', `${money(data.quote.balanceDue)} before ${data.quote.fulfillmentMethod === 'shipping' ? 'shipping' : 'pickup'}`) : ''}
      ${detailItem('Paid On', fmtDateTime(data.quote.paidAt))}
      ${detailItem('Fulfillment', data.quote.fulfillmentMethod === 'shipping' ? 'Shipping' : 'Local Pickup')}
      ${detailItem('Status', data.quote.balanceDue > 0 ? 'Deposit Paid: Pending Production Review' : 'Paid: Pending Production Review')}
    `;

    // Sticker / poster / mylar orders show the product and size instead of a garment.
    const printOrder = data.pricing.printOrder;
    if (printOrder) {
      document.getElementById('garmentSummary').previousElementSibling.textContent = 'Product';
      document.querySelector('.site-header .tagline').textContent = printOrder.familyName;
    }
    document.getElementById('garmentSummary').innerHTML = `
      <div class="detail-grid">
        ${printOrder && printOrder.items
          ? printOrder.items.map(it => detailItem(it.label, `${it.productName}, quantity ${it.qty}${(it.options || []).filter(o => o.total > 0).map(o => `, ${o.choice}`).join('')}`)).join('')
          : printOrder ? detailItem('Product', printOrder.productName) + detailItem('Size', printOrder.sizeLabel) : detailItem('Garment', data.garment.name)}
        ${detailItem('Quantity', data.pricing.totalQty)}
        ${printOrder && !printOrder.items ? (printOrder.options || []).map(o => detailItem(o.group, o.choice)).join('') : ''}
        ${printOrder && printOrder.design ? detailItem('Design', printOrder.design.methodLabel) : ''}
        ${printOrder && printOrder.addons.length ? detailItem('Add-ons', printOrder.addons.map(a => a.name).join(', ')) : ''}
      </div>`;

    document.getElementById('artworkSummary').innerHTML = data.artwork.length
      ? data.artwork.map(f => `<div class="print-detail-row">
          <img src="${f.url}" onerror="this.style.display='none'">
          <div><div class="pd-name">${f.locationName || 'Artwork'}</div><div class="pd-file">${/Approved Mockup$/.test(f.locationName || '')
            ? `<a href="${f.url}" target="_blank" rel="noopener" style="color:inherit;">View Approved Mockup</a>` : f.filename}</div></div>
        </div>`).join('')
      : '<p class="muted">No artwork uploaded.</p>';
  } catch (err) {
    document.querySelector('.quote-wrap').innerHTML = `<p class="text-center mt-24">${err.message || 'Could not load this order.'}</p>`;
  }
}
load();
