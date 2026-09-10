/* The half of the page that exists only when the document was rendered with
   --jq: reading the search box as a query, and showing what one produces.

   It is kept apart from page.js because page.js is inlined into every page
   whether or not the engine is, and none of this means anything without it.
   page.js calls jqui() once, with the few things it cannot look up for
   itself, and gets back the entry points it needs. */
var jqui = function (page) {
  'use strict';
  var renderTree = jqweb.renderTree;
  var tree = document.getElementById('tree');
  var results = document.getElementById('results');
  var input = document.getElementById('q');
  var mode = document.getElementById('mode');
  var stats = document.getElementById('stats');

  /* Both of these are meaningless without the engine, so the shell ships them
     hidden and unexplained and they are turned on here. */
  mode.hidden = false;
  input.placeholder = 'Filter, a path, or a jq query such as .items[] | select(.n > 3)';
  mode.addEventListener('change', function () { input.focus(); page.rerun(); });

  /* The characters a path or a jq expression can start with. In auto mode
     they are what tells a query from a filter, so that typing a word still
     filters; a bare-word query such as "keys" needs the mode set to jq. */
  var QUERY_START = '.[($|';

  /* Whether the box should be read as a query rather than filtered on. */
  function wants(raw) {
    return mode.value === 'jq' ||
      (mode.value === 'auto' && QUERY_START.indexOf(raw.charAt(0)) >= 0);
  }

  /* Compiles and runs the box as a query. One that only walks down the
     document is shown in place, as a pasted path always has been; anything
     else produces values that are not in the document, so its output replaces
     the view. */
  function run(raw) {
    var query, out;
    showDocument();
    try {
      query = jqjs.compile(raw);
    } catch (e) {
      fault(e.message, e.pos);
      return;
    }
    if (query.path) { page.showFound(page.resolve(query.path), query.path.length); return; }
    try {
      out = query.run(page.value);
    } catch (e) {
      fault(e.message);
      return;
    }
    showResults(out);
  }

  /* Reports a query that would not compile or would not run. */
  function fault(message, pos) {
    input.classList.add('bad');
    stats.textContent = pos === undefined ? message : message + ' (at ' + (pos + 1) + ')';
  }

  /* Building the markup for a query's whole output is what would stall the
     page, so only this many are rendered; the count still reports them all. */
  var RESULT_CAP = 500;

  /* Shows a query's outputs in place of the document. Each carries its
     position, which the stylesheet puts in the gutter, because a query
     produces a list of values rather than one document; a single value is left
     unnumbered. The document tree is hidden rather than thrown away, so it
     comes back with its collapsed state intact and without being rendered
     again. */
  function showResults(out) {
    var shown = Math.min(out.length, RESULT_CAP), parts = [], i;
    for (i = 0; i < shown; i++) {
      parts.push('<div class="result" data-n="' + i + '">' + renderTree(out[i]) + '</div>');
    }
    results.innerHTML = parts.join('');
    results.classList.toggle('one', out.length === 1);
    results.hidden = false;
    tree.hidden = true;
    stats.textContent = shown < out.length
      ? 'first ' + shown + ' of ' + out.length + ' results'
      : out.length === 1 ? '1 result' : out.length + ' results';
  }

  /* Puts the document back. Without the engine nothing ever replaces it, so
     page.js only has this to call when there is a jqui at all. */
  function showDocument() {
    if (results.hidden) return;
    results.hidden = true;
    results.innerHTML = '';
    tree.hidden = false;
  }

  return { wants: wants, run: run, showDocument: showDocument };
};
