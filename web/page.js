(function () {
  'use strict';
  var tree = document.getElementById('tree');
  var input = document.getElementById('q');
  var stats = document.getElementById('stats');
  var parseJSON = jqweb.parseJSON, renderTree = jqweb.renderTree, parsePath = jqweb.parsePath;

  tree.innerHTML = renderTree(parseJSON(document.getElementById('data').textContent));
  var rootNode = tree.querySelector(':scope > .node');

  tree.addEventListener('click', function (e) {
    var cp = e.target.closest('.cp');
    if (cp) { copyPath(cp); return; }
    var tg = e.target.closest('.toggle');
    if (tg) { tg.closest('.node').classList.toggle('collapsed'); return; }
    var fold = e.target.closest('.fold');
    if (fold) { fold.closest('.node').classList.remove('collapsed'); }
  });

  document.getElementById('expand').addEventListener('click', function () {
    each('.node.branch', function (n) { n.classList.remove('collapsed'); });
  });
  document.getElementById('collapse').addEventListener('click', function () {
    each('.node.branch', function (n) { if (n !== rootNode) n.classList.add('collapsed'); });
  });

  function each(sel, fn) {
    Array.prototype.forEach.call(tree.querySelectorAll(sel), fn);
  }

  /* ---- copy path ---- */
  var identRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
      n = n.parentElement && n.parentElement.closest('.node');
    }
    var p = segs.join('');
    if (!p) return '.';
    if (p.charAt(0) === '[') p = '.' + p;
    return p;
  }

  function copyPath(btn) {
    var path = pathOf(btn.closest('.node'));
    copyText(path, function (ok) { flash(btn, ok); });
  }

  function copyText(t, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).then(
        function () { done(true); },
        function () { done(legacyCopy(t)); });
    } else {
      done(legacyCopy(t));
    }
  }

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

  function flash(btn, ok) {
    btn.classList.add(ok ? 'ok' : 'fail');
    btn.textContent = ok ? '✓' : '✗';
    setTimeout(function () {
      btn.classList.remove('ok', 'fail');
      btn.textContent = '⧉';
    }, 900);
  }

  /* ---- search ---- */
  var timer = null;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && e.target !== input) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape' && e.target === input) { input.value = ''; run(); }
  });

  /* Text containing "." or "[" may be a path such as .a.b[3].c, so it is tried
     as one first; a bare word is always a text filter. A path that does not
     resolve falls back to text filtering unless it was written with a leading
     dot, which takes it as a path regardless. */
  function run() {
    var raw = input.value.trim();
    if (!raw) { reset(); return; }
    if (/[.[]/.test(raw)) {
      var segs = parsePath(raw);
      if (segs) {
        var found = resolvePath(segs);
        if (found.depth === segs.length) {
          showPath(found.node, true);
          stats.textContent = pathOf(found.node);
          return;
        }
        if (raw.charAt(0) === '.') {
          showPath(found.node, found.depth > 0);
          stats.textContent = found.depth ? 'no path past ' + pathOf(found.node) : 'no such path';
          return;
        }
      }
    }
    textFilter(raw.toLowerCase());
  }

  function reset() {
    each('.node', function (n) { n.classList.remove('hidden', 'hit'); });
    stats.textContent = '';
  }

  function resolvePath(segs) {
    var node = rootNode, i = 0;
    for (; i < segs.length; i++) {
      var next = childMatching(node, segs[i]);
      if (!next) break;
      node = next;
    }
    return { node: node, depth: i };
  }

  function childMatching(node, seg) {
    var kids = node.querySelectorAll(':scope > .kids > .node'), i;
    if (seg.key !== undefined) {
      for (i = 0; i < kids.length; i++) {
        if (kids[i].dataset.key === seg.key) return kids[i];
      }
      return null;
    }
    i = seg.index < 0 ? kids.length + seg.index : seg.index;
    return kids[i] && kids[i].dataset.index === String(i) ? kids[i] : null;
  }

  /* Shows target with its whole subtree, plus the ancestors leading to it. */
  function showPath(target, mark) {
    each('.node', function (n) { n.classList.add('hidden'); n.classList.remove('hit'); });
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

  /* Lowercased key + leaf value text for one node, cached on the element. */
  function ownText(n) {
    if (n._q === undefined) {
      var s = '';
      if (n.dataset.key !== undefined) s += n.dataset.key.toLowerCase() + '\n';
      var v = n.querySelector(':scope > .line > .v');
      if (v) s += v.textContent.toLowerCase();
      n._q = s;
    }
    return n._q;
  }

  function textFilter(needle) {
    var hits = 0;
    /* Returns whether this subtree contains a match. "forced" keeps the whole
       subtree of a matching node visible without counting it as a match. */
    function walk(node, forced) {
      var own = ownText(node).indexOf(needle) !== -1;
      if (own) hits++;
      var childKeep = false;
      var kids = node.querySelectorAll(':scope > .kids > .node');
      for (var i = 0; i < kids.length; i++) {
        if (walk(kids[i], forced || own)) childKeep = true;
      }
      node.classList.toggle('hidden', !(own || forced || childKeep));
      node.classList.toggle('hit', own);
      if (childKeep) node.classList.remove('collapsed');
      return own || childKeep;
    }
    walk(rootNode, false);
    stats.textContent = hits === 1 ? '1 match' : hits + ' matches';
  }
})();
