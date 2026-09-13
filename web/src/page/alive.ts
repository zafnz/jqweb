/* A page jqweb serves holds one request to /alive open for as long as it
   exists, and the browser drops it when the tab unloads. With -C the server
   counts those requests to know when the last tab has closed. A page written
   to a file has no data-served on its root and makes no request.

   This runs in the head script. On a reload the old page's request closes as
   the new page arrives, and the new one has to open within the close delay;
   from the body script that waits for the whole document to be parsed, about
   4.5 seconds for a 4.9MB one. */

export function holdServer(): void {
  if (!document.documentElement.hasAttribute('data-served')) return;
  const source = new EventSource('/alive');
  /* A browser may collect an EventSource with no listener on it, which closes
     the request while the page is still open. The listener is what keeps it. */
  source.addEventListener('error', function () {});
}
