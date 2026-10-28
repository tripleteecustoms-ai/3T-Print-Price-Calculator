// Registers the service worker that lets this site be added to a phone's
// home screen as an app. The admin pages register their own (scope /admin/).
(function () {
  if (!('serviceWorker' in navigator)) return;
  var url = location.pathname.indexOf('/admin/') === 0 ? '/admin/sw.js' : '/sw.js';
  window.addEventListener('load', function () {
    navigator.serviceWorker.register(url).catch(function () {});
  });
})();
