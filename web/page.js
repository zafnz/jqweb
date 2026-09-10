/* The interactive half of the page: builds the tree from the embedded
   document, then wires up expanding and collapsing, copying a path, and the
   search box. Everything here needs the DOM; the parsing, rendering and path
   reading it calls live in core.js. */
(function () {
  'use strict';
  var tree = document.getElementById('tree');
  var results = document.getElementById('results');
  var input = document.getElementById('q');
  var mode = document.getElementById('mode');
  var stats = document.getElementById('stats');
  var parseJSON = jqweb.parseJSON, renderTree = jqweb.renderTree, parsePath = jqweb.parsePath;

  /* The query engine is only inlined when the page was built with --jq. */
  var jq = typeof jqjs !== 'undefined' ? jqjs : null;

  /* Build the whole tree in one write. The document is served inside the page
     as JSON rather than as markup, which keeps the file smaller and lets the
     tree be rendered here where the collapsing state lives. The parsed
     document is kept as well, because a query runs against it. */
  var rootValue = parseJSON(document.getElementById('data').textContent);
  tree.innerHTML = renderTree(rootValue);
  var rootNode = tree.querySelector(':scope > .node');

  if (jq) {
    mode.hidden = false;
    input.placeholder = 'Filter, a path, or a jq query such as .items[] | select(.n > 3)';
  }

  /* One delegated listener for every line in either view, however many there
     are: a click either hits a copy button, a toggle, or the collapsed
     summary, which expands the node it belongs to. */
  document.querySelector('main').addEventListener('click', function (e) {
    var cp = e.target.closest('.cp');
    if (cp) { copyPath(cp); return; }
    var tg = e.target.closest('.toggle');
    if (tg) { tg.closest('.node').classList.toggle('collapsed'); return; }
    var fold = e.target.closest('.fold');
    if (fold) { fold.closest('.node').classList.remove('collapsed'); }
  });

  /* Collapse all leaves the root expanded, so the document is still readable
     rather than a single line. */
  document.getElementById('expand').addEventListener('click', function () {
    each('.node.branch', function (n) { n.classList.remove('collapsed'); });
  });
  document.getElementById('collapse').addEventListener('click', function () {
    each('.node.branch', function (n) { if (n !== rootNode) n.classList.add('collapsed'); });
  });

  /* Runs fn over every node in either view matching sel. querySelectorAll
     gives a NodeList, which in older browsers has no forEach of its own. */
  function each(sel, fn) {
    Array.prototype.forEach.call(document.querySelectorAll('main ' + sel), fn);
  }

  /* ---- copy path ---- */

  /* A key that can be written as .name rather than ["name"]. */
  var identRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /* Builds the jq-style path of a node by walking up its ancestors and
     reading back the data attributes emit() wrote, prepending each segment as
     it goes. The result is what parsePath() reads, so a copied path can be
     pasted straight into the search box.

     The walk stops at whichever tree the node is in, so in the result view the
     path is relative to the result it sits in rather than to the document. */
  function pathOf(node) {
    var segs = [];
    var n = node;
    while (n) {
      if (n.dataset.index !== undefined) {
        segs.unshift('[' + n.dataset.index + ']');
      } else if (n.dataset.key !== undefined) {
        var k = n.dataset.key;
        segs.unshift(identRe.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
      }
      /* Skip the .kids wrapper between a node and its parent node. */
      n = n.parentElement && n.parentElement.closest('.node');
    }
    var p = segs.join('');
    if (!p) return '.';                       /* the root itself */
    if (p.charAt(0) === '[') p = '.' + p;     /* jq writes .[0], not [0] */
    return p;
  }

  /* Copies the path of the line a copy button belongs to, and reports the
     outcome on the button itself. */
  function copyPath(btn) {
    var path = pathOf(btn.closest('.node'));
    copyText(path, function (ok) { flash(btn, ok); });
  }

  /* Copies text, calling done(ok) when it settles. The clipboard API needs a
     secure context, which a page opened from a file:// URL is not, and can
     still be refused when it is available, so both paths fall back. */
  function copyText(t, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).then(
        function () { done(true); },
        function () { done(legacyCopy(t)); });
    } else {
      done(legacyCopy(t));
    }
  }

  /* The pre-clipboard-API copy: put the text in an off-screen textarea,
     select it, and have the document copy the selection. Deprecated, but it
     is what works without a secure context. */
  function legacyCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return ok;
  }

  /* Briefly turns a copy button into a tick or a cross, then restores it. */
  function flash(btn, ok) {
    btn.classList.add(ok ? 'ok' : 'fail');
    btn.textContent = ok ? '✓' : '✗';
    setTimeout(function () {
      btn.classList.remove('ok', 'fail');
      btn.textContent = '⧉';
    }, 900);
  }

  /* ---- search ---- */

  /* Searching walks the whole tree, so wait for a pause in typing rather than
     doing it on every keystroke. */
  var timer = null;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  /* "/" focuses the search box, Escape clears it. */
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && e.target !== input) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape' && e.target === input) { input.value = ''; run(); }
  });

  mode.addEventListener('change', function () { input.focus(); run(); });

  /* Runs whatever is in the box. Without the query engine that is the text
     filter or a path, as it has always been; with it, the mode decides. */
  function run() {
    var raw = input.value.trim();
    input.classList.remove('bad');
    if (!raw) { reset(); return; }
    if (!jq) { runPath(raw); return; }
    if (queryMode(raw) === 'jq') { runQuery(raw); return; }
    showDocument();
    textFilter(raw.toLowerCase());
  }

  /* The characters a path or a jq expression can start with. In auto mode
     they are what tells a query from a filter, so that typing a word still
     filters; a bare-word query such as "keys" needs the mode set to jq. */
  var QUERY_START = '.[($|';

  function queryMode(raw) {
    return mode.value !== 'auto' ? mode.value
      : QUERY_START.indexOf(raw.charAt(0)) >= 0 ? 'jq' : 'filter';
  }

  /* Compiles and runs the box as a jq query. One that only walks down the
     document is shown in place, as a pasted path always has been; anything
     else produces values that are not in the document, so its output replaces
     the view. */
  function runQuery(raw) {
    var query, out;
    showDocument();
    try {
      query = jq.compile(raw);
    } catch (e) {
      fault(e.message, e.pos);
      return;
    }
    if (query.path) { showFound(resolvePath(query.path), query.path.length); return; }
    try {
      out = query.run(rootValue);
    } catch (e) {
      fault(e.message);
      return;
    }
    showResults(out);
  }

  /* The old behaviour, and still what a page built without --jq does: text
     containing "." or "[" may be a path such as .a.b[3].c, so it is tried as
     one first, and a bare word is always a text filter. A path that does not
     resolve falls back to text filtering unless it was written with a leading
     dot, which takes it as a path regardless. */
  function runPath(raw) {
    if (/[.[]/.test(raw)) {
      var segs = parsePath(raw);
      if (segs) {
        var found = resolvePath(segs);
        if (found.depth === segs.length || raw.charAt(0) === '.') {
          showFound(found, segs.length);
          return;
        }
      }
    }
    textFilter(raw.toLowerCase());
  }

  /* Reveals the node a path led to, or says how far it got. A partial match is
     still worth showing, since it says where the path stopped resolving. */
  function showFound(found, want) {
    if (found.depth === want) {
      showPath(found.node, true);
      stats.textContent = pathOf(found.node);
      return;
    }
    showPath(found.node, found.depth > 0);
    stats.textContent = found.depth ? 'no path past ' + pathOf(found.node) : 'no such path';
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

  function showDocument() {
    if (results.hidden) return;
    results.hidden = true;
    results.innerHTML = '';
    tree.hidden = false;
  }

  /* Clears any filtering and shows the whole document again. Collapsed state
     is left alone: it is the reader's, not the search's. */
  function reset() {
    showDocument();
    each('.node', function (n) { n.classList.remove('hidden', 'hit'); });
    stats.textContent = '';
  }

  /* Walks segs from the root, returning the deepest node reached and how many
     segments matched; depth === segs.length is a full match. A partial match
     is still useful, since it says where a path stopped resolving. */
  function resolvePath(segs) {
    var node = rootNode, i = 0;
    for (; i < segs.length; i++) {
      var next = childMatching(node, segs[i]);
      if (!next) break;
      node = next;
    }
    return { node: node, depth: i };
  }

  /* The child of node named by one path segment, or null. */
  function childMatching(node, seg) {
    var kids = node.querySelectorAll(':scope > .kids > .node'), i;
    /* Keys are compared as text, because an object's members are in document
       order rather than sorted, so there is nothing to look them up by. */
    if (seg.key !== undefined) {
      for (i = 0; i < kids.length; i++) {
        if (kids[i].dataset.key === seg.key) return kids[i];
      }
      return null;
    }
    /* A negative index counts from the end, as in jq. The data-index check
       keeps a path from resolving against an object, whose children are in
       the same place but carry keys instead. */
    i = seg.index < 0 ? kids.length + seg.index : seg.index;
    return kids[i] && kids[i].dataset.index === String(i) ? kids[i] : null;
  }

  /* Shows target with its whole subtree, plus the ancestors leading to it. */
  function showPath(target, mark) {
    each('.node', function (n) { n.classList.add('hidden'); n.classList.remove('hit'); });
    /* Reveal and expand the line of ancestors, so the target is reachable. */
    for (var n = target; n; n = n.parentElement && n.parentElement.closest('.node')) {
      n.classList.remove('hidden', 'collapsed');
    }
    if (mark) target.classList.add('hit');
    Array.prototype.forEach.call(target.querySelectorAll('.node'), function (d) {
      d.classList.remove('hidden');
    });
    target.scrollIntoView({ block: 'center' });
  }

  /* ---- text filter ---- */

  /* Lowercased key + leaf value text for one node, cached on the element.
     Filtering reads every node on every keystroke, and the text of a node
     never changes, so it is worth keeping. */
  function ownText(n) {
    if (n._q === undefined) {
      var s = '';
      if (n.dataset.key !== undefined) s += n.dataset.key.toLowerCase() + '\n';
      /* Only this node's own value, not its descendants': the > combinators
         stop querySelector from reaching into a child node. */
      var v = n.querySelector(':scope > .line > .v');
      if (v) s += v.textContent.toLowerCase();
      n._q = s;
    }
    return n._q;
  }

  /* Hides every node whose key and value do not contain needle, keeping the
     ones that lead to or hang off a match, and reports how many matched. */
  function textFilter(needle) {
    var hits = 0;
    /* Returns whether this subtree contains a match. "forced" keeps the whole
       subtree of a matching node visible without counting it as a match. */
    function walk(node, forced) {
      var own = ownText(node).indexOf(needle) !== -1;
      if (own) hits++;
      /* Recurse before deciding: a node with no match of its own is still
         kept when a descendant matched. */
      var childKeep = false;
      var kids = node.querySelectorAll(':scope > .kids > .node');
      for (var i = 0; i < kids.length; i++) {
        if (walk(kids[i], forced || own)) childKeep = true;
      }
      node.classList.toggle('hidden', !(own || forced || childKeep));
      node.classList.toggle('hit', own);
      /* A match inside a collapsed branch would be invisible otherwise. */
      if (childKeep) node.classList.remove('collapsed');
      return own || childKeep;
    }
    walk(rootNode, false);
    stats.textContent = hits === 1 ? '1 match' : hits + ' matches';
  }
})();
