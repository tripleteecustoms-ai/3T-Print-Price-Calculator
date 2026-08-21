// public/js/brand-header.js — shared across every customer-facing page.
// Pulls the current business name + logo from /api/business-info (Settings
// > Branding in the admin) and applies it to the standard
// header.site-header > .logo markup, so an admin-uploaded logo/name change
// shows up everywhere without editing each static HTML file. Falls back
// silently to whatever's already in the HTML (the "3T Print Solutions"
// wordmark) if the fetch fails for any reason — branding is cosmetic, never
// something that should be able to break page load.
(function () {
  fetch('/api/business-info').then(r => r.json()).then(info => {
    const name = info.businessName || '3T Print Solutions';
    const textEl = document.getElementById('siteLogoText');
    if (textEl) textEl.textContent = name.toUpperCase();
    if (document.title) document.title = document.title.replace(/3T Print Solutions/i, name);

    const dotEl = document.getElementById('siteLogoDot');
    if (info.logoUrl && dotEl) {
      const img = document.createElement('img');
      img.src = info.logoUrl;
      img.alt = name;
      img.style.cssText = 'height:28px;width:auto;max-width:120px;border-radius:4px;margin-right:6px;vertical-align:middle;object-fit:contain;';
      dotEl.replaceWith(img);
    }
  }).catch(() => { /* branding is cosmetic — never block page load on it */ });
})();
