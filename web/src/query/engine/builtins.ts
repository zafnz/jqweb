/* The builtins, by name and argument count: map/1 is map with one argument.

   Each takes the input value and the argument expressions, still unrun,
   and returns a stream. An argument is a filter, so a builtin that wants a
   value out of one runs it against the same input. */

import { leafOf, stringify } from '../../model/node.ts';
import type { ArrayNode, Node, ObjectNode } from '../../model/node.ts';
import { NestingError } from '../../model/nesting.ts';
import { parseJSON } from '../../model/parse.ts';
import { runErr } from './errors.ts';
import { ev, push, tick } from './evaluate.ts';
import type { Builtin, Stream } from './evaluate.ts';
import { FORMATS } from './formats.ts';
import type { Ast } from './parser.ts';
import { captureOne, matchOne, one, scanOne, splitOn, substitute, testOne,
  withRe } from './regex.ts';
import { broken, parseDate, seconds, strftime } from './time.ts';
import { FALSE, NULL, TRUE, add2, arrayOf, chars, cmp, descend, distinct, elem,
  equal, field, is, iterate, lookup, members, num, objectOf, truthy, typeOf,
  wantType } from './values.ts';
import type { JqType } from './values.ts';

/* Runs f once for every output of an argument expression, because jq treats
   a value argument as a stream: has("a","b") answers twice. */
function overArg(arg: Ast, x: Node, f: (v: Node) => Node): Stream {
  const vals = ev(arg, x);
  const out: Stream = [];
  for (let i = 0; i < vals.length; i++) out.push(f(vals[i]));
  return out;
}

function keysOf(n: Node, sorted: boolean): ArrayNode {
  if (n.t === 'a') {
    const out: Node[] = [];
    for (let i = 0; i < n.v.length; i++) out.push(leafOf(i));
    return arrayOf(out);
  }
  if (n.t === 'o') {
    const k = members(n).k.slice();
    if (sorted) k.sort();
    return arrayOf(k.map(leafOf));
  }
  throw runErr(typeOf(n) + ' has no keys');
}

function hasKey(container: Node, key: Node): boolean {
  if (container.t === 'o') {
    return is(key, 'string') && members(container).k.indexOf(key.r) >= 0;
  }
  if (container.t === 'a') {
    const i = num(key, 'has');
    return i >= 0 && i < container.v.length;
  }
  throw runErr('cannot check whether ' + typeOf(container) + ' has a key');
}

/* An element with the key it sorts by. */
interface Keyed {
  n: Node;
  k: ArrayNode;
}

/* Pairs each element with the key f gives it, then sorts by that key. The
   keys are worked out once up front rather than on every comparison, and
   the sort is stable, so equal elements keep their order. */
function keyed(list: Node[], arg: Ast): Keyed[] {
  const pairs = list.map(function (n) { return { n: n, k: arrayOf(ev(arg, n)) }; });
  pairs.sort(function (p, q) { return cmp(p.k, q.k); });
  return pairs;
}

/* Runs of equal keys in a sorted pairing, which is what group_by returns
   and what unique_by picks the first of. */
function runsOf(pairs: Keyed[]): Node[][] {
  const out: Node[][] = [];
  for (let i = 0; i < pairs.length; i++) {
    if (i && cmp(pairs[i - 1].k, pairs[i].k) === 0) out[out.length - 1].push(pairs[i].n);
    else out.push([pairs[i].n]);
  }
  return out;
}

function flattenInto(list: Node[], depth: number, out: Node[]): void {
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.t === 'a' && depth > 0) flattenInto(n.v, depth - 1, out);
    else out.push(n);
  }
}

/* range over every combination of its arguments, as jq does. A zero step
   would never reach the end, so it produces nothing rather than hanging. */
