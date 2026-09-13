/* The builtins, by name and argument count: map/1 is map with one argument.

   Each takes the input value and the argument expressions, still unrun,
   and returns a stream. An argument is a filter, so a builtin that wants a
   value out of one runs it against the same input. */

import { leafOf, stringify } from '../../model/node.ts';
import { parseJSON } from '../../model/parse.ts';
import { runErr } from './errors.js';
import { ev, push, tick } from './evaluate.js';
import { FORMATS } from './formats.js';
import { captureOne, match, matchOne, one, scanOne, splitOn, substitute,
  testOne, withRe } from './regex.js';
import { broken, parseDate, seconds, strftime } from './time.js';
import { FALSE, NULL, TRUE, add2, arrayOf, chars, cmp, descend, distinct, elem,
  equal, field, iterate, lookup, members, num, objectOf, truthy, typeOf,
  wantType } from './values.js';

/* Runs f once for every output of an argument expression, because jq treats
   a value argument as a stream: has("a","b") answers twice. */
function overArg(arg, x, f) {
  var vals = ev(arg, x), out = [], i;
  for (i = 0; i < vals.length; i++) out.push(f(vals[i]));
  return out;
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

/* Where one value turns up inside another: every offset in a string at which
   a substring starts, every index in an array at which a subsequence starts,
   or every index holding an element equal to a scalar. Matches may overlap,
   as they do in jq, so "aaaa" has "aa" at 0, 1 and 2.

   String offsets count characters. jq counts UTF-8 bytes here, which
   disagrees with its own slices and its own length -- .[index("x"):] cuts in
   the wrong place in jq whenever the text before the match is not all
   ASCII. Counting characters keeps that working. */
function indicesOf(x, want) {
  var tx = typeOf(x), tw = typeOf(want), out = [], cs, ws, i, j;
  if (tx === 'null') return NULL;
  if (tx === 'string') {
    if (tw !== 'string') throw runErr('cannot look for ' + tw + ' in a string');
    ws = chars(want.r);
    cs = chars(x.r);
    for (i = 0; ws.length && i + ws.length <= cs.length; i++) {
      for (j = 0; j < ws.length && cs[i + j] === ws[j]; j++) { /* count the match */ }
      if (j === ws.length) out.push(leafOf(i));
    }
    return arrayOf(out);
  }
  if (tx !== 'array') throw runErr('cannot look inside ' + tx);
  /* An array argument is a run to find, not one element to match, so
     [1,[2],3] holds [[2]] at 1 but does not hold [2] anywhere. */
  if (tw === 'array') {
    for (i = 0; want.v.length && i + want.v.length <= x.v.length; i++) {
      for (j = 0; j < want.v.length && equal(x.v[i + j], want.v[j]); j++) { /* count */ }
      if (j === want.v.length) out.push(leafOf(i));
    }
    return arrayOf(out);
  }
  for (i = 0; i < x.v.length; i++) if (equal(x.v[i], want)) out.push(leafOf(i));
  return arrayOf(out);
}

/* index and rindex are the first and last of those, or null when there are
   none. Nothing is ever found in null, which has no indices at all. */
function endIndex(found, last) {
  if (found.t !== 'a' || !found.v.length) return NULL;
  return last ? found.v[found.v.length - 1] : found.v[0];
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

/* Every path to a value inside a node, deepest last, as jq's paths gives
   them: arrays of keys and indices, and never the empty path for the root. */
function pathsOf(n, at, out, keep) {
  var i, m, here;
  if (n.t === 'a') {
    for (i = 0; i < n.v.length; i++) {
      here = at.concat([leafOf(i)]);
      if (keep(n.v[i])) out.push(arrayOf(here));
      pathsOf(n.v[i], here, out, keep);
    }
  } else if (n.t === 'o') {
    m = members(n);
    for (i = 0; i < m.k.length; i++) {
      here = at.concat([leafOf(m.k[i])]);
      if (keep(m.v[i])) out.push(arrayOf(here));
      pathsOf(m.v[i], here, out, keep);
    }
  }
}

/* Follows a path of keys and indices, giving null where it leads nowhere. */
function atPath(n, path) {
  var i;
  for (i = 0; i < path.length && n; i++) {
    if (n.t === 'l' && n.r === null) return NULL;
    n = lookup(n, path[i]);
  }
  return n || NULL;
}

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

function mathOf(f, name) {
  return function (x) { return [leafOf(f(num(x, name)))]; };
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
  'indices/1': function (x, args) {
    return overArg(args[0], x, function (w) { return indicesOf(x, w); });
  },
  'index/1': function (x, args) {
    return overArg(args[0], x, function (w) { return endIndex(indicesOf(x, w), false); });
  },
  'rindex/1': function (x, args) {
    return overArg(args[0], x, function (w) { return endIndex(indicesOf(x, w), true); });
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

  /* The two-argument forms take a stream rather than the input's own
     members, which is what lets a test reach anywhere in a subtree:
     any(.. | objects; .containerPort? == 80). An empty stream is vacuously
     all and not any, as in jq. */
  'any/2': function (x, args) {
    var vals = ev(args[0], x), r, i, j;
    for (i = 0; i < vals.length; i++) {
      r = ev(args[1], vals[i]);
      for (j = 0; j < r.length; j++) if (truthy(r[j])) return [TRUE];
    }
    return [FALSE];
  },
  'all/2': function (x, args) {
    var vals = ev(args[0], x), r, i, j;
    for (i = 0; i < vals.length; i++) {
      r = ev(args[1], vals[i]);
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
    return [parseJSON(s)];
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
  'values/0': function (x) { return x.t === 'l' && x.r === null ? [] : [x]; },

  'match/1': function (x, a) { return withRe(x, a, 1, matchOne); },
  'match/2': function (x, a) { return withRe(x, a, 2, matchOne); },
  'capture/1': function (x, a) { return withRe(x, a, 1, captureOne); },
  'capture/2': function (x, a) { return withRe(x, a, 2, captureOne); },
  'scan/1': function (x, a) { return withRe(x, a, 1, scanOne); },
  'scan/2': function (x, a) { return withRe(x, a, 2, scanOne); },
  'splits/1': function (x, a) { return withRe(x, a, 1, splitOn); },
  'splits/2': function (x, a) { return withRe(x, a, 2, splitOn); },
  'split/2': function (x, a) { return [arrayOf(withRe(x, a, 2, splitOn))]; },
  'test/1': function (x, a) { return withRe(x, a, 1, testOne); },
  'test/2': function (x, a) { return withRe(x, a, 2, testOne); },
  'sub/2': function (x, a) { return substitute(x, one(a[0], x, 'sub'), a[1], '', false); },
  'sub/3': function (x, a) {
    return substitute(x, one(a[0], x, 'sub'), a[1], one(a[2], x, 'sub'), false);
  },
  'gsub/2': function (x, a) { return substitute(x, one(a[0], x, 'gsub'), a[1], '', true); },
  'gsub/3': function (x, a) {
    return substitute(x, one(a[0], x, 'gsub'), a[1], one(a[2], x, 'gsub'), true);
  },

  'paths/0': function (x) {
    var out = [];
    pathsOf(x, [], out, function () { return true; });
    return out;
  },
  'paths/1': function (x, a) {
    var out = [], kept = [];
    pathsOf(x, [], out, function () { return true; });
    for (var i = 0; i < out.length; i++) {
      var v = atPath(x, out[i].v), r = ev(a[0], v), j;
      for (j = 0; j < r.length; j++) {
        if (truthy(r[j])) { kept.push(out[i]); break; }
      }
    }
    return kept;
  },
  'getpath/1': function (x, a) {
    return overArg(a[0], x, function (p) {
      return atPath(x, wantType(p, 'array', 'getpath').v);
    });
  },

  'walk/1': function (x, a) {
    return [step(x)];

    function step(n) {
      tick();
      var m, i, vals;
      if (n.t === 'a') {
        n = arrayOf(n.v.map(step));
      } else if (n.t === 'o') {
        m = members(n);
        vals = [];
        for (i = 0; i < m.v.length; i++) vals.push(step(m.v[i]));
        n = objectOf(m.k, vals);
      }
      var r = ev(a[0], n);
      return r.length ? r[0] : NULL;
    }
  },

  'while/2': function (x, a) {
    var out = [], at = x, r;
    for (;;) {
      tick();
      r = ev(a[0], at);
      if (!r.length || !truthy(r[0])) return out;
      out.push(at);
      r = ev(a[1], at);
      if (!r.length) return out;
      at = r[0];
    }
  },
  'until/2': function (x, a) {
    var at = x, r;
    for (;;) {
      tick();
      r = ev(a[0], at);
      if (r.length && truthy(r[0])) return [at];
      r = ev(a[1], at);
      if (!r.length) return [at];
      at = r[0];
    }
  },
  'isempty/1': function (x, a) { return [ev(a[0], x).length ? FALSE : TRUE]; },
  'error/0': function (x) {
    throw runErr(typeOf(x) === 'string' ? x.r : stringify(x));
  },
  'error/1': function (x, a) {
    var m = ev(a[0], x);
    throw runErr(!m.length ? 'error' : typeOf(m[0]) === 'string' ? m[0].r : stringify(m[0]));
  },
  'recurse/2': function (x, a) {
    var out = [], stack = [x], next, keep, i, j;
    while (stack.length) {
      tick();
      next = stack.pop();
      out.push(next);
      keep = [];
      next = ev(a[0], next);
      for (i = 0; i < next.length; i++) {
        var c = ev(a[1], next[i]);
        for (j = 0; j < c.length; j++) {
          if (truthy(c[j])) { keep.push(next[i]); break; }
        }
      }
      for (i = keep.length - 1; i >= 0; i--) stack.push(keep[i]);
    }
    return out;
  },

  'explode/0': function (x) {
    return [arrayOf(chars(wantType(x, 'string', 'explode').r)
      .map(function (c) { return leafOf(c.codePointAt(0)); }))];
  },
  'implode/0': function (x) {
    return [leafOf(wantType(x, 'array', 'implode').v
      .map(function (n) { return String.fromCodePoint(num(n, 'implode')); }).join(''))];
  },

  'now/0': function () { return [leafOf(Date.now() / 1000)]; },
  'gmtime/0': function (x) { return [broken(num(x, 'gmtime'))]; },
  'mktime/0': function (x) { return [leafOf(seconds(x, 'mktime'))]; },
  'todate/0': function (x) { return [leafOf(strftime(num(x, 'todate'), '%Y-%m-%dT%H:%M:%SZ'))]; },
  'todateiso8601/0': function (x) {
    return [leafOf(strftime(num(x, 'todateiso8601'), '%Y-%m-%dT%H:%M:%SZ'))];
  },
  'fromdate/0': function (x) { return [leafOf(parseDate(x, 'fromdate'))]; },
  'fromdateiso8601/0': function (x) { return [leafOf(parseDate(x, 'fromdateiso8601'))]; },
  'strftime/1': function (x, a) {
    var secs = seconds(x, 'strftime');
    return overArg(a[0], x, function (f) {
      return leafOf(strftime(secs, wantType(f, 'string', 'strftime').r));
    });
  },
  'pow/2': function (x, a) {
    var b = ev(a[0], x), e = ev(a[1], x), out = [], i, j;
    for (i = 0; i < b.length; i++) {
      for (j = 0; j < e.length; j++) {
        out.push(leafOf(Math.pow(num(b[i], 'pow'), num(e[j], 'pow'))));
      }
    }
    return out;
  },
  'log/0': mathOf(Math.log, 'log'),
  'log2/0': mathOf(Math.log2, 'log2'),
  'log10/0': mathOf(Math.log10, 'log10'),
  'exp/0': mathOf(Math.exp, 'exp'),
  'exp2/0': mathOf(function (n) { return Math.pow(2, n); }, 'exp2'),
  'exp10/0': mathOf(function (n) { return Math.pow(10, n); }, 'exp10'),
  'trunc/0': mathOf(Math.trunc, 'trunc')
};

/* The format strings go in under their own names, since @base64 is a filter
   like any other once the parser has read the "@". */
(function () {
  Object.keys(FORMATS).forEach(function (name) {
    builtins[name + '/0'] = function (x) { return [leafOf(FORMATS[name](x))]; };
  });
})();

export { builtins };
