(function () {
  'use strict';
  var tree = document.getElementById('tree');
  var input = document.getElementById('q');
  var stats = document.getElementById('stats');

  /* ---- parse ---- */

  /* The embedded document is compact JSON, parsed here rather than with
     JSON.parse because the tree shows object keys in document order and
     numbers exactly as written, neither of which survives JSON.parse. A node
     is {t:'o',k:keys,v:children}, {t:'a',v:children} or {t:'l',h:leafHTML}. */
  function parseJSON(src) {
    var i = 0;

    function ws() { while (i < src.length && src.charCodeAt(i) <= 32) i++; }

    /* Reads a string literal starting at src[i] and returns its value. */
    function str() {
      var start = i++;
      while (src.charCodeAt(i) !== 34) i += src.charCodeAt(i) === 92 ? 2 : 1;
      return JSON.parse(src.slice(start, ++i));
    }

    function value() {
      ws();
      var c = src.charAt(i), keys, vals, lit, start;
      if (c === '{') {
        i++; keys = []; vals = []; ws();
        if (src.charAt(i) === '}') {
          i++;
        } else {
          for (;;) {
            ws();
            keys.push(str());
            ws(); i++;                 /* ':' */
            vals.push(value());
            ws();
            if (src.charAt(i++) === '}') break;
          }
        }
        return { t: 'o', k: keys, v: vals };
      }
      if (c === '[') {
        i++; vals = []; ws();
        if (src.charAt(i) === ']') {
          i++;
        } else {
          for (;;) {
            vals.push(value());
            ws();
            if (src.charAt(i++) === ']') break;
          }
        }
        return { t: 'a', v: vals };
      }
      if (c === '"') return { t: 'l', h: span('str', esc(quote(str()))) };
      start = i;
      while (i < src.length && ',]}'.indexOf(src.charAt(i)) < 0 && src.charCodeAt(i) > 32) i++;
      lit = src.slice(start, i);
      return { t: 'l', h: span(lit === 'null' ? 'null' : lit === 'true' || lit === 'false' ? 'bool' : 'num', lit) };
    }

    return value();
  }

  function span(cls, text) { return '<span class="v ' + cls + '">' + text + '</span>'; }

  /* JSON.stringify leaves U+2028 and U+2029 raw; they are escaped so the tree
     shows them instead of an invisible separator. */
  function quote(s) {
    return JSON.stringify(s).replace(/[\u2028\u2029]/g, function (c) {
      return '\\u202' + (c === '\u2028' ? '8' : '9');
    });
  }

  var escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return escMap[c]; }); }

  /* ---- render ---- */

  var CP = '<button class="cp" title="Copy path">&#x29C9;</button>';

  function renderTree(root) {
    var out = [];
    emit(out, root, null, -1, false);
    return out.join('');
  }

  /* Emits one tree node. key is non-null for object members, idx >= 0 for
     array elements; the root has neither. comma appends a trailing comma. */
  function emit(out, node, key, idx, comma) {
    var attrs = key !== null ? ' data-key="' + esc(key) + '"'
      : idx >= 0 ? ' data-index="' + idx + '"' : '';
    var keyPart = '', endBtn = CP;   /* unkeyed nodes get the button at the end of the line */
    if (key !== null) {
      keyPart = '<span class="key">' + esc(quote(key)) + '</span>' + CP +
        '<span class="pn">: </span>';
      endBtn = '';
    }
    var c = comma ? '<span class="c">,</span>' : '';

    if (node.t === 'l') {
      out.push('<div class="node leaf"' + attrs + '><div class="line"><span class="sp"></span>' +
        keyPart + node.h + c + endBtn + '</div></div>');
      return;
    }
    var obj = node.t === 'o';
    var open = obj ? '{' : '[';
    var close = obj ? '}' : ']';
    var n = node.v.length;
    if (!n) {
      out.push('<div class="node leaf"' + attrs + '><div class="line"><span class="sp"></span>' +
        keyPart + '<span class="p">' + open + close + '</span>' + c + endBtn + '</div></div>');
      return;
    }
    var noun = (obj ? 'key' : 'item') + (n === 1 ? '' : 's');
    out.push('<div class="node branch"' + attrs +
      '><div class="line"><button class="toggle" aria-label="Toggle"></button>' +
      keyPart + '<span class="p">' + open + '</span>' +
      '<span class="fold"> &#x2026; ' + n + ' ' + noun + ' <span class="p">' + close + '</span>' +
      c + '</span>' + endBtn + '</div><div class="kids">');
    for (var j = 0; j < n; j++) {
      emit(out, node.v[j], obj ? node.k[j] : null, obj ? -1 : j, j < n - 1);
    }
    out.push('</div><div class="closer"><span class="p">' + close + '</span>' + c + '</div></div>');
  }

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

  /* ---- path navigation ---- */
  var pathChar = /[^.[\]"'\s]/;

  /* parsePath splits a jq-style path such as .a.b[3]["x y"] into key and index
     segments. The leading dot is optional. Returns null for text that is not a
     path. */
  function parsePath(str) {
    var s = str.trim();
    if (s === '.') return [];
    var segs = [], i = 0;
    if (s.charAt(0) !== '.' && s.charAt(0) !== '[') {
      while (i < s.length && pathChar.test(s.charAt(i))) i++;
      if (!i) return null;
      segs.push({ key: s.slice(0, i) });
    }
    while (i < s.length) {
      var c = s.charAt(i), q, j, start;
      if (c === '.') {
        i++;
        if (s.charAt(i) === '[') continue;
        start = i;
        while (i < s.length && pathChar.test(s.charAt(i))) i++;
        if (i === start) return null;
        segs.push({ key: s.slice(start, i) });
      } else if (c === '[') {
        q = s.charAt(i + 1);
        if (q === '"' || q === "'") {
          j = i + 2;
          while (j < s.length && s.charAt(j) !== q) j += s.charAt(j) === '\\' ? 2 : 1;
          if (s.charAt(j) !== q || s.charAt(j + 1) !== ']') return null;
          if (q === '"') {
            try { segs.push({ key: JSON.parse(s.slice(i + 1, j + 1)) }); }
            catch (e) { return null; }
          } else {
            segs.push({ key: s.slice(i + 2, j).replace(/\\(['\\])/g, '$1') });
          }
          i = j + 2;
        } else {
          j = s.indexOf(']', i + 1);
          if (j < 0 || !/^-?\d+$/.test(s.slice(i + 1, j))) return null;
          segs.push({ index: parseInt(s.slice(i + 1, j), 10) });
          i = j + 1;
        }
      } else {
        return null;
      }
    }
    return segs.length ? segs : null;
  }

  /* Walks segs from the root, returning the deepest node reached and how many
     segments matched; depth === segs.length is a full match. */
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
