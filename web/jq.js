/* A subset of jq, evaluated in the page against the parsed document.

   The values this works on are the same nodes core.js builds for rendering,
   so a result goes straight to renderTree with object key order and number
   text intact, and the document is parsed once rather than twice. Scalars are
   read from a leaf's r field and built with core's leafOf.

   Every jq expression maps one input to a stream of outputs. Here a stream is
   an array, which makes ",", "[]" and select fall out of the evaluator for
   free; the price is that nothing short-circuits, so a filter over an endless
   stream would not terminate. None of the builtins below produce one.

   What is missing, and rejected by name rather than mis-parsed: variables and
   "as", def, reduce, foreach, assignment, path expressions, string
   interpolation, format strings, and try/catch. Bare "?" is supported.

   Nothing here touches the DOM; page.js drives it. */
var jqjs = (function () {
  'use strict';

  /* core.js is a global in the page and a module under node. */
  var core = typeof jqweb !== 'undefined' ? jqweb : require('./core.js');
  var leafOf = core.leafOf, stringify = core.stringify;

  var NULL = leafOf(null), TRUE = leafOf(true), FALSE = leafOf(false);

  /* Evaluating a query that fans out -- ".. | select(...)" over a large
     document -- can do a lot of work before it produces anything. The counter
     bounds it so a mistyped query reports an error instead of hanging the
     tab. */
  var STEP_LIMIT = 5000000;
  var steps = 0;

  /* ---- errors ----

     kind is 'parse' for a query that does not compile and 'run' for one that
     fails against a value. Only 'run' errors are the ones "?" swallows, and
     only 'parse' errors carry a position to point at. */
  function fail(kind, msg, pos) {
    var e = new Error(msg);
    e.jq = kind;
    e.pos = pos;
    return e;
  }
  function parseErr(msg, pos) { return fail('parse', msg, pos); }
  function runErr(msg) { return fail('run', msg); }

  /* ---- values ---- */

  function arrayOf(list) { return { t: 'a', v: list }; }
  function objectOf(keys, vals) { return { t: 'o', k: keys, v: vals }; }

  /* jq's name for a value's type, which is also what the type builtin
     returns and what the error messages are written in terms of. */
  function typeOf(n) {
    if (n.t === 'o') return 'object';
    if (n.t === 'a') return 'array';
    if (n.r === null) return 'null';
    var t = typeof n.r;
    return t === 'boolean' ? 'boolean' : t === 'number' ? 'number' : 'string';
  }

  /* Only false and null are false; everything else, 0 and "" included, is
     true. */
  function truthy(n) { return !(n.t === 'l' && (n.r === null || n.r === false)); }

  /* The members of an object as unique keys with their values, in document
     order. The document form can hold the same key twice, which jq's value
     model cannot, so the last one wins -- the choice a JSON parser makes. */
  function members(n) {
    var keys = [], vals = [], seen = {}, i, at;
    for (i = 0; i < n.k.length; i++) {
      at = seen['$' + n.k[i]];
      if (at === undefined) {
        seen['$' + n.k[i]] = keys.length;
        keys.push(n.k[i]);
        vals.push(n.v[i]);
      } else {
        vals[at] = n.v[i];
      }
    }
    return { k: keys, v: vals };
  }

  /* The characters of a string as code points. JavaScript strings are UTF-16,
     so an emoji is two units and one character; jq counts characters. */
  function chars(s) { return Array.from(s); }

  /* ---- ordering ----

     jq orders values across types as null < false < true < numbers < strings
     < arrays < objects, and that order is what sort, unique, group_by, min,
     max and the comparison operators all use. */
  var RANK = { 'null': 0, boolean: 1, number: 3, string: 4, array: 5, object: 6 };

  function rank(n) {
    var t = typeOf(n);
    return t === 'boolean' ? (n.r ? 2 : 1) : RANK[t];
  }

  function cmp(a, b) {
    var ra = rank(a), rb = rank(b), i, c;
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ra <= 2) return 0;                       /* null and the booleans */
    if (ra === 3 || ra === 4) return a.r < b.r ? -1 : a.r > b.r ? 1 : 0;
    if (ra === 5) {
      for (i = 0; i < a.v.length && i < b.v.length; i++) {
        c = cmp(a.v[i], b.v[i]);
        if (c) return c;
      }
      return a.v.length === b.v.length ? 0 : a.v.length < b.v.length ? -1 : 1;
    }
    /* Objects compare by their sorted key lists first, and only then by the
       values taken in that order. */
    var ma = members(a), mb = members(b);
    var ka = ma.k.slice().sort(), kb = mb.k.slice().sort();
    c = cmp(arrayOf(ka.map(leafOf)), arrayOf(kb.map(leafOf)));
    if (c) return c;
    for (i = 0; i < ka.length; i++) {
      c = cmp(ma.v[ma.k.indexOf(ka[i])], mb.v[mb.k.indexOf(kb[i])]);
      if (c) return c;
    }
    return 0;
  }

  function equal(a, b) { return cmp(a, b) === 0; }

  /* ---- digging into a value ---- */

  /* One member of an object by name. Missing keys and null both give null,
     which is what makes .a.b.c safe to type at a document you have not read
     yet. */
  function field(n, key) {
    if (n.t === 'o') {
      var i = n.k.lastIndexOf(key);
      return i < 0 ? NULL : n.v[i];
    }
    if (n.t === 'l' && n.r === null) return NULL;
    throw runErr('cannot index ' + typeOf(n) + ' with "' + key + '"');
  }

  /* One element of an array. A negative index counts from the end and a
     fractional one is rounded down, both as in jq; out of range gives null. */
  function elem(n, i) {
    if (n.t === 'a') {
      i = Math.floor(i);
      if (i < 0) i += n.v.length;
      return i < 0 || i >= n.v.length ? NULL : n.v[i];
    }
    if (n.t === 'l' && n.r === null) return NULL;
    throw runErr('cannot index ' + typeOf(n) + ' with a number');
  }

  /* .[i] where i may be either a string or a number, which is how jq writes a
     dynamic lookup. */
  function lookup(n, key) {
    var t = typeOf(key);
    if (t === 'string') return field(n, key.r);
    if (t === 'number') return elem(n, key.r);
    if (t === 'null' && n.t === 'l' && n.r === null) return NULL;
    throw runErr('cannot index ' + typeOf(n) + ' with ' + t);
  }

  function slice(n, from, to) {
    if (n.t === 'l' && n.r === null) return NULL;
    var isStr = n.t === 'l' && typeof n.r === 'string';
    if (n.t !== 'a' && !isStr) throw runErr('cannot slice ' + typeOf(n));
    var cs = isStr ? chars(n.r) : n.v;
    var lo = bound(from, 0, cs.length), hi = bound(to, cs.length, cs.length);
    if (hi < lo) hi = lo;
    return isStr ? leafOf(cs.slice(lo, hi).join('')) : arrayOf(cs.slice(lo, hi));
  }

  /* One end of a slice: absent means the default, negative counts from the
     end, and anything past either end is pulled back to it. */
  function bound(v, dflt, len) {
    if (v === null) return dflt;
    if (typeOf(v) !== 'number') throw runErr('a slice bound must be a number');
    var i = Math.floor(v.r);
    if (i < 0) i += len;
    return i < 0 ? 0 : i > len ? len : i;
  }

  function iterate(n) {
    if (n.t === 'a') return n.v;
    if (n.t === 'o') return members(n).v;
    throw runErr('cannot iterate over ' + typeOf(n));
  }

  /* Every value in a subtree, the value itself first, which is what ".." and
     recurse produce. */
  function descend(n, out) {
    out.push(n);
    if (n.t === 'a' || n.t === 'o') {
      var v = n.t === 'o' ? members(n).v : n.v;
      for (var i = 0; i < v.length; i++) descend(v[i], out);
    }
  }

  /* ---- arithmetic ----

     Each of these takes two values and returns one. What the operators mean
     beyond numbers is jq's: "+" joins strings, arrays and objects, "-"
     removes array elements, "*" merges objects recursively and repeats a
     string, and "/" splits one. */

  function add2(a, b) {
    var ta = typeOf(a), tb = typeOf(b);
    if (ta === 'null') return b;
    if (tb === 'null') return a;
    if (ta === 'number' && tb === 'number') return leafOf(a.r + b.r);
    if (ta === 'string' && tb === 'string') return leafOf(a.r + b.r);
    if (ta === 'array' && tb === 'array') return arrayOf(a.v.concat(b.v));
    if (ta === 'object' && tb === 'object') return merge(a, b, false);
    throw runErr(ta + ' and ' + tb + ' cannot be added');
  }

  function sub2(a, b) {
    var ta = typeOf(a), tb = typeOf(b);
    if (ta === 'number' && tb === 'number') return leafOf(a.r - b.r);
    if (ta === 'array' && tb === 'array') {
      return arrayOf(a.v.filter(function (n) {
        for (var i = 0; i < b.v.length; i++) if (equal(b.v[i], n)) return false;
        return true;
      }));
    }
    throw runErr(ta + ' and ' + tb + ' cannot be subtracted');
  }

  function mul2(a, b) {
    var ta = typeOf(a), tb = typeOf(b);
    if (ta === 'number' && tb === 'number') return leafOf(a.r * b.r);
    if (ta === 'string' && tb === 'number') return repeat(a.r, b.r);
    if (ta === 'number' && tb === 'string') return repeat(b.r, a.r);
    if (ta === 'object' && tb === 'object') return merge(a, b, true);
    throw runErr(ta + ' and ' + tb + ' cannot be multiplied');
  }

  function div2(a, b) {
    var ta = typeOf(a), tb = typeOf(b);
    if (ta === 'number' && tb === 'number') {
      if (b.r === 0) throw runErr('cannot divide by zero');
      return leafOf(a.r / b.r);
    }
    if (ta === 'string' && tb === 'string') return arrayOf(a.r.split(b.r).map(leafOf));
    throw runErr(ta + ' and ' + tb + ' cannot be divided');
  }

  /* jq truncates both sides to integers before taking the remainder, so
     5.9 % 3 is 2, and keeps the sign of the left-hand side. */
  function mod2(a, b) {
    if (typeOf(a) !== 'number' || typeOf(b) !== 'number') {
      throw runErr(typeOf(a) + ' and ' + typeOf(b) + ' cannot be divided');
    }
    var d = Math.trunc(b.r);
    if (d === 0) throw runErr('cannot divide by zero');
    return leafOf(Math.trunc(a.r) % d);
  }

  /* A negative count gives null and a fractional one is rounded down, so
     "ab" * 2.5 is "abab" and "ab" * -1 is null. */
  function repeat(s, n) {
    if (n < 0) return NULL;
    var out = '', i;
    for (i = Math.floor(n); i > 0; i--) out += s;
    return leafOf(out);
  }

  /* Object "+" takes the right-hand value wherever both have a key; object
     "*" merges the two values instead when both are objects. */
  function merge(a, b, deep) {
    var ma = members(a), mb = members(b);
    var keys = ma.k.slice(), vals = ma.v.slice(), i, at;
    for (i = 0; i < mb.k.length; i++) {
      at = keys.indexOf(mb.k[i]);
      if (at < 0) {
        keys.push(mb.k[i]);
        vals.push(mb.v[i]);
      } else {
        vals[at] = deep && vals[at].t === 'o' && mb.v[i].t === 'o'
          ? merge(vals[at], mb.v[i], true) : mb.v[i];
      }
    }
    return objectOf(keys, vals);
  }

  /* ---- reading a query ----

     One pass to tokens, then recursive descent over them. Positions are kept
     on every token so a parse error can point at the offending character. */

  var IDENT_HEAD = /[A-Za-z_]/;
  var IDENT_TAIL = /[A-Za-z0-9_]/;
  var DIGIT = /[0-9]/;

  /* Longest first, so "==" is not read as two "=" and "//" is not read as two
     "/". The ones this subset rejects are still lexed, so that the parser can
     name them instead of stopping at a character it does not recognise. */
  var OPS = ['?//', '==', '!=', '<=', '>=', '//', '|=', '+=', '-=', '*=', '/=',
    '%=', '..', '|', ',', '(', ')', '[', ']', '{', '}', ':', ';', '+', '-',
    '*', '%', '/', '<', '>', '=', '?', '.'];

  var ESCAPES = {
    '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f',
    n: '\n', r: '\r', t: '\t'
  };

  function lex(src) {
    var toks = [], i = 0, c, p, j, buf, d, e, hex, name;
    while (i < src.length) {
      c = src.charAt(i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      /* jq takes "#" to the end of the line as a comment. */
      if (c === '#') {
        while (i < src.length && src.charAt(i) !== '\n') i++;
        continue;
      }
      p = i;
      if (c === '"') {
        j = i + 1;
        buf = '';
        for (;;) {
          if (j >= src.length) throw parseErr('unterminated string', p);
          d = src.charAt(j);
          if (d === '"') { j++; break; }
          if (d !== '\\') { buf += d; j++; continue; }
          e = src.charAt(j + 1);
          if (e === '(') throw parseErr('string interpolation is not supported', j);
          if (ESCAPES[e] !== undefined) { buf += ESCAPES[e]; j += 2; continue; }
          if (e === 'u') {
            hex = src.substr(j + 2, 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw parseErr('bad \\u escape', j);
            buf += String.fromCharCode(parseInt(hex, 16));
            j += 6;
            continue;
          }
          throw parseErr('bad escape "\\' + e + '"', j);
        }
        toks.push({ k: 'str', v: buf, p: p });
        i = j;
        continue;
      }
      if (DIGIT.test(c)) {
        j = i;
        while (j < src.length && DIGIT.test(src.charAt(j))) j++;
        if (src.charAt(j) === '.') {
          j++;
          while (j < src.length && DIGIT.test(src.charAt(j))) j++;
        }
        if (src.charAt(j) === 'e' || src.charAt(j) === 'E') {
          j++;
          if (src.charAt(j) === '+' || src.charAt(j) === '-') j++;
          while (j < src.length && DIGIT.test(src.charAt(j))) j++;
        }
        toks.push({ k: 'num', v: +src.slice(i, j), p: p });
        i = j;
        continue;
      }
      /* ".name" is one token: it is a suffix rather than a "." applied to
         something called name, and keeping it together is what lets the
         parser tell .a.b from a call. */
      if (c === '.' && IDENT_HEAD.test(src.charAt(i + 1))) {
        j = i + 1;
        while (j < src.length && IDENT_TAIL.test(src.charAt(j))) j++;
        toks.push({ k: 'field', v: src.slice(i + 1, j), p: p });
        i = j;
        continue;
      }
      if (IDENT_HEAD.test(c)) {
        j = i;
        while (j < src.length && IDENT_TAIL.test(src.charAt(j))) j++;
        name = src.slice(i, j);
        /* "and" and "or" are written as words but behave as operators, so
           they are lexed as ones and the parser needs no special case. */
        toks.push(name === 'and' || name === 'or'
          ? { k: 'op', v: name, p: p } : { k: 'ident', v: name, p: p });
        i = j;
        continue;
      }
      if (c === '$' || c === '@') {
        j = i + 1;
        while (j < src.length && IDENT_TAIL.test(src.charAt(j))) j++;
        toks.push({ k: c === '$' ? 'var' : 'format', v: src.slice(i, j), p: p });
        i = j;
        continue;
      }
      for (j = 0; j < OPS.length; j++) {
        if (src.substr(i, OPS[j].length) === OPS[j]) break;
      }
      if (j === OPS.length) throw parseErr('unexpected "' + c + '"', p);
      toks.push({ k: 'op', v: OPS[j], p: p });
      i += OPS[j].length;
    }
    toks.push({ k: 'eof', v: '', p: src.length });
    return toks;
  }

  /* Binary operators by binding power, loosest first. Only the pipe is
     right-associative. */
  var BINOPS = [
    { ops: ['|'], right: true },
    { ops: [','] },
    { ops: ['//'] },
    { ops: ['or'] },
    { ops: ['and'] },
    { ops: ['==', '!=', '<', '<=', '>', '>='] },
    { ops: ['+', '-'] },
    { ops: ['*', '/', '%'] }
  ];

  /* The level above the comma, which is where an object member's value is
     parsed: a bare comma there separates members. */
  var OBJ_VALUE_LEVEL = 2;

  /* Syntax this subset leaves out, by the token that gives it away, and what
     to say about it. */
  var MISSING = {
    '=': 'assignment is not supported',
    '|=': 'assignment is not supported',
    '+=': 'assignment is not supported',
    '-=': 'assignment is not supported',
    '*=': 'assignment is not supported',
    '/=': 'assignment is not supported',
    '%=': 'assignment is not supported',
    '?//': 'destructuring is not supported',
    'as': 'variables are not supported',
    'def': 'function definitions are not supported',
    'reduce': 'reduce is not supported',
    'foreach': 'foreach is not supported',
    'try': 'try/catch is not supported, but a trailing "?" is',
    'catch': 'try/catch is not supported, but a trailing "?" is',
    'label': 'labels are not supported',
    'import': 'imports are not supported',
    'include': 'imports are not supported'
  };

  /* Which argument counts each builtin name accepts, worked out once from the
     table below so that a wrong count can say so rather than claim the name
     does not exist. */
  /* "1", "1 or 2", "1, 2 or 3". */
  function orList(ns) {
    var sorted = ns.slice().sort(function (a, b) { return a - b; });
    if (sorted.length < 2) return String(sorted[0]);
    return sorted.slice(0, -1).join(', ') + ' or ' + sorted[sorted.length - 1];
  }

  var arityCache = null;
  function arities() {
    if (!arityCache) {
      arityCache = {};
      for (var key in builtins) {
        var cut = key.lastIndexOf('/');
        var name = key.slice(0, cut);
        if (!arityCache[name]) arityCache[name] = [];
        arityCache[name].push(+key.slice(cut + 1));
      }
    }
    return arityCache;
  }

  function parse(src) {
    var toks = lex(src), at = 0;

    function peek() { return toks[at]; }
    function isOp(v) { return toks[at].k === 'op' && toks[at].v === v; }
    function isWord(v) { return toks[at].k === 'ident' && toks[at].v === v; }
    function eat(v) { return isOp(v) ? (at++, true) : false; }
    function want(v) {
      if (!eat(v)) reject(peek(), 'expected "' + v + '"');
    }
    function wantWord(v) {
      if (!isWord(v)) reject(peek(), 'expected "' + v + '"');
      at++;
    }

    /* Always throws. Syntax this subset leaves out is named, wherever it turns
       up, in preference to the fallback: the query is valid jq and the reader
       wants to know it is the page that is limited, not the query that is
       wrong. */
    function reject(t, fallback) {
      if (t.k === 'var') throw parseErr('variables are not supported', t.p);
      if (t.k === 'format') throw parseErr('format strings are not supported', t.p);
      if ((t.k === 'op' || t.k === 'ident') && MISSING[t.v]) {
        throw parseErr(MISSING[t.v], t.p);
      }
      if (fallback) throw parseErr(fallback, t.p);
      if (t.k === 'eof') throw parseErr('query ends early', t.p);
      throw parseErr('unexpected "' + t.v + '"', t.p);
    }

    function expr(level) {
      if (level === undefined) level = 0;
      if (level >= BINOPS.length) return unary();
      var lhs = expr(level + 1), lv = BINOPS[level], t;
      for (;;) {
        t = peek();
        if (t.k !== 'op' || lv.ops.indexOf(t.v) < 0) return lhs;
        at++;
        lhs = { op: t.v, l: lhs, r: lv.right ? expr(level) : expr(level + 1), p: t.p };
        if (lv.right) return lhs;
      }
    }

    function unary() {
      if (isOp('-')) {
        var p = peek().p;
        at++;
        return { op: 'neg', e: unary(), p: p };
      }
      return postfix(primary());
    }

    /* The suffixes that dig into a value: a field, an index, a slice,
       iteration, and "?" which drops the value instead of failing when it is
       the wrong type. They chain, so .a[0].b? is four of them over the
       identity. */
    function postfix(src) {
      var t, next;
      for (;;) {
        t = peek();
        next = toks[at + 1];
        if (t.k === 'field') {
          at++;
          src = { op: 'field', src: src, name: t.v, p: t.p };
        } else if (t.k === 'op' && t.v === '.' && next.k === 'str') {
          at += 2;
          src = { op: 'field', src: src, name: next.v, p: t.p };
        } else if (t.k === 'op' && t.v === '.' && next.k === 'op' && next.v === '[') {
          /* ".[" is jq's .a.[0]: the dot is decoration and the bracket
             carries the suffix, so hand it on. */
          at++;
        } else if (t.k === 'op' && t.v === '[') {
          src = brackets(src);
        } else if (t.k === 'op' && t.v === '?') {
          at++;
          src = { op: 'opt', e: src, p: t.p };
        } else {
          return src;
        }
      }
    }

    /* [], [e], [a:b], [a:] and [:b] following a value. */
    function brackets(src) {
      var p = peek().p, first, to;
      at++;
      if (eat(']')) return { op: 'iterate', src: src, p: p };
      if (eat(':')) {
        to = expr();
        want(']');
        return { op: 'slice', src: src, from: null, to: to, p: p };
      }
      first = expr();
      if (eat(':')) {
        to = isOp(']') ? null : expr();
        want(']');
        return { op: 'slice', src: src, from: first, to: to, p: p };
      }
      want(']');
      return { op: 'index', src: src, e: first, p: p };
    }

    function primary() {
      var t = peek(), e, args, key;
      if (t.k === 'num' || t.k === 'str') {
        at++;
        return { op: 'lit', n: leafOf(t.v), p: t.p };
      }
      /* A leading ".foo" or ".[0]" is the identity with a suffix, which
         postfix() reads next, so the dot is left where it is. */
      if (t.k === 'field') return { op: '.', p: t.p };
      if (t.k === 'op' && t.v === '.') {
        var after = toks[at + 1];
        if (!(after.k === 'str' || (after.k === 'op' && after.v === '['))) at++;
        return { op: '.', p: t.p };
      }
      if (t.k === 'op' && t.v === '..') { at++; return { op: 'recurse', p: t.p }; }
      if (t.k === 'op' && t.v === '(') {
        at++;
        e = expr();
        want(')');
        return e;
      }
      if (t.k === 'op' && t.v === '[') {
        at++;
        if (eat(']')) return { op: 'array', e: null, p: t.p };
        e = expr();
        want(']');
        return { op: 'array', e: e, p: t.p };
      }
      if (t.k === 'op' && t.v === '{') { at++; return object(t.p); }
      if (t.k === 'ident' && !MISSING[t.v]) {
        if (t.v === 'if') return conditional();
        if (t.v === 'true' || t.v === 'false' || t.v === 'null') {
          at++;
          return { op: 'lit', n: t.v === 'null' ? NULL : t.v === 'true' ? TRUE : FALSE, p: t.p };
        }
        at++;
        args = [];
        if (eat('(')) {
          for (;;) {
            args.push(expr());
            if (!eat(';')) break;
          }
          want(')');
        }
        key = t.v + '/' + args.length;
        if (!builtins[key]) {
          var counts = arities()[t.v];
          if (!counts) throw parseErr(t.v + ' is not a supported filter', t.p);
          throw parseErr(t.v + ' takes ' + orList(counts) +
            (counts.length === 1 && counts[0] === 1 ? ' argument, not ' : ' arguments, not ') +
            args.length, t.p);
        }
        return { op: 'call', key: key, args: args, p: t.p };
      }
      return reject(t);
    }

    /* if A then B elif C then D else E end. jq lets the else be left out, in
       which case a false condition passes the input through unchanged. */
    function conditional() {
      var p = peek().p, cond, yes, no;
      at++;
      cond = expr();
      wantWord('then');
      yes = expr();
      if (isWord('elif')) return { op: 'if', c: cond, t: yes, f: conditional(), p: p };
      if (isWord('else')) { at++; no = expr(); } else { no = { op: '.', p: p }; }
      wantWord('end');
      return { op: 'if', c: cond, t: yes, f: no, p: p };
    }

    /* {a: .x, "b": 1, (.k): 2, c} -- a bare key is shorthand for c: .c. */
    function object(p) {
      var entries = [], t, key, val;
      if (eat('}')) return { op: 'object', entries: entries, p: p };
      for (;;) {
        t = peek();
        if (t.k === 'ident' || t.k === 'str') {
          at++;
          key = { op: 'lit', n: leafOf(t.v), p: t.p };
        } else if (t.k === 'op' && t.v === '(') {
          at++;
          key = expr();
          want(')');
        } else {
          return reject(t);
        }
        if (eat(':')) {
          val = expr(OBJ_VALUE_LEVEL);
        } else if (t.k === 'ident' || t.k === 'str') {
          val = { op: 'field', src: { op: '.', p: t.p }, name: t.v, p: t.p };
        } else {
          throw parseErr('expected ":"', peek().p);
        }
        entries.push({ k: key, v: val });
        if (!eat(',')) break;
      }
      want('}');
      return { op: 'object', entries: entries, p: p };
    }

    if (peek().k === 'eof') throw parseErr('empty query', 0);
    var ast = expr();
    if (peek().k !== 'eof') reject(peek());
    return ast;
  }

  /* The segments of a query that is only a walk down the document, in the
     form parsePath produces, or null for anything else. page.js uses it to
     keep the old behaviour for a pasted path: highlight the node in the
     document rather than replacing the view with a copy of it. */
  function pathSegs(a) {
    var base, v;
    if (a.op === '.') return [];
    if (a.op === 'field') {
      base = pathSegs(a.src);
      return base && base.concat([{ key: a.name }]);
    }
    if (a.op === 'index') {
      v = constant(a.e);
      base = v && pathSegs(a.src);
      if (!base) return null;
      if (typeof v.r === 'string') return base.concat([{ key: v.r }]);
      if (typeof v.r === 'number' && v.r % 1 === 0) return base.concat([{ index: v.r }]);
    }
    return null;
  }

  /* The value a constant expression stands for, or null. A negative index is
     written as a minus over a literal rather than lexed as one, so .a[-1] has
     to be seen through to be recognised as a path. */
  function constant(a) {
    if (a.op === 'lit') return a.n;
    if (a.op === 'neg' && a.e.op === 'lit' && typeof a.e.n.r === 'number') {
      return leafOf(-a.e.n.r);
    }
    return null;
  }

  /* ---- evaluating ---- */

  /* Bounds the work one query may do, so a filter that fans out over a large
     document reports an error instead of hanging the tab. */
  function tick() {
    if (++steps > STEP_LIMIT) throw runErr('query produced too much work');
  }

  /* Appends one stream to another. push.apply would do it in a single call,
     but a stream can be long enough to overflow the argument stack. */
  function push(out, list) {
    for (var i = 0; i < list.length; i++) out.push(list[i]);
  }

  var COMPARE = {
    '==': function (c) { return c === 0; },
    '!=': function (c) { return c !== 0; },
    '<': function (c) { return c < 0; },
    '<=': function (c) { return c <= 0; },
    '>': function (c) { return c > 0; },
    '>=': function (c) { return c >= 0; }
  };
  var ARITH = { '+': add2, '-': sub2, '*': mul2, '/': div2, '%': mod2 };

  /* Runs one expression against one input and returns its stream. */
  function ev(a, x) {
    tick();
    var out, vals, i, j, k, from, to, test;
    switch (a.op) {
      case '.':
        return [x];
      case 'lit':
        return [a.n];
      case 'recurse':
        out = [];
        descend(x, out);
        return out;
      case '|':
        out = [];
        vals = ev(a.l, x);
        for (i = 0; i < vals.length; i++) push(out, ev(a.r, vals[i]));
        return out;
      case ',':
        return ev(a.l, x).concat(ev(a.r, x));
      case '//':
        return alternative(a, x);
      case 'and':
      case 'or':
        return logical(a, x);
      case '==': case '!=': case '<': case '<=': case '>': case '>=':
        test = COMPARE[a.op];
        return pair(a, x, function (l, r) { return test(cmp(l, r)) ? TRUE : FALSE; });
      case '+': case '-': case '*': case '/': case '%':
        return pair(a, x, ARITH[a.op]);
      case 'neg':
        out = [];
        vals = ev(a.e, x);
        for (i = 0; i < vals.length; i++) {
          out.push(leafOf(-num(vals[i], 'negation')));
        }
        return out;
      case 'opt':
        try {
          return ev(a.e, x);
        } catch (e) {
          if (e.jq === 'run') return [];
          throw e;
        }
      case 'field':
        out = [];
        vals = ev(a.src, x);
        for (i = 0; i < vals.length; i++) out.push(field(vals[i], a.name));
        return out;
      case 'index':
        out = [];
        vals = ev(a.src, x);
        to = ev(a.e, x);
        for (i = 0; i < vals.length; i++) {
          for (j = 0; j < to.length; j++) out.push(lookup(vals[i], to[j]));
        }
        return out;
      case 'slice':
        out = [];
        vals = ev(a.src, x);
        from = a.from ? ev(a.from, x) : [null];
        to = a.to ? ev(a.to, x) : [null];
        for (i = 0; i < vals.length; i++) {
          for (j = 0; j < from.length; j++) {
            for (k = 0; k < to.length; k++) out.push(slice(vals[i], from[j], to[k]));
          }
        }
        return out;
      case 'iterate':
        out = [];
        vals = ev(a.src, x);
        for (i = 0; i < vals.length; i++) push(out, iterate(vals[i]));
        return out;
      case 'array':
        return [arrayOf(a.e ? ev(a.e, x) : [])];
      case 'object':
        out = [];
        buildObject(a.entries, 0, [], [], x, out);
        return out;
      case 'if':
        out = [];
        vals = ev(a.c, x);
        for (i = 0; i < vals.length; i++) push(out, ev(truthy(vals[i]) ? a.t : a.f, x));
        return out;
      case 'call':
        return builtins[a.key](x, a.args);
    }
    throw runErr('cannot evaluate ' + a.op);
  }

  /* Applies a two-value operator across both streams. jq runs the right-hand
     one on the outside, so (1,2) + (10,20) gives 11, 12, 21, 22. */
  function pair(a, x, f) {
    var l = ev(a.l, x), r = ev(a.r, x), out = [], i, j;
    for (i = 0; i < r.length; i++) {
      for (j = 0; j < l.length; j++) out.push(f(l[j], r[i]));
    }
    return out;
  }

  /* a // b keeps every truthy output of a, and falls back to b when a
     produced none of them or failed outright. */
  function alternative(a, x) {
    var out = [], vals, i;
    try {
      vals = ev(a.l, x);
      for (i = 0; i < vals.length; i++) if (truthy(vals[i])) out.push(vals[i]);
    } catch (e) {
      if (e.jq !== 'run') throw e;
    }
    return out.length ? out : ev(a.r, x);
  }

  /* and/or stop at the left-hand value when it settles the answer, which
     matters because the right-hand side may well fail on the value that made
     it unnecessary. */
  function logical(a, x) {
    var vals = ev(a.l, x), decided = a.op === 'or', out = [], rest, i, j;
    for (i = 0; i < vals.length; i++) {
      if (truthy(vals[i]) === decided) {
        out.push(decided ? TRUE : FALSE);
        continue;
      }
      rest = ev(a.r, x);
      for (j = 0; j < rest.length; j++) out.push(truthy(rest[j]) ? TRUE : FALSE);
    }
    return out;
  }

  /* Object construction runs each member's key and value as a stream, so
     {a: (1,2)} makes two objects. Members are taken left to right with the
     first on the outside, which is the order jq produces. */
  function buildObject(entries, i, keys, vals, x, out) {
    if (i === entries.length) {
      out.push(distinct(objectOf(keys.slice(), vals.slice())));
      return;
    }
    var ks = ev(entries[i].k, x), vs, j, m;
    for (j = 0; j < ks.length; j++) {
      if (typeOf(ks[j]) !== 'string') {
        throw runErr('an object key must be a string, not ' + typeOf(ks[j]));
      }
      vs = ev(entries[i].v, x);
      for (m = 0; m < vs.length; m++) {
        keys.push(ks[j].r);
        vals.push(vs[m]);
        buildObject(entries, i + 1, keys, vals, x, out);
        keys.pop();
        vals.pop();
      }
    }
  }

  /* ---- builtins ----

     Each takes the input value and the argument expressions, still unrun,
     and returns a stream. An argument is a filter, so a builtin that wants a
     value out of one runs it against the same input. */

  function wantType(n, t, name) {
    if (typeOf(n) !== t) throw runErr(name + ' needs ' + t + ', not ' + typeOf(n));
    return n;
  }

  function num(n, name) {
    if (typeOf(n) !== 'number') throw runErr(name + ' needs a number, not ' + typeOf(n));
    return n.r;
  }

  /* Runs f once for every output of an argument expression, because jq treats
     a value argument as a stream: has("a","b") answers twice. */
  function overArg(arg, x, f) {
    var vals = ev(arg, x), out = [], i;
    for (i = 0; i < vals.length; i++) out.push(f(vals[i]));
    return out;
  }

  /* An object with any repeated key collapsed to its last value, which is the
     only shape jq's value model has. */
  function distinct(n) {
    var m = members(n);
    return objectOf(m.k, m.v);
  }

  function keysOf(n, sorted) {
    var out = [], i;
    if (n.t === 'a') {
      for (i = 0; i < n.v.length; i++) out.push(leafOf(i));
      return arrayOf(out);
    }
    if (n.t === 'o') {
      var k = members(n).k.slice();
      if (sorted) k.sort();
      return arrayOf(k.map(leafOf));
    }
    throw runErr(typeOf(n) + ' has no keys');
  }

  function hasKey(container, key) {
    if (container.t === 'o') {
      return typeOf(key) === 'string' && members(container).k.indexOf(key.r) >= 0;
    }
    if (container.t === 'a') {
      var i = num(key, 'has');
      return i >= 0 && i < container.v.length;
    }
    throw runErr('cannot check whether ' + typeOf(container) + ' has a key');
  }

  /* Pairs each element with the key f gives it, then sorts by that key. The
     keys are worked out once up front rather than on every comparison, and
     the sort is stable, so equal elements keep their order. */
  function keyed(list, arg) {
    var pairs = list.map(function (n) { return { n: n, k: arrayOf(ev(arg, n)) }; });
    pairs.sort(function (p, q) { return cmp(p.k, q.k); });
    return pairs;
  }

  /* Runs of equal keys in a sorted pairing, which is what group_by returns
     and what unique_by picks the first of. */
  function runsOf(pairs) {
    var out = [], i;
    for (i = 0; i < pairs.length; i++) {
      if (i && cmp(pairs[i - 1].k, pairs[i].k) === 0) out[out.length - 1].push(pairs[i].n);
      else out.push([pairs[i].n]);
    }
    return out;
  }

  function flattenInto(list, depth, out) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].t === 'a' && depth > 0) flattenInto(list[i].v, depth - 1, out);
      else out.push(list[i]);
    }
  }

  /* range over every combination of its arguments, as jq does. A zero step
     would never reach the end, so it produces nothing rather than hanging. */
  function rangeOf(froms, tos, bys) {
    var out = [], i, j, k, from, to, by, v;
    for (i = 0; i < froms.length; i++) {
      for (j = 0; j < tos.length; j++) {
        for (k = 0; k < bys.length; k++) {
          from = num(froms[i], 'range');
          to = num(tos[j], 'range');
          by = num(bys[k], 'range');
          if (by === 0) continue;
          for (v = from; by > 0 ? v < to : v > to; v += by) {
            tick();
            out.push(leafOf(v));
          }
        }
      }
    }
    return out;
  }

  /* jq's regular expressions are Oniguruma and these are JavaScript's, which
     agree on ordinary patterns and part ways in the corners. Only the flags
     with a JavaScript equivalent are accepted. */
  var RE_FLAGS = 'gimsuy';

  function regex(pattern, flags) {
    var i;
    for (i = 0; i < flags.length; i++) {
      if (RE_FLAGS.indexOf(flags.charAt(i)) < 0) {
        throw runErr('unsupported regex flag "' + flags.charAt(i) + '"');
      }
    }
    try {
      return new RegExp(pattern, flags);
    } catch (e) {
      throw runErr('bad regular expression: ' + e.message);
    }
  }

  /* jq's containment: a string contains a substring, an array contains
     another when every element of the second is contained in some element of
     the first, and an object when every member of the second is contained in
     the member of the first with that key. */
  function containsIn(a, b) {
    var ta = typeOf(a), tb = typeOf(b), i, j, ok, mb;
    if (ta === 'object' && tb === 'object') {
      mb = members(b);
      for (i = 0; i < mb.k.length; i++) {
        if (!containsIn(field(a, mb.k[i]), mb.v[i])) return false;
      }
      return true;
    }
    if (ta === 'array' && tb === 'array') {
      for (i = 0; i < b.v.length; i++) {
        ok = false;
        for (j = 0; j < a.v.length && !ok; j++) ok = containsIn(a.v[j], b.v[i]);
        if (!ok) return false;
      }
      return true;
    }
    if (ta === 'string' && tb === 'string') return a.r.indexOf(b.r) >= 0;
    if (ta !== tb) throw runErr(ta + ' and ' + tb + ' cannot be checked for containment');
    return equal(a, b);
  }

  /* The names from_entries accepts for the key and the value of an entry. A
     key falls through to the next spelling when it is null or false; a value
     does not, so an entry may hold a null on purpose. */
  var ENTRY_KEYS = ['name', 'Name', 'key', 'Key'];
  var ENTRY_VALUES = ['value', 'Value'];

  function entryKey(e) {
    var at, i;
    for (i = 0; i < ENTRY_KEYS.length; i++) {
      at = e.k.lastIndexOf(ENTRY_KEYS[i]);
      if (at >= 0 && truthy(e.v[at])) return e.v[at];
    }
    return NULL;
  }

  function entryValue(e) {
    var at, i;
    for (i = 0; i < ENTRY_VALUES.length; i++) {
      at = e.k.lastIndexOf(ENTRY_VALUES[i]);
      if (at >= 0) return e.v[at];
    }
    return NULL;
  }

  /* select(type == "...") under the shorter name jq gives it. */
  function typeFilter(t) {
    return function (x) { return typeOf(x) === t ? [x] : []; };
  }

  function mathFilter(f) {
    return function (x) { return [leafOf(f(num(x, 'a number filter')))]; };
  }

  var builtins = {
    'empty/0': function () { return []; },
    'not/0': function (x) { return [truthy(x) ? FALSE : TRUE]; },
    'type/0': function (x) { return [leafOf(typeOf(x))]; },

    'select/1': function (x, args) {
      var vals = ev(args[0], x), out = [], i;
      for (i = 0; i < vals.length; i++) if (truthy(vals[i])) out.push(x);
      return out;
    },

    'recurse/0': function (x) {
      var out = [];
      descend(x, out);
      return out;
    },
    /* Depth first over an explicit stack rather than the JavaScript one,
       because a filter with no end -- recurse(. + 1) -- would overflow that
       long before the step limit could report it. */
    'recurse/1': function (x, args) {
      var out = [], stack = [x], next, i;
      while (stack.length) {
        tick();
        next = stack.pop();
        out.push(next);
        next = ev(args[0], next);
        /* Reversed, so that the first output is the next one taken. */
        for (i = next.length - 1; i >= 0; i--) stack.push(next[i]);
      }
      return out;
    },

    'map/1': function (x, args) {
      var vals = iterate(x), out = [], i;
      for (i = 0; i < vals.length; i++) push(out, ev(args[0], vals[i]));
      return [arrayOf(out)];
    },

    /* A member whose filter produces nothing is dropped, which is how
       map_values(empty) deletes every one of them. */
    'map_values/1': function (x, args) {
      var keys = [], vals = [], r, i, m;
      if (x.t === 'a') {
        for (i = 0; i < x.v.length; i++) {
          r = ev(args[0], x.v[i]);
          if (r.length) vals.push(r[0]);
        }
        return [arrayOf(vals)];
      }
      m = members(wantType(x, 'object', 'map_values'));
      for (i = 0; i < m.k.length; i++) {
        r = ev(args[0], m.v[i]);
        if (r.length) {
          keys.push(m.k[i]);
          vals.push(r[0]);
        }
      }
      return [objectOf(keys, vals)];
    },

    'length/0': function (x) {
      var t = typeOf(x);
      if (t === 'null') return [leafOf(0)];
      if (t === 'boolean') throw runErr('boolean has no length');
      if (t === 'number') return [leafOf(Math.abs(x.r))];
      if (t === 'string') return [leafOf(chars(x.r).length)];
      return [leafOf(t === 'object' ? members(x).k.length : x.v.length)];
    },

    'keys/0': function (x) { return [keysOf(x, true)]; },
    'keys_unsorted/0': function (x) { return [keysOf(x, false)]; },

    'has/1': function (x, args) {
      return overArg(args[0], x, function (k) { return hasKey(x, k) ? TRUE : FALSE; });
    },
    'in/1': function (x, args) {
      return overArg(args[0], x, function (c) { return hasKey(c, x) ? TRUE : FALSE; });
    },
    'contains/1': function (x, args) {
      return overArg(args[0], x, function (b) { return containsIn(x, b) ? TRUE : FALSE; });
    },
    'inside/1': function (x, args) {
      return overArg(args[0], x, function (b) { return containsIn(b, x) ? TRUE : FALSE; });
    },

    'to_entries/0': function (x) {
      var m = members(wantType(x, 'object', 'to_entries')), out = [], i;
      for (i = 0; i < m.k.length; i++) {
        out.push(objectOf(['key', 'value'], [leafOf(m.k[i]), m.v[i]]));
      }
      return [arrayOf(out)];
    },
    'from_entries/0': function (x) {
      var list = wantType(x, 'array', 'from_entries').v;
      var keys = [], vals = [], e, k, i;
      for (i = 0; i < list.length; i++) {
        e = list[i];
        k = e.t === 'o' ? entryKey(e) : e;
        vals.push(e.t === 'o' ? entryValue(e) : NULL);
        keys.push(typeOf(k) === 'string' ? k.r : stringify(k));
      }
      return [distinct(objectOf(keys, vals))];
    },
    'with_entries/1': function (x, args) {
      var entries = builtins['to_entries/0'](x)[0], out = [], i;
      for (i = 0; i < entries.v.length; i++) push(out, ev(args[0], entries.v[i]));
      return builtins['from_entries/0'](arrayOf(out));
    },

    'add/0': function (x) {
      var vals = iterate(x), acc = NULL, i;
      for (i = 0; i < vals.length; i++) acc = add2(acc, vals[i]);
      return [acc];
    },

    'any/0': function (x) {
      var vals = iterate(x), i;
      for (i = 0; i < vals.length; i++) if (truthy(vals[i])) return [TRUE];
      return [FALSE];
    },
    'all/0': function (x) {
      var vals = iterate(x), i;
      for (i = 0; i < vals.length; i++) if (!truthy(vals[i])) return [FALSE];
      return [TRUE];
    },
    'any/1': function (x, args) {
      var vals = iterate(x), r, i, j;
      for (i = 0; i < vals.length; i++) {
        r = ev(args[0], vals[i]);
        for (j = 0; j < r.length; j++) if (truthy(r[j])) return [TRUE];
      }
      return [FALSE];
    },
    'all/1': function (x, args) {
      var vals = iterate(x), r, i, j;
      for (i = 0; i < vals.length; i++) {
        r = ev(args[0], vals[i]);
        for (j = 0; j < r.length; j++) if (!truthy(r[j])) return [FALSE];
      }
      return [TRUE];
    },

    'min/0': function (x) { return [pick(wantType(x, 'array', 'min').v, null, -1)]; },
    'max/0': function (x) { return [pick(wantType(x, 'array', 'max').v, null, 1)]; },
    'min_by/1': function (x, args) { return [pick(wantType(x, 'array', 'min_by').v, args[0], -1)]; },
    'max_by/1': function (x, args) { return [pick(wantType(x, 'array', 'max_by').v, args[0], 1)]; },

    'sort/0': function (x) {
      return [arrayOf(wantType(x, 'array', 'sort').v.slice().sort(cmp))];
    },
    'sort_by/1': function (x, args) {
      var pairs = keyed(wantType(x, 'array', 'sort_by').v, args[0]);
      return [arrayOf(pairs.map(function (p) { return p.n; }))];
    },
    'group_by/1': function (x, args) {
      var runs = runsOf(keyed(wantType(x, 'array', 'group_by').v, args[0]));
      return [arrayOf(runs.map(arrayOf))];
    },
    'unique/0': function (x) {
      var sorted = wantType(x, 'array', 'unique').v.slice().sort(cmp), out = [], i;
      for (i = 0; i < sorted.length; i++) {
        if (!i || cmp(sorted[i - 1], sorted[i]) !== 0) out.push(sorted[i]);
      }
      return [arrayOf(out)];
    },
    'unique_by/1': function (x, args) {
      var runs = runsOf(keyed(wantType(x, 'array', 'unique_by').v, args[0]));
      return [arrayOf(runs.map(function (r) { return r[0]; }))];
    },

    'reverse/0': function (x) {
      if (typeOf(x) === 'string') return [leafOf(chars(x.r).reverse().join(''))];
      if (typeOf(x) === 'null') return [arrayOf([])];
      return [arrayOf(wantType(x, 'array', 'reverse').v.slice().reverse())];
    },

    'flatten/0': function (x) {
      var out = [];
      flattenInto(wantType(x, 'array', 'flatten').v, Infinity, out);
      return [arrayOf(out)];
    },
    'flatten/1': function (x, args) {
      return overArg(args[0], x, function (d) {
        var depth = num(d, 'flatten'), out = [];
        if (depth < 0) throw runErr('flatten needs a depth of 0 or more');
        flattenInto(wantType(x, 'array', 'flatten').v, depth, out);
        return arrayOf(out);
      });
    },

    'first/0': function (x) { return [elem(wantType(x, 'array', 'first'), 0)]; },
    'last/0': function (x) { return [elem(wantType(x, 'array', 'last'), -1)]; },
    'first/1': function (x, args) {
      var vals = ev(args[0], x);
      return vals.length ? [vals[0]] : [];
    },
    'last/1': function (x, args) {
      var vals = ev(args[0], x);
      return vals.length ? [vals[vals.length - 1]] : [];
    },
    /* Nothing here produces an endless stream, so taking the first n of a
       stream already built is the same answer jq's lazy limit gives. */
    'limit/2': function (x, args) {
      var out = [], counts = ev(args[0], x), vals, n, i;
      for (i = 0; i < counts.length; i++) {
        n = Math.floor(num(counts[i], 'limit'));
        if (n <= 0) continue;
        vals = ev(args[1], x);
        push(out, vals.slice(0, n));
      }
      return out;
    },

    'range/1': function (x, args) { return rangeOf([leafOf(0)], ev(args[0], x), [leafOf(1)]); },
    'range/2': function (x, args) { return rangeOf(ev(args[0], x), ev(args[1], x), [leafOf(1)]); },
    'range/3': function (x, args) { return rangeOf(ev(args[0], x), ev(args[1], x), ev(args[2], x)); },

    'join/1': function (x, args) {
      var list = wantType(x, 'array', 'join').v;
      return overArg(args[0], x, function (sep) {
        var parts = [], t, i;
        for (i = 0; i < list.length; i++) {
          t = typeOf(list[i]);
          if (t === 'null') parts.push('');
          else if (t === 'string') parts.push(list[i].r);
          else if (t === 'number' || t === 'boolean') parts.push(stringify(list[i]));
          else throw runErr('cannot join ' + t + ' elements');
        }
        return leafOf(parts.join(typeOf(sep) === 'string' ? sep.r : stringify(sep)));
      });
    },
    'split/1': function (x, args) {
      var s = wantType(x, 'string', 'split').r;
      return overArg(args[0], x, function (sep) {
        return arrayOf(s.split(wantType(sep, 'string', 'split').r).map(leafOf));
      });
    },

    'test/1': function (x, args) { return match(x, args[0], null); },
    'test/2': function (x, args) { return match(x, args[0], args[1]); },

    'startswith/1': function (x, args) {
      var s = wantType(x, 'string', 'startswith').r;
      return overArg(args[0], x, function (p) {
        return s.lastIndexOf(wantType(p, 'string', 'startswith').r, 0) === 0 ? TRUE : FALSE;
      });
    },
    'endswith/1': function (x, args) {
      var s = wantType(x, 'string', 'endswith').r;
      return overArg(args[0], x, function (p) {
        var t = wantType(p, 'string', 'endswith').r;
        return s.length >= t.length && s.indexOf(t, s.length - t.length) >= 0 ? TRUE : FALSE;
      });
    },
    'ltrimstr/1': function (x, args) {
      return overArg(args[0], x, function (p) {
        if (typeOf(x) !== 'string' || typeOf(p) !== 'string') return x;
        return x.r.lastIndexOf(p.r, 0) === 0 ? leafOf(x.r.slice(p.r.length)) : x;
      });
    },
    'rtrimstr/1': function (x, args) {
      return overArg(args[0], x, function (p) {
        if (typeOf(x) !== 'string' || typeOf(p) !== 'string') return x;
        var at = x.r.length - p.r.length;
        return at >= 0 && x.r.indexOf(p.r, at) === at ? leafOf(x.r.slice(0, at)) : x;
      });
    },
    'ascii_downcase/0': function (x) {
      return [leafOf(wantType(x, 'string', 'ascii_downcase').r.replace(/[A-Z]/g, lower))];
    },
    'ascii_upcase/0': function (x) {
      return [leafOf(wantType(x, 'string', 'ascii_upcase').r.replace(/[a-z]/g, upper))];
    },

    'tostring/0': function (x) {
      return [typeOf(x) === 'string' ? x : leafOf(stringify(x))];
    },
    'tonumber/0': function (x) {
      if (typeOf(x) === 'number') return [x];
      var n = +wantType(x, 'string', 'tonumber').r;
      if (x.r.trim() === '' || isNaN(n)) throw runErr('cannot parse "' + x.r + '" as a number');
      return [leafOf(n)];
    },
    'tojson/0': function (x) { return [leafOf(stringify(x))]; },
    'fromjson/0': function (x) {
      var s = wantType(x, 'string', 'fromjson').r;
      try {
        JSON.parse(s);
      } catch (e) {
        throw runErr('cannot parse "' + s + '" as JSON');
      }
      return [core.parseJSON(s)];
    },

    'floor/0': mathFilter(Math.floor),
    'ceil/0': mathFilter(Math.ceil),
    'round/0': mathFilter(Math.round),
    'fabs/0': mathFilter(Math.abs),
    'sqrt/0': mathFilter(Math.sqrt),

    'arrays/0': typeFilter('array'),
    'objects/0': typeFilter('object'),
    'booleans/0': typeFilter('boolean'),
    'numbers/0': typeFilter('number'),
    'strings/0': typeFilter('string'),
    'nulls/0': typeFilter('null'),
    'iterables/0': function (x) { return x.t === 'a' || x.t === 'o' ? [x] : []; },
    'scalars/0': function (x) { return x.t === 'l' ? [x] : []; },
    'values/0': function (x) { return x.t === 'l' && x.r === null ? [] : [x]; }
  };

  function lower(c) { return c.toLowerCase(); }
  function upper(c) { return c.toUpperCase(); }

  /* The smallest or largest element by jq's ordering, or by the key arg gives
     each one. An empty array has neither, so it gives null. A tie goes to the
     first element for min and the last for max, as in jq. */
  function pick(list, arg, want) {
    var best = null, bestKey = null, key, c, i;
    for (i = 0; i < list.length; i++) {
      key = arg ? arrayOf(ev(arg, list[i])) : list[i];
      if (best === null) {
        best = list[i];
        bestKey = key;
        continue;
      }
      c = cmp(key, bestKey);
      if (want > 0 ? c >= 0 : c < 0) {
        best = list[i];
        bestKey = key;
      }
    }
    return best === null ? NULL : best;
  }

  function match(x, patArg, flagArg) {
    var s = wantType(x, 'string', 'test').r;
    var pats = ev(patArg, x), flags = flagArg ? ev(flagArg, x) : [leafOf('')];
    var out = [], i, j;
    for (i = 0; i < flags.length; i++) {
      for (j = 0; j < pats.length; j++) {
        out.push(regex(wantType(pats[j], 'string', 'test').r,
          wantType(flags[i], 'string', 'test').r).test(s) ? TRUE : FALSE);
      }
    }
    return out;
  }

  /* ---- entry point ---- */

  /* Compiles a query. Throws a parse error, with a pos, for anything that is
     not one. The result's path is the segment list for a query that only
     walks down the document, and null otherwise. */
  function compile(src) {
    var ast = parse(src);
    return {
      path: pathSegs(ast),
      run: function (input) {
        steps = 0;
        return ev(ast, input);
      }
    };
  }

  return { compile: compile };
})();

/* Node loads this file directly to test it; browsers use the global above. */
if (typeof module === 'object' && module.exports) module.exports = jqjs;
