// public/js/analytics.js — lightweight first-party visit/funnel tracking.
// No PII: just an anonymous visitor id, page/step visits, and UTM params
// off the URL. Include this script on any customer-facing page; it exposes
// window.track3T(eventType, extra) for page-specific event calls and fires
// a page_view automatically on load.

(function () {
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function getOrSet(storage, key, factory) {
    try {
      let v = storage.getItem(key);
      if (!v) { v = factory(); storage.setItem(key, v); }
      return v;
    } catch (e) { return factory(); } // storage unavailable (private browsing, etc.) — degrade gracefully
  }

  const visitorId = getOrSet(window.localStorage, '3t_visitor_id', uuid);
  const sessionId = getOrSet(window.sessionStorage, '3t_session_id', uuid);

  // Capture UTM params the first time they appear in a visit and persist them
  // for the rest of the session, so a later page (e.g. quote.html, reached
  // after the ad-linked landing page) still attributes back to the same source.
  const params = new URLSearchParams(location.search);
  const utmKeys = ['source', 'medium', 'campaign', 'term', 'content'];
  let utm = {};
  try { utm = JSON.parse(sessionStorage.getItem('3t_utm') || '{}'); } catch (e) {}
  let utmChanged = false;
  utmKeys.forEach(k => {
    const v = params.get('utm_' + k);
    if (v) { utm[k] = v; utmChanged = true; }
  });
  if (utmChanged) {
    try { sessionStorage.setItem('3t_utm', JSON.stringify(utm)); } catch (e) {}
  }

  function track3T(eventType, extra) {
    const body = Object.assign({
      visitorId, sessionId, eventType,
      path: location.pathname,
      utm, referrer: document.referrer || null,
    }, extra || {});
    try {
      fetch('/api/analytics/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), keepalive: true,
      }).catch(() => {}); // never let analytics failures affect the customer experience
    } catch (e) { /* ignore */ }
  }

  window.track3T = track3T;
  track3T('page_view');
})();