function rangeOf(froms: Node[], tos: Node[], bys: Node[]): Stream {
  const out: Stream = [];
  for (let i = 0; i < froms.length; i++) {
    for (let j = 0; j < tos.length; j++) {
      for (let k = 0; k < bys.length; k++) {
        const from = num(froms[i], 'range');
        const to = num(tos[j], 'range');
        const by = num(bys[k], 'range');
        if (by === 0) continue;
        for (let v = from; by > 0 ? v < to : v > to; v += by) {
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
function containsIn(a: Node, b: Node): boolean {
  if (a.t === 'o' && b.t === 'o') {
    const mb = members(b);
    for (let i = 0; i < mb.k.length; i++) {
      if (!containsIn(field(a, mb.k[i]), mb.v[i])) return false;
    }
    return true;
  }
  if (a.t === 'a' && b.t === 'a') {
    for (let i = 0; i < b.v.length; i++) {
      let ok = false;
      for (let j = 0; j < a.v.length && !ok; j++) ok = containsIn(a.v[j], b.v[i]);
      if (!ok) return false;
    }
    return true;
  }
  if (is(a, 'string') && is(b, 'string')) return a.r.indexOf(b.r) >= 0;
  const ta = typeOf(a);
  const tb = typeOf(b);
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
function indicesOf(x: Node, want: Node): Node {
  const out: Node[] = [];
  if (is(x, 'null')) return NULL;
  if (is(x, 'string')) {
    if (!is(want, 'string')) throw runErr('cannot look for ' + typeOf(want) + ' in a string');
    const ws = chars(want.r);
    const cs = chars(x.r);
    for (let i = 0; ws.length && i + ws.length <= cs.length; i++) {
      let j = 0;
      for (; j < ws.length && cs[i + j] === ws[j]; j++) { /* count the match */ }
      if (j === ws.length) out.push(leafOf(i));
    }
    return arrayOf(out);
  }
  if (x.t !== 'a') throw runErr('cannot look inside ' + typeOf(x));
  /* An array argument is a run to find, not one element to match, so
     [1,[2],3] holds [[2]] at 1 but does not hold [2] anywhere. */
  if (want.t === 'a') {
    for (let i = 0; want.v.length && i + want.v.length <= x.v.length; i++) {
      let j = 0;
      for (; j < want.v.length && equal(x.v[i + j], want.v[j]); j++) { /* count */ }
      if (j === want.v.length) out.push(leafOf(i));
    }
    return arrayOf(out);
  }
  for (let i = 0; i < x.v.length; i++) if (equal(x.v[i], want)) out.push(leafOf(i));
  return arrayOf(out);
}

/* index and rindex are the first and last of those, or null when there are
   none. Nothing is ever found in null, which has no indices at all. */
function endIndex(found: Node, last: boolean): Node {
  if (found.t !== 'a' || !found.v.length) return NULL;
  return last ? found.v[found.v.length - 1] : found.v[0];
}

/* The names from_entries accepts for the key and the value of an entry. A
   key falls through to the next spelling when it is null or false; a value
   does not, so an entry may hold a null on purpose. */
const ENTRY_KEYS = ['name', 'Name', 'key', 'Key'];
const ENTRY_VALUES = ['value', 'Value'];

function entryKey(e: ObjectNode): Node {
  for (let i = 0; i < ENTRY_KEYS.length; i++) {
    const at = e.k.lastIndexOf(ENTRY_KEYS[i]);
    if (at >= 0 && truthy(e.v[at])) return e.v[at];
  }
  return NULL;
}

function entryValue(e: ObjectNode): Node {
  for (let i = 0; i < ENTRY_VALUES.length; i++) {
    const at = e.k.lastIndexOf(ENTRY_VALUES[i]);
    if (at >= 0) return e.v[at];
  }
  return NULL;
}

function toEntries(x: Node): ArrayNode {
  const m = members(wantType(x, 'object', 'to_entries'));
  const out: Node[] = [];
  for (let i = 0; i < m.k.length; i++) {
    out.push(objectOf(['key', 'value'], [leafOf(m.k[i]), m.v[i]]));
  }
  return arrayOf(out);
}

function fromEntries(x: Node): ObjectNode {
  const list = wantType(x, 'array', 'from_entries').v;
  const keys: string[] = [];
  const vals: Node[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const k = e.t === 'o' ? entryKey(e) : e;
    vals.push(e.t === 'o' ? entryValue(e) : NULL);
    keys.push(is(k, 'string') ? k.r : stringify(k));
  }
  return distinct(objectOf(keys, vals));
}

/* Every path to a value inside a node, deepest last, as jq's paths gives
   them: arrays of keys and indices, and never the empty path for the root. */
function pathsOf(n: Node, at: Node[], out: ArrayNode[], keep: (v: Node) => boolean): void {
  if (n.t === 'a') {
    for (let i = 0; i < n.v.length; i++) {
      const here = at.concat([leafOf(i)]);
      if (keep(n.v[i])) out.push(arrayOf(here));
      pathsOf(n.v[i], here, out, keep);
    }
  } else if (n.t === 'o') {
    const m = members(n);
    for (let i = 0; i < m.k.length; i++) {
      const here = at.concat([leafOf(m.k[i])]);
      if (keep(m.v[i])) out.push(arrayOf(here));
      pathsOf(m.v[i], here, out, keep);
    }
  }
}

/* Follows a path of keys and indices, giving null where it leads nowhere. */
function atPath(n: Node, path: Node[]): Node {
  for (let i = 0; i < path.length && n; i++) {
    if (n.t === 'l' && n.r === null) return NULL;
    n = lookup(n, path[i]);
  }
  return n || NULL;
}

function lower(c: string): string { return c.toLowerCase(); }
function upper(c: string): string { return c.toUpperCase(); }

/* The smallest or largest element by jq's ordering, or by the key arg gives
   each one. An empty array has neither, so it gives null. A tie goes to the
   first element for min and the last for max, as in jq. */
function pick(list: Node[], arg: Ast | null, want: number): Node {
  let best: Node | null = null;
  let bestKey: Node | null = null;
  for (let i = 0; i < list.length; i++) {
    const key = arg ? arrayOf(ev(arg, list[i])) : list[i];
    if (best === null || bestKey === null) {
      best = list[i];
      bestKey = key;
      continue;
    }
    const c = cmp(key, bestKey);
    if (want > 0 ? c >= 0 : c < 0) {
      best = list[i];
      bestKey = key;
    }
  }
  return best === null ? NULL : best;
}

/* A builtin that maps one number to another; name is for its error message. */
function mathOf(f: (n: number) => number, name: string): Builtin {
  return function (x) { return [leafOf(f(num(x, name)))]; };
}

/* select(type == "...") under the shorter name jq gives it. */
function typeFilter(t: JqType): Builtin {
  return function (x) { return typeOf(x) === t ? [x] : []; };
}

export const builtins: Record<string, Builtin> = {
  'empty/0': function () { return []; },
  'not/0': function (x) { return [truthy(x) ? FALSE : TRUE]; },
  'type/0': function (x) { return [leafOf(typeOf(x))]; },

  'select/1': function (x, args) {
    const vals = ev(args[0], x);
    const out: Stream = [];
    for (let i = 0; i < vals.length; i++) if (truthy(vals[i])) out.push(x);
    return out;
  },

  'recurse/0': function (x) {
    const out: Stream = [];
    descend(x, out);
    return out;
  },
  /* Depth first over an explicit stack rather than the JavaScript one,
     because a filter with no end -- recurse(. + 1) -- would overflow that
     long before the step limit could report it. */
  'recurse/1': function (x, args) {
    const out: Stream = [];
    const stack: Node[] = [x];
    let top: Node | undefined;
    while ((top = stack.pop()) !== undefined) {
      tick();
      out.push(top);
      const next = ev(args[0], top);
      /* Reversed, so that the first output is the next one taken. */
      for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
    }
    return out;
  },

  'map/1': function (x, args) {
    const vals = iterate(x);
    const out: Stream = [];
    for (let i = 0; i < vals.length; i++) push(out, ev(args[0], vals[i]));
    return [arrayOf(out)];
  },

  /* A member whose filter produces nothing is dropped, which is how
     map_values(empty) deletes every one of them. */
  'map_values/1': function (x, args) {
    const keys: string[] = [];
    const vals: Node[] = [];
    if (x.t === 'a') {
      for (let i = 0; i < x.v.length; i++) {
        const r = ev(args[0], x.v[i]);
        if (r.length) vals.push(r[0]);
      }
      return [arrayOf(vals)];
    }
    const m = members(wantType(x, 'object', 'map_values'));
    for (let i = 0; i < m.k.length; i++) {
      const r = ev(args[0], m.v[i]);
      if (r.length) {
        keys.push(m.k[i]);
        vals.push(r[0]);
      }
    }
    return [objectOf(keys, vals)];
  },

  'length/0': function (x) {
    if (x.t === 'o') return [leafOf(members(x).k.length)];
    if (x.t === 'a') return [leafOf(x.v.length)];
    if (is(x, 'number')) return [leafOf(Math.abs(x.r))];
    if (is(x, 'string')) return [leafOf(chars(x.r).length)];
    if (is(x, 'boolean')) throw runErr('boolean has no length');
    return [leafOf(0)];
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

  'to_entries/0': function (x) { return [toEntries(x)]; },
  'from_entries/0': function (x) { return [fromEntries(x)]; },
  'with_entries/1': function (x, args) {
    const entries = toEntries(x);
    const out: Stream = [];
    for (let i = 0; i < entries.v.length; i++) push(out, ev(args[0], entries.v[i]));
    return [fromEntries(arrayOf(out))];
  },

  'add/0': function (x) {
    const vals = iterate(x);
    let acc: Node = NULL;
    for (let i = 0; i < vals.length; i++) acc = add2(acc, vals[i]);
    return [acc];
  },

  'any/0': function (x) {
    const vals = iterate(x);
    for (let i = 0; i < vals.length; i++) if (truthy(vals[i])) return [TRUE];
    return [FALSE];
  },
  'all/0': function (x) {
    const vals = iterate(x);
    for (let i = 0; i < vals.length; i++) if (!truthy(vals[i])) return [FALSE];
    return [TRUE];
  },
  'any/1': function (x, args) {
    const vals = iterate(x);
    for (let i = 0; i < vals.length; i++) {
      const r = ev(args[0], vals[i]);
      for (let j = 0; j < r.length; j++) if (truthy(r[j])) return [TRUE];
    }
    return [FALSE];
  },
  'all/1': function (x, args) {
    const vals = iterate(x);
    for (let i = 0; i < vals.length; i++) {
      const r = ev(args[0], vals[i]);
      for (let j = 0; j < r.length; j++) if (!truthy(r[j])) return [FALSE];
    }
    return [TRUE];
  },

  /* The two-argument forms take a stream rather than the input's own
     members, which is what lets a test reach anywhere in a subtree:
     any(.. | objects; .containerPort? == 80). An empty stream is vacuously
     all and not any, as in jq. */
  'any/2': function (x, args) {
    const vals = ev(args[0], x);
    for (let i = 0; i < vals.length; i++) {
      const r = ev(args[1], vals[i]);
      for (let j = 0; j < r.length; j++) if (truthy(r[j])) return [TRUE];
    }
    return [FALSE];
  },
  'all/2': function (x, args) {
    const vals = ev(args[0], x);
    for (let i = 0; i < vals.length; i++) {
      const r = ev(args[1], vals[i]);
      for (let j = 0; j < r.length; j++) if (!truthy(r[j])) return [FALSE];
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
    const pairs = keyed(wantType(x, 'array', 'sort_by').v, args[0]);
    return [arrayOf(pairs.map(function (p) { return p.n; }))];
  },
  'group_by/1': function (x, args) {
    const runs = runsOf(keyed(wantType(x, 'array', 'group_by').v, args[0]));
    return [arrayOf(runs.map(arrayOf))];
  },
  'unique/0': function (x) {
    const sorted = wantType(x, 'array', 'unique').v.slice().sort(cmp);
    const out: Node[] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (!i || cmp(sorted[i - 1], sorted[i]) !== 0) out.push(sorted[i]);
    }
    return [arrayOf(out)];
  },
  'unique_by/1': function (x, args) {
    const runs = runsOf(keyed(wantType(x, 'array', 'unique_by').v, args[0]));
    return [arrayOf(runs.map(function (r) { return r[0]; }))];
  },

  'reverse/0': function (x) {
    if (is(x, 'string')) return [leafOf(chars(x.r).reverse().join(''))];
    if (is(x, 'null')) return [arrayOf([])];
    return [arrayOf(wantType(x, 'array', 'reverse').v.slice().reverse())];
  },

  'flatten/0': function (x) {
    const out: Node[] = [];
    flattenInto(wantType(x, 'array', 'flatten').v, Infinity, out);
    return [arrayOf(out)];
  },
  'flatten/1': function (x, args) {
    return overArg(args[0], x, function (d) {
      const depth = num(d, 'flatten');
      const out: Node[] = [];
      if (depth < 0) throw runErr('flatten needs a depth of 0 or more');
      flattenInto(wantType(x, 'array', 'flatten').v, depth, out);
      return arrayOf(out);
    });
  },

  'first/0': function (x) { return [elem(wantType(x, 'array', 'first'), 0)]; },
  'last/0': function (x) { return [elem(wantType(x, 'array', 'last'), -1)]; },
  'first/1': function (x, args) {
    const vals = ev(args[0], x);
    return vals.length ? [vals[0]] : [];
  },
  'last/1': function (x, args) {
    const vals = ev(args[0], x);
    return vals.length ? [vals[vals.length - 1]] : [];
  },
  /* Nothing here produces an endless stream, so taking the first n of a
     stream already built is the same answer jq's lazy limit gives. */
  'limit/2': function (x, args) {
    const out: Stream = [];
    const counts = ev(args[0], x);
    for (let i = 0; i < counts.length; i++) {
      const n = Math.floor(num(counts[i], 'limit'));
      if (n <= 0) continue;
      const vals = ev(args[1], x);
      push(out, vals.slice(0, n));
    }
    return out;
  },

  'range/1': function (x, args) { return rangeOf([leafOf(0)], ev(args[0], x), [leafOf(1)]); },
  'range/2': function (x, args) { return rangeOf(ev(args[0], x), ev(args[1], x), [leafOf(1)]); },
  'range/3': function (x, args) { return rangeOf(ev(args[0], x), ev(args[1], x), ev(args[2], x)); },

  'join/1': function (x, args) {
    const list = wantType(x, 'array', 'join').v;
    return overArg(args[0], x, function (sep) {
      const parts: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        const t = typeOf(v);
        if (t === 'null') parts.push('');
        else if (is(v, 'string')) parts.push(v.r);
        else if (t === 'number' || t === 'boolean') parts.push(stringify(v));
        else throw runErr('cannot join ' + t + ' elements');
      }
      return leafOf(parts.join(is(sep, 'string') ? sep.r : stringify(sep)));
    });
  },
  'split/1': function (x, args) {
    const s = wantType(x, 'string', 'split').r;
    return overArg(args[0], x, function (sep) {
      return arrayOf(s.split(wantType(sep, 'string', 'split').r).map(leafOf));
    });
  },

  'startswith/1': function (x, args) {
    const s = wantType(x, 'string', 'startswith').r;
    return overArg(args[0], x, function (p) {
      return s.lastIndexOf(wantType(p, 'string', 'startswith').r, 0) === 0 ? TRUE : FALSE;
    });
  },
  'endswith/1': function (x, args) {
    const s = wantType(x, 'string', 'endswith').r;
    return overArg(args[0], x, function (p) {
      const t = wantType(p, 'string', 'endswith').r;
      return s.length >= t.length && s.indexOf(t, s.length - t.length) >= 0 ? TRUE : FALSE;
    });
  },
  'ltrimstr/1': function (x, args) {
    return overArg(args[0], x, function (p) {
      if (!is(x, 'string') || !is(p, 'string')) return x;
      return x.r.lastIndexOf(p.r, 0) === 0 ? leafOf(x.r.slice(p.r.length)) : x;
    });
  },
  'rtrimstr/1': function (x, args) {
    return overArg(args[0], x, function (p) {
      if (!is(x, 'string') || !is(p, 'string')) return x;
      const at = x.r.length - p.r.length;
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
    return [is(x, 'string') ? x : leafOf(stringify(x))];
  },
  'tonumber/0': function (x) {
    if (is(x, 'number')) return [x];
    const s = wantType(x, 'string', 'tonumber').r;
    const n = +s;
    if (s.trim() === '' || isNaN(n)) throw runErr('cannot parse "' + s + '" as a number');
    return [leafOf(n)];
  },
  'tojson/0': function (x) { return [leafOf(stringify(x))]; },
  /* JSON.parse is the syntax check and parseJSON the parse. parseJSON keeps
     key order and number text, and its string scanner never ends
     on text with no closing quote, so it only sees what JSON.parse accepted. */
  'fromjson/0': function (x) {
    const s = wantType(x, 'string', 'fromjson').r;
    try {
      JSON.parse(s);
    } catch {
      throw runErr('cannot parse "' + s + '" as JSON');
    }
    try {
      return [parseJSON(s)];
    } catch (e) {
      if (e instanceof NestingError) throw runErr(e.message);
      throw e;
    }
  },

  'floor/0': mathOf(Math.floor, 'floor'),
  'ceil/0': mathOf(Math.ceil, 'ceil'),
  'round/0': mathOf(Math.round, 'round'),
  'fabs/0': mathOf(Math.abs, 'fabs'),
  'sqrt/0': mathOf(Math.sqrt, 'sqrt'),

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
    const out: ArrayNode[] = [];
    pathsOf(x, [], out, function () { return true; });
    return out;
  },
  'paths/1': function (x, a) {
    const out: ArrayNode[] = [];
    const kept: Stream = [];
    pathsOf(x, [], out, function () { return true; });
    for (let i = 0; i < out.length; i++) {
      const v = atPath(x, out[i].v);
      const r = ev(a[0], v);
      for (let j = 0; j < r.length; j++) {
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

    function step(n: Node): Node {
      tick();
      if (n.t === 'a') {
        n = arrayOf(n.v.map(step));
      } else if (n.t === 'o') {
        const m = members(n);
        const vals: Node[] = [];
        for (let i = 0; i < m.v.length; i++) vals.push(step(m.v[i]));
        n = objectOf(m.k, vals);
      }
      const r = ev(a[0], n);
      return r.length ? r[0] : NULL;
    }
  },

  'while/2': function (x, a) {
    const out: Stream = [];
    let at = x;
    for (;;) {
      tick();
      let r = ev(a[0], at);
      if (!r.length || !truthy(r[0])) return out;
      out.push(at);
      r = ev(a[1], at);
      if (!r.length) return out;
      at = r[0];
    }
  },
  'until/2': function (x, a) {
    let at = x;
    for (;;) {
      tick();
      let r = ev(a[0], at);
      if (r.length && truthy(r[0])) return [at];
      r = ev(a[1], at);
      if (!r.length) return [at];
      at = r[0];
    }
  },
  'isempty/1': function (x, a) { return [ev(a[0], x).length ? FALSE : TRUE]; },
  'error/0': function (x) {
    throw runErr(is(x, 'string') ? x.r : stringify(x));
  },
  'error/1': function (x, a) {
    const m = ev(a[0], x);
    const first = m[0];
    throw runErr(!m.length ? 'error' : is(first, 'string') ? first.r : stringify(first));
  },
  'recurse/2': function (x, a) {
    const out: Stream = [];
    const stack: Node[] = [x];
    let top: Node | undefined;
    while ((top = stack.pop()) !== undefined) {
      tick();
      out.push(top);
      const keep: Node[] = [];
      const next = ev(a[0], top);
      for (let i = 0; i < next.length; i++) {
        const c = ev(a[1], next[i]);
        for (let j = 0; j < c.length; j++) {
          if (truthy(c[j])) { keep.push(next[i]); break; }
        }
      }
      for (let i = keep.length - 1; i >= 0; i--) stack.push(keep[i]);
    }
    return out;
  },

  'explode/0': function (x) {
    return [arrayOf(chars(wantType(x, 'string', 'explode').r)
      .map(function (c) { return leafOf(c.codePointAt(0)!); }))];
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
    const secs = seconds(x, 'strftime');
    return overArg(a[0], x, function (f) {
      return leafOf(strftime(secs, wantType(f, 'string', 'strftime').r));
    });
  },
  'pow/2': function (x, a) {
    const b = ev(a[0], x);
    const e = ev(a[1], x);
    const out: Stream = [];
    for (let i = 0; i < b.length; i++) {
      for (let j = 0; j < e.length; j++) {
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
Object.keys(FORMATS).forEach(function (name) {
  builtins[name + '/0'] = function (x) { return [leafOf(FORMATS[name](x))]; };
});
