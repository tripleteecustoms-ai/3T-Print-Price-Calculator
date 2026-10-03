// public/js/embed.js — makes the customer pages behave when embedded in an
// <iframe> on another site (the Shopify home page). Does nothing when the
// page is opened directly.
//
// The parent page's embed code (see "Embedding on Shopify" below) and this
// script talk with postMessage:
//   this page -> parent  { type: '3t-height', height }   resize the iframe to fit the content,
//                                                         so it never scrolls inside itself
//                        { type: '3t-scroll', top }      scroll the parent so this point of
//                                                         the page is in view (step changes,
//                                                         error messages)
//   parent -> this page  { type: '3t-viewport', top, height }   which slice of this (tall)
//                                                         page the visitor can actually see
// Because the iframe is as tall as the whole page, anything position:fixed
// (pop-ups, toasts, the mobile order bar) would sit relative to the whole
// page instead of the visitor's screen; the viewport message lets those be
// placed in the visible slice instead.
//
// Embedding on Shopify (Online Store > Themes > Customize > Add section >
// Custom Liquid):
//
//   <div style="max-width:1240px;margin:0 auto;">
//     <iframe id="tppc-frame" src="https://threet-print-price-calculator.onrender.com/"
//       title="Build Your Custom Order" scrolling="no"
//       style="width:100%;height:900px;border:0;display:block;overflow:hidden;"></iframe>
//   </div>
//   <script>
//   (function () {
//     var ORIGIN = 'https://threet-print-price-calculator.onrender.com';
//     var HEADER_OFFSET = 90; // room for the store's sticky header when scrolling to the calculator
//     var frame = document.getElementById('tppc-frame');
//     function sendViewport() {
//       var r = frame.getBoundingClientRect();
//       frame.contentWindow.postMessage({ type: '3t-viewport', top: Math.max(0, -r.top), height: window.innerHeight }, ORIGIN);
//     }
//     window.addEventListener('message', function (e) {
//       if (e.origin !== ORIGIN || e.source !== frame.contentWindow || !e.data) return;
//       if (e.data.type === '3t-height') { frame.style.height = Math.ceil(e.data.height) + 'px'; sendViewport(); }
//       if (e.data.type === '3t-scroll') {
//         var y = frame.getBoundingClientRect().top + window.pageYOffset + e.data.top - HEADER_OFFSET;
//         window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
//       }
//     });
//     window.addEventListener('scroll', sendViewport, { passive: true });
//     window.addEventListener('resize', sendViewport);
//   })();
//   </script>

(function () {
  if (window.parent === window) return; // not embedded

  const root = document.documentElement;
  root.classList.add('is-embedded');
  root.style.setProperty('--embed-top', '0px');
  root.style.setProperty('--embed-vh', window.innerHeight + 'px');

  // Fixed-position pieces go in the slice of the page the visitor can see.
  const style = document.createElement('style');
  style.textContent = `
    html.is-embedded, html.is-embedded body { overflow: hidden; }
    html.is-embedded .specs-modal, html.is-embedded .tpl-modal {
      position: absolute; inset: auto; left: 0; right: 0; top: var(--embed-top); height: var(--embed-vh);
    }
    html.is-embedded .specs-panel { max-height: calc(var(--embed-vh) - 32px); }
    html.is-embedded .tpl-modal-img { max-height: calc(var(--embed-vh) * 0.6); }
    html.is-embedded .toast { position: absolute; bottom: auto; top: calc(var(--embed-top) + var(--embed-vh) - 80px); }
    html.is-embedded .mobile-summary-bar { position: absolute; bottom: auto; top: calc(var(--embed-top) + var(--embed-vh)); transform: translateY(-100%); }
  `;
  document.head.appendChild(style);

  const send = (msg) => { try { window.parent.postMessage(msg, '*'); } catch (e) { /* parent gone */ } };

  // ---- height: the content's own height, not the iframe's (so it can shrink too)
  let lastHeight = 0;
  function reportHeight() {
    const body = document.body;
    if (!body) return;
    const height = Math.ceil(body.getBoundingClientRect().height + (parseFloat(getComputedStyle(body).marginBottom) || 0));
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    send({ type: '3t-height', height });
  }
  const start = () => {
    reportHeight();
    if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);
    window.addEventListener('load', reportHeight);
    setInterval(reportHeight, 1000); // late images and fonts, as a fallback
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  // ---- scrolling: the page never scrolls inside the iframe, so scroll the parent instead.
  // Only after the visitor has done something here (or arrived from another
  // calculator page), so loading the store's home page never jumps down to the calculator.
  let interacted = false;
  ['pointerdown', 'keydown'].forEach(t => window.addEventListener(t, () => { interacted = true; }, { capture: true, passive: true }));
  const cameFromCalculator = document.referrer.indexOf(location.origin) === 0;
  const scrollParentTo = (top) => { if (interacted) send({ type: '3t-scroll', top: Math.max(0, top) }); };
  window.scrollTo = function (a, b) {
    const top = typeof a === 'object' && a ? (a.top || 0) : (Number(b) || 0);
    scrollParentTo(top);
  };
  Element.prototype.scrollIntoView = function () {
    scrollParentTo(this.getBoundingClientRect().top + (window.pageYOffset || 0) - 16);
  };
  if (cameFromCalculator) { interacted = true; send({ type: '3t-scroll', top: 0 }); }

  // ---- the visible slice, from the parent page
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== '3t-viewport') return;
    const top = Number(e.data.top), height = Number(e.data.height);
    if (!(top >= 0) || !(height > 0)) return;
    root.style.setProperty('--embed-top', Math.round(top) + 'px');
    root.style.setProperty('--embed-vh', Math.round(height) + 'px');
  });
})();
