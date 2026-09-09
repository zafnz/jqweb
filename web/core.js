/* Pure helpers shared by the page: parsing the embedded document, rendering
   it to HTML, and reading a jq-style path. Nothing here touches the DOM, so
   it can be exercised outside a browser (see core.test.js). */
var jqweb = (function () {
  'use strict';

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

  return {
    parseJSON: parseJSON,
    renderTree: renderTree,
    parsePath: parsePath,
    quote: quote,
    esc: esc
  };
})();

/* Node loads this file directly to test it; browsers use the global above. */
if (typeof module === 'object' && module.exports) module.exports = jqweb;
