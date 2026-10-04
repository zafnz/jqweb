/* The front page's demo types a query into the example page through this
   hook. The pages workflow inlines it into the deployed k8s.html and nowhere
   else: jqweb itself never carries it.

   In a frame, it answers jqweb-demo:hello with jqweb-demo:ready, and on
   jqweb-demo:set it fills the search box and fires the input event typing
   would. Messages from any origin other than jqweb.io or a local server are
   ignored. With no #q on the page it does nothing, and the demo stops once its
   window has opened. */
(() => {
  if (window.parent === window) return;
  const q = document.getElementById('q');
  if (!q) return;
  const allowed = (origin) =>
    origin === 'https://jqweb.io' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  window.addEventListener('message', (e) => {
    if (!allowed(e.origin) || !e.data || !e.source) return;
    if (e.data.type === 'jqweb-demo:hello') {
      e.source.postMessage({ type: 'jqweb-demo:ready' }, e.origin);
    } else if (e.data.type === 'jqweb-demo:set' && typeof e.data.value === 'string') {
      q.value = e.data.value;
      q.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
})();
