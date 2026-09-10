/* The interactive half of the page: builds the tree from the embedded
   document, then wires up expanding and collapsing, copying a path, and the
   search box. Everything here needs the DOM; the parsing, rendering and path
   reading it calls live in core.js.

   Reading the box as a jq query lives in query.js, which every page has unless
   --simple left it out. This file is in every page either way, so it works
   without it. */
(function () {
  'use strict';
  var tree = document.getElementById('tree');
  var input = document.getElementById('q');
  var stats = document.getElementById('stats');
  var parseJSON = jqweb.parseJSON, renderTree = jqweb.renderTree, parsePath = jqweb.parsePath;

  /* Build the whole tree in one write. The document is served inside the page
     as JSON rather than as markup, which keeps the file smaller and lets the
     tree be rendered here where the collapsing state lives. The parsed
     document is kept as well, because a query runs against it. */
  var rootValue = parseJSON(document.getElementById('data').textContent);
  tree.innerHTML = renderTree(rootValue, typeof jqui !== 'undefined');
  var rootNode = tree.querySelector(':scope > .node');

  /* The query half, or null in a page built with --simple. It reads the search
     box, so it needs the document to run against and the two path helpers
     below, which walk the rendered tree rather than the value. */
  var query = typeof jqui === 'undefined' ? null : jqui({
    value: rootValue,
    resolve: resolvePath,
    showFound: showFound,
    segsOf: segsOf,
    copy: copy,
    rerun: run
  });

  /* The toolbar's theme button reports what is in force and cycles when
     clicked; the palette itself was settled by theme.js before the body was
     parsed. */
  var GLYPH = { auto: '\u25D0', light: '\u2600', dark: '\u263E' };
  var themeButton = document.getElementById('theme');
  themeButton.addEventListener('click', function () { showTheme(jqtheme.cycle()); });
  showTheme(jqtheme.current());

  function showTheme(pref) {
    themeButton.textContent = GLYPH[pref];
    themeButton.title = 'Theme: ' + pref;
  }

  /* One delegated listener for every line in either view, however many there
     are: a click either hits a copy button, a toggle, or the collapsed
     summary, which expands the node it belongs to. */
  document.querySelector('main').addEventListener('click', function (e) {
    var cp = e.target.closest('.cp');
    if (cp) { copy(pathOf(cp.closest('.node')), cp); return; }
    var fq = e.target.closest('.fq');
    if (fq) { if (query) query.filter(fq.closest('.node')); return; }
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

  /* Where a node sits, as the segments parsePath produces, read back off the
     data attributes emit() wrote by walking up its ancestors.

     The walk stops at whichever tree the node is in, so in the result view the
     segments are relative to the result the node sits in rather than to the
     document. */
  function segsOf(node) {
    var segs = [], n = node;
    while (n) {
      if (n.dataset.index !== undefined) {
        segs.unshift({ index: +n.dataset.index });
      } else if (n.dataset.key !== undefined) {
        segs.unshift({ key: n.dataset.key });
      }
      /* Skip the .kids wrapper between a node and its parent node. */
      n = n.parentElement && n.parentElement.closest('.node');
    }
    return segs;
  }

  /* The jq-style path of a node, which is what parsePath() reads, so a copied
     path can be pasted straight back into the search box. */
  function pathOf(node) {
    return jqweb.pathText(segsOf(node));
  }

  /* Copies text, reporting the outcome on the button that asked for it. */
  function copy(text, btn) {
    copyText(text, function (ok) { flash(btn, ok); });
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

  /* Runs whatever is in the box. Without query.js that is the text filter or a
     path, as it has always been; with it, the mode decides. */
  function run() {
    var raw = input.value.trim();
    input.classList.remove('bad');
    if (!raw) { reset(); return; }
    if (!query) { runPath(raw); return; }
    if (query.wants(raw)) { query.run(raw); return; }
    query.showDocument();
    textFilter(raw.toLowerCase());
  }

  /* What a page built with --simple does, and what every page did before the
     engine existed: text
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

  /* Clears any filtering and shows the whole document again. Collapsed state
     is left alone: it is the reader's, not the search's. */
  function reset() {
    if (query) query.showDocument();
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
