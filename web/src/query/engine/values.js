/* What the engine knows about a value: its jq type, whether it counts as
   true, how two compare, how to reach inside one, and what the arithmetic
   operators make of two. A value is a node from model/node.ts. */

import { leafOf } from '../../model/node.ts';
import { runErr } from './errors.js';

var NULL = leafOf(null), TRUE = leafOf(true), FALSE = leafOf(false);

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

function wantType(n, t, name) {
  if (typeOf(n) !== t) throw runErr(name + ' needs ' + t + ', not ' + typeOf(n));
  return n;
}

function num(n, name) {
  if (typeOf(n) !== 'number') throw runErr(name + ' needs a number, not ' + typeOf(n));
  return n.r;
}

/* An object with any repeated key collapsed to its last value, which is the
   only shape jq's value model has. */
function distinct(n) {
  var m = members(n);
  return objectOf(m.k, m.v);
}

export { FALSE, NULL, TRUE, add2, arrayOf, chars, cmp, descend, distinct, div2,
  elem, equal, field, iterate, lookup, members, mod2, mul2, num, objectOf,
  slice, sub2, truthy, typeOf, wantType };
