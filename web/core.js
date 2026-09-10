/* Pure helpers shared by the page: parsing the embedded document, rendering
   it to HTML and back to JSON, and reading a jq-style path. Nothing here
   touches the DOM, so it can be exercised outside a browser (see
   core.test.js). */
var jqweb = (function () {
  'use strict';

  /* ---- parse ---- */

  /* The embedded document is compact JSON, parsed here rather than with
     JSON.parse because the tree shows object keys in document order and
     numbers exactly as written, neither of which survives JSON.parse. A node
     is {t:'o',k:keys,v:children}, {t:'a',v:children} or a leaf,
     {t:'l',r:value,h:leafHTML}, where r is the scalar itself -- what the jq
     evaluator compares and computes with -- and h is the rendered markup. A
     number leaf also carries n, its text as written, which is what stringify
     writes back out.

     This is a recursive-descent scanner over src. The read position i lives
     here, and the three helpers below close over it: each one advances i as a
     side effect rather than taking and returning a position, which is what
     keeps their call sites short enough to read. Nothing validates the input,
     because the Go side has already rejected anything that is not a single
     well-formed JSON document. */
  function parseJSON(src) {
    var i = 0;

    /* Skips whitespace by advancing the shared i. Every JSON space character
       (space, tab, CR, LF) is <= 32, and past the end of src charCodeAt gives
       NaN, which fails the comparison and stops the loop. */
    function ws() { while (i < src.length && src.charCodeAt(i) <= 32) i++; }

    /* Reads a string literal starting at src[i] and returns its value. Walks
       to the closing quote (34), stepping two characters past a backslash (92)
       so that an escaped quote does not end the scan, then hands the slice --
       quotes included -- to JSON.parse to undo the escaping. */
    function str() {
      var start = i++;
      while (src.charCodeAt(i) !== 34) i += src.charCodeAt(i) === 92 ? 2 : 1;
      return JSON.parse(src.slice(start, ++i));
    }

    /* Reads one value at src[i] and returns its node, recursing for members
       and elements. */
    function value() {
      ws();
      var c = src.charAt(i), keys, vals, lit, start;
      if (c === '{') {
        i++; keys = []; vals = []; ws();
        if (src.charAt(i) === '}') {
          i++;
        } else {
          /* Read "key": value pairs. The post-increment in the test consumes
             the separator that follows each pair, which is either a comma
             (keep going) or the closing brace (stop). */
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
          /* As above: the separator after each element is consumed by the
             test, and tells us whether another element follows. value()
             leaves i on it, so only trailing whitespace needs skipping. */
          for (;;) {
            vals.push(value());
            ws();
            if (src.charAt(i++) === ']') break;
          }
        }
        return { t: 'a', v: vals };
      }
      if (c === '"') {
        lit = str();
        return { t: 'l', r: lit, h: span('str', esc(quote(lit))) };
      }
      /* Anything else is a number or one of the three literals. Read up to
         whatever ends it -- a delimiter or whitespace -- and keep the text
         exactly as written, since that is the point of not using JSON.parse.
         The class is then decided by the text itself, for coloring. */
      start = i;
      while (i < src.length && ',]}'.indexOf(src.charAt(i)) < 0 && src.charCodeAt(i) > 32) i++;
      lit = src.slice(start, i);
      if (lit === 'null') return { t: 'l', r: null, h: span('null', lit) };
      if (lit === 'true' || lit === 'false') return { t: 'l', r: lit === 'true', h: span('bool', lit) };
      return { t: 'l', r: +lit, n: lit, h: span('num', lit) };
    }

    return value();
  }

  /* Wraps a rendered value in the span the stylesheet colors by class. */
  function span(cls, text) { return '<span class="v ' + cls + '">' + text + '</span>'; }

  /* Renders a string as a JSON string literal, quotes included.
     JSON.stringify leaves U+2028 and U+2029 raw; they are escaped so the tree
     shows them instead of an invisible separator. */
  function quote(s) {
    return JSON.stringify(s).replace(/[\u2028\u2029]/g, function (c) {
      return '\\u202' + (c === '\u2028' ? '8' : '9');
    });
  }

  /* Escapes text for HTML. The tree is built as markup, so everything taken
     from the document goes through here first -- including anything placed in
     an attribute, hence the quote characters. */
  var escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return escMap[c]; }); }

  /* ---- values ---- */

  /* Builds a leaf node for a scalar that was computed rather than read from
     the document, which is where every result of arithmetic, length, keys and
     the rest comes from. A number has no text as written, so it is rendered
     the way JavaScript prints it. */
  function leafOf(v) {
    if (v === null) return { t: 'l', r: null, h: span('null', 'null') };
    if (v === true || v === false) return { t: 'l', r: v, h: span('bool', String(v)) };
    if (typeof v === 'number') {
      /* JSON has no way to write a NaN or an infinity, so they become null,
         which is what JSON.stringify does with them too. */
      if (!isFinite(v)) return { t: 'l', r: null, h: span('null', 'null') };
      return { t: 'l', r: v, n: String(v), h: span('num', String(v)) };
    }
    return { t: 'l', r: v, h: span('str', esc(quote(v))) };
  }

  /* Writes a node back out as JSON text. With indent -- a string such as two
     spaces -- containers are broken across lines; without it the result is
     compact. A number is written from the text it was read with, so a value
     that has not been computed with comes back exactly as the document had
     it. */
  function stringify(node, indent) {
    var out = [];
    write(node, '');
    return out.join('');

    function write(n, pad) {
      if (n.t === 'l') {
        out.push(typeof n.r === 'string' ? quote(n.r)
          : typeof n.r === 'number' ? (n.n !== undefined ? n.n : String(n.r))
            : String(n.r));
        return;
      }
      var obj = n.t === 'o';
      if (!n.v.length) { out.push(obj ? '{}' : '[]'); return; }
      var inner = pad + (indent || '');
      var nl = indent ? '\n' : '';
      out.push((obj ? '{' : '[') + nl);
      for (var i = 0; i < n.v.length; i++) {
        out.push(inner);
        if (obj) out.push(quote(n.k[i]) + (indent ? ': ' : ':'));
        write(n.v[i], inner);
        out.push(i < n.v.length - 1 ? ',' + nl : nl);
      }
      out.push(pad + (obj ? '}' : ']'));
    }
  }

  /* ---- render ---- */

  /* The buttons at the end of every line. Which of them a line carries depends
     on the tree it is in, and only a page with the query engine has more than
     the first: FQ opens the list of queries built from the line, and AD adds
     the line to the output of the query that produced it. renderTree is told
     which tree it is building, and the pair is worked out once per tree rather
     than once per line. */
  var CP = '<button class="cp" title="Copy path">&#x29C9;</button>';
  var FQ = '<button class="fq" title="Filter on this value">&#x2261;</button>';
  var AD = '<button class="ad" title="Add this to the output">&#x229E;</button>';
  var buttons = CP;
  var rootButtons = CP;

  /* Renders a parsed document as the markup for the whole tree. The caller
     assigns it to innerHTML in one go: for a large document that is around
     twice as fast as building the same nodes with createElement, and it keeps
     this file free of the DOM.

     mode says which tree this is: 'filter' for the document, 'add' for what a
     query returned, and anything else for a tree whose lines carry nothing but
     their path. */
  function renderTree(root, mode) {
    var out = [];
    buttons = mode === 'filter' ? CP + FQ : mode === 'add' ? CP + AD : CP;
    /* The top line of a result is the result, so there is no field there to
       pick out of it. */
    rootButtons = mode === 'add' ? CP : buttons;
    emit(out, root, null, -1, false);
    return out.join('');
  }

  /* Emits one tree node. key is non-null for object members, idx >= 0 for
     array elements; the root has neither. comma appends a trailing comma.

     Fragments are pushed onto out rather than concatenated, and children are
     emitted between their parent's opening and closing fragments, so the
     recursion writes the markup in document order.

     Every node is <div class="node ..."> wrapping a <div class="line">, and a
     branch adds <div class="kids"> for its children and a <div class="closer">
     for the bracket that follows them. The key or index is repeated in a data
     attribute, which is what page.js reads back to reconstruct a path. */
  function emit(out, node, key, idx, comma) {
    var attrs = key !== null ? ' data-key="' + esc(key) + '"'
      : idx >= 0 ? ' data-index="' + idx + '"' : '';
    /* A member's copy button sits right after its key; an array element or
       the root has no key to sit after, so its button goes at the end. */
    var keyPart = '';
    var endBtn = key === null && idx < 0 ? rootButtons : buttons;   /* unkeyed nodes get theirs at the end of the line */
    if (key !== null) {
      keyPart = '<span class="key">' + esc(quote(key)) + '</span>' + buttons +
        '<span class="pn">: </span>';
      endBtn = '';
    }
    var c = comma ? '<span class="c">,</span>' : '';

    /* A scalar is one line. The empty .sp span aligns it with the branches,
       whose toggle button occupies that space. */
    if (node.t === 'l') {
      out.push('<div class="node leaf"' + attrs + '><div class="line"><span class="sp"></span>' +
        keyPart + node.h + c + endBtn + '</div></div>');
      return;
    }
    var obj = node.t === 'o';
    var open = obj ? '{' : '[';
    var close = obj ? '}' : ']';
    var n = node.v.length;
    /* An empty container has nothing to expand, so it renders as a leaf
       showing both brackets together. */
    if (!n) {
      out.push('<div class="node leaf"' + attrs + '><div class="line"><span class="sp"></span>' +
        keyPart + '<span class="p">' + open + close + '</span>' + c + endBtn + '</div></div>');
      return;
    }
    /* A branch line carries both states: the opening bracket, shown when
       expanded, and a .fold summary ("... 3 items }"), shown when collapsed.
       The stylesheet picks which by the node's collapsed class. */
    var noun = (obj ? 'key' : 'item') + (n === 1 ? '' : 's');
    out.push('<div class="node branch"' + attrs +
      '><div class="line"><button class="toggle" aria-label="Toggle"></button>' +
      keyPart + '<span class="p">' + open + '</span>' +
      '<span class="fold"> &#x2026; ' + n + ' ' + noun + ' <span class="p">' + close + '</span>' +
      c + '</span>' + endBtn + '</div><div class="kids">');
    /* Children carry their own key or index, and every child but the last is
       followed by a comma. */
    for (var j = 0; j < n; j++) {
      emit(out, node.v[j], obj ? node.k[j] : null, obj ? -1 : j, j < n - 1);
    }
    out.push('</div><div class="closer"><span class="p">' + close + '</span>' + c + '</div></div>');
  }


  /* ---- path navigation ---- */

  /* What may appear unquoted in a path segment: anything that is not a
     separator, a quote or whitespace. */
  var pathChar = /[^.[\]"'\s]/;

  /* A key that can be written as .name rather than ["name"]. */
  var identRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /* Writes segments back out as a jq-style path -- the inverse of parsePath,
     and what a copied path looks like. */
  function pathText(segs) {
    var out = '', s, i;
    for (i = 0; i < segs.length; i++) {
      s = segs[i];
      out += s.index !== undefined ? '[' + s.index + ']'
        : identRe.test(s.key) ? '.' + s.key : '[' + JSON.stringify(s.key) + ']';
    }
    if (!out) return '.';                       /* the root itself */
    return out.charAt(0) === '[' ? '.' + out : out;   /* jq writes .[0], not [0] */
  }

  /* parsePath splits a jq-style path such as .a.b[3]["x y"] into key and index
     segments. The leading dot is optional. Returns null for text that is not a
     path.

     Segments are {key: string} or {index: number}. Returning null is how the
     search box decides the text was meant as a filter instead, so anything
     malformed has to fail rather than parse approximately. */
  function parsePath(str) {
    var s = str.trim();
    if (s === '.') return [];        /* the whole document */
    var segs = [], i = 0;
    /* A path may start with a bare key ("a.b" for ".a.b"); read it first so
       the loop below only ever starts at a separator. */
    if (s.charAt(0) !== '.' && s.charAt(0) !== '[') {
      while (i < s.length && pathChar.test(s.charAt(i))) i++;
      if (!i) return null;
      segs.push({ key: s.slice(0, i) });
    }
    while (i < s.length) {
      var c = s.charAt(i), q, j, start;
      if (c === '.') {
        i++;
        /* ".[" is jq's .a.["b"]: the dot is decoration, the bracket carries
           the segment, so hand it to the bracket branch on the next pass. */
        if (s.charAt(i) === '[') continue;
        start = i;
        while (i < s.length && pathChar.test(s.charAt(i))) i++;
        if (i === start) return null;   /* a dot with no name after it */
        segs.push({ key: s.slice(start, i) });
      } else if (c === '[') {
        q = s.charAt(i + 1);
        if (q === '"' || q === "'") {
          /* A quoted key: scan to the matching quote, stepping over
             backslash escapes, and require a "]" right after it. */
          j = i + 2;
          while (j < s.length && s.charAt(j) !== q) j += s.charAt(j) === '\\' ? 2 : 1;
          if (s.charAt(j) !== q || s.charAt(j + 1) !== ']') return null;
          if (q === '"') {
            /* Double quotes are JSON, so JSON.parse handles the escapes --
               and rejects the ones that are not valid JSON. */
            try { segs.push({ key: JSON.parse(s.slice(i + 1, j + 1)) }); }
            catch (e) { return null; }
          } else {
            /* Single quotes are not JSON; only \' and \\ mean anything. */
            segs.push({ key: s.slice(i + 2, j).replace(/\\(['\\])/g, '$1') });
          }
          i = j + 2;
        } else {
          /* An index: whole number, optionally negative to count from the
             end. Anything else in the brackets is not a path. */
          j = s.indexOf(']', i + 1);
          if (j < 0 || !/^-?\d+$/.test(s.slice(i + 1, j))) return null;
          segs.push({ index: parseInt(s.slice(i + 1, j), 10) });
          i = j + 1;
        }
      } else {
        return null;                 /* not a separator: not a path */
      }
    }
    return segs.length ? segs : null;
  }

  return {
    parseJSON: parseJSON,
    leafOf: leafOf,
    stringify: stringify,
    renderTree: renderTree,
    parsePath: parsePath,
    pathText: pathText,
    quote: quote,
    esc: esc
  };
})();

/* Node loads this file directly to test it; browsers use the global above. */
if (typeof module === 'object' && module.exports) module.exports = jqweb;
