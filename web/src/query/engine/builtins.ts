/* The builtins, by name and argument count: map/1 is map with one argument.

   Each takes the input value, the argument expressions still unrun, and the
   sink to send each output to. An argument is a filter, so a builtin that
   wants a value out of one runs it against the same input. */

import { leafOf, stringify } from '../../model/node.ts';
import type { ArrayNode, Node, ObjectNode } from '../../model/node.ts';
import { NestingError } from '../../model/nesting.ts';
import { parseJSON } from '../../model/parse.ts';
import { runErr } from './errors.ts';
import { collect, ev, evUntil, firstOf, some, stopping, tick } from './evaluate.ts';
import type { Builtin, Emit } from './evaluate.ts';
import { FORMATS } from './formats.ts';
import type { Ast } from './parser.ts';
import { captureOne, matchOne, scanOne, splitOn, substitute, testOne,
  withRe } from './regex.ts';
import { broken, parseDate, seconds, strftime } from './time.ts';
import { FALSE, NULL, TRUE, add2, arrayOf, chars, cmp, descend, distinct, elem,
  equal, field, is, iterate, lookup, members, num, objectOf, truthy, typeOf,
  wantType } from './values.ts';
import type { JqType } from './values.ts';

/* Emits f of every output of an argument expression, because jq treats a
   value argument as a stream: has("a","b") answers twice. */
function overArg(arg: Ast, x: Node, emit: Emit, f: (v: Node) => Node): void {
  ev(arg, x, function (v) { emit(f(v)); });
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
  const pairs = list.map(function (n) { return { n: n, k: arrayOf(collect(arg, n)) }; });
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

/* range over every combination of its arguments, the first on the outside,
   as jq does. A zero step would never reach the end, so it produces nothing
   rather than hanging. */
function rangeOf(from: Ast | null, to: Ast, by: Ast | null, x: Node, emit: Emit): void {
  argOrOne(from, x, 0, function (lo) {
    ev(to, x, function (hi) {
      argOrOne(by, x, 1, function (step) {
        const f = num(lo, 'range');
        const t = num(hi, 'range');
        const b = num(step, 'range');
        if (b === 0) return;
        for (let v = f; b > 0 ? v < t : v > t; v += b) {
          tick();
          emit(leafOf(v));
        }
      });
    });
  });
}

/* An argument that a shorter form of a builtin leaves out, standing for the
   one value dflt. */
function argOrOne(a: Ast | null, x: Node, dflt: number, f: (n: Node) => void): void {
  if (a) ev(a, x, f);
  else f(leafOf(dflt));
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
   them: arrays of keys and indices, and never the empty path for the root.
   keep is asked about each value with its path, and says whether to emit
   it. */
function pathsOf(n: Node, at: Node[], keep: (v: Node, path: ArrayNode) => void): void {
  if (n.t === 'a') {
    for (let i = 0; i < n.v.length; i++) {
      const here = at.concat([leafOf(i)]);
      keep(n.v[i], arrayOf(here));
      pathsOf(n.v[i], here, keep);
    }
  } else if (n.t === 'o') {
    const m = members(n);
    for (let i = 0; i < m.k.length; i++) {
      const here = at.concat([leafOf(m.k[i])]);
      keep(m.v[i], arrayOf(here));
      pathsOf(m.v[i], here, keep);
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
    const key = arg ? arrayOf(collect(arg, list[i])) : list[i];
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

/* Whether any member of a value satisfies f. */
function anyMember(x: Node, f: (n: Node) => boolean): boolean {
  const vals = iterate(x);
  for (let i = 0; i < vals.length; i++) if (f(vals[i])) return true;
  return false;
}

function falsy(n: Node): boolean { return !truthy(n); }

/* while and until, which jq defines as

       def while(cond; update): def _while: if cond then ., (update | _while) else empty end; _while;
       def until(cond; update): def _until: if cond then . else (update | _until) end; _until;

   so every output of cond is a branch, and every output of update is
   followed. The recursion is over an explicit stack rather than the
   JavaScript one, since a loop of a hundred thousand steps is nothing
   unusual. A task is a value to test, or one to emit. */
interface LoopTask {
  v: Node;
  done: boolean;
}

function loop(x: Node, a: Ast[], emit: Emit, isWhile: boolean): void {
  const stack: LoopTask[] = [{ v: x, done: false }];
  let t: LoopTask | undefined;
  while ((t = stack.pop()) !== undefined) {
    tick();
    if (t.done) {
      emit(t.v);
      continue;
    }
    const v = t.v;
    const next: LoopTask[] = [];
    ev(a[0], v, function (c) {
      const go = truthy(c);
      if (go) next.push({ v: v, done: true });
      if (go === isWhile) {
        ev(a[1], v, function (u) { next.push({ v: u, done: false }); });
      }
    });
    /* Reversed, so that the first is the next one taken. */
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
  }
}

/* recurse(f) and recurse(f; cond), which jq defines as

       def recurse(f): def r: ., (f | r); r;
       def recurse(f; cond): def r: ., (f | select(cond) | r); r;

   Depth first over an explicit stack rather than the JavaScript one,
   because a filter with no end -- recurse(. + 1) -- would overflow that
   long before the step limit could report it. */
function recurseWith(x: Node, f: Ast, cond: Ast | null, emit: Emit): void {
  const stack: Node[] = [x];
  let top: Node | undefined;
  while ((top = stack.pop()) !== undefined) {
    tick();
    emit(top);
    const next: Node[] = [];
    ev(f, top, function (n) {
      if (!cond) {
        next.push(n);
        return;
      }
      /* select emits its input once for every truthy output of cond. */
      ev(cond, n, function (c) { if (truthy(c)) next.push(n); });
    });
    /* Reversed, so that the first output is the next one taken. */
    for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
  }
}

/* A builtin that maps one number to another; name is for its error message. */
function mathOf(f: (n: number) => number, name: string): Builtin {
  return function (x, _a, emit) { emit(leafOf(f(num(x, name)))); };
}

/* select(type == "...") under the shorter name jq gives it. */
function typeFilter(t: JqType): Builtin {
  return function (x, _a, emit) { if (typeOf(x) === t) emit(x); };
}

export const builtins: Record<string, Builtin> = {
  'empty/0': function () { /* nothing */ },
  'not/0': function (x, _a, emit) { emit(truthy(x) ? FALSE : TRUE); },
  'type/0': function (x, _a, emit) { emit(leafOf(typeOf(x))); },

  /* The input, once for every truthy output of the condition. */
  'select/1': function (x, a, emit) {
    ev(a[0], x, function (c) { if (truthy(c)) emit(x); });
  },

  'recurse/0': function (x, _a, emit) { descend(x, emit); },
  'recurse/1': function (x, a, emit) { recurseWith(x, a[0], null, emit); },
  'recurse/2': function (x, a, emit) { recurseWith(x, a[0], a[1], emit); },

  'map/1': function (x, a, emit) {
    const vals = iterate(x);
    const out: Node[] = [];
    for (let i = 0; i < vals.length; i++) {
      ev(a[0], vals[i], function (v) { out.push(v); });
    }
    emit(arrayOf(out));
  },

  /* A member takes the first output of its filter, and one whose filter
     produces nothing is dropped, which is how map_values(empty) deletes
     every one of them. */
  'map_values/1': function (x, a, emit) {
    const keys: string[] = [];
    const vals: Node[] = [];
    if (x.t === 'a') {
      for (let i = 0; i < x.v.length; i++) {
        const r = firstOf(a[0], x.v[i]);
        if (r !== undefined) vals.push(r);
      }
      emit(arrayOf(vals));
      return;
    }
    const m = members(wantType(x, 'object', 'map_values'));
    for (let i = 0; i < m.k.length; i++) {
      const r = firstOf(a[0], m.v[i]);
      if (r !== undefined) {
        keys.push(m.k[i]);
        vals.push(r);
      }
    }
    emit(objectOf(keys, vals));
  },

  'length/0': function (x, _a, emit) {
    if (x.t === 'o') emit(leafOf(members(x).k.length));
    else if (x.t === 'a') emit(leafOf(x.v.length));
    else if (is(x, 'number')) emit(leafOf(Math.abs(x.r)));
    else if (is(x, 'string')) emit(leafOf(chars(x.r).length));
    else if (is(x, 'boolean')) throw runErr('boolean has no length');
    else emit(leafOf(0));
  },

  'keys/0': function (x, _a, emit) { emit(keysOf(x, true)); },
  'keys_unsorted/0': function (x, _a, emit) { emit(keysOf(x, false)); },

  'has/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (k) { return hasKey(x, k) ? TRUE : FALSE; });
  },
  'in/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (c) { return hasKey(c, x) ? TRUE : FALSE; });
  },
  'indices/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (w) { return indicesOf(x, w); });
  },
  'index/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (w) { return endIndex(indicesOf(x, w), false); });
  },
  'rindex/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (w) { return endIndex(indicesOf(x, w), true); });
  },
  'contains/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (b) { return containsIn(x, b) ? TRUE : FALSE; });
  },
  'inside/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (b) { return containsIn(b, x) ? TRUE : FALSE; });
  },

  'to_entries/0': function (x, _a, emit) { emit(toEntries(x)); },
  'from_entries/0': function (x, _a, emit) { emit(fromEntries(x)); },
  'with_entries/1': function (x, a, emit) {
    const entries = toEntries(x);
    const out: Node[] = [];
    for (let i = 0; i < entries.v.length; i++) {
      ev(a[0], entries.v[i], function (e) { out.push(e); });
    }
    emit(fromEntries(arrayOf(out)));
  },

  'add/0': function (x, _a, emit) {
    const vals = iterate(x);
    let acc: Node = NULL;
    for (let i = 0; i < vals.length; i++) acc = add2(acc, vals[i]);
    emit(acc);
  },

  /* Each of these stops at the first value that settles the answer, so a
     later one that would fail is never reached. An empty stream is
     vacuously all and not any, as in jq. */
  'any/0': function (x, _a, emit) { emit(anyMember(x, truthy) ? TRUE : FALSE); },
  'all/0': function (x, _a, emit) { emit(anyMember(x, falsy) ? FALSE : TRUE); },
  'any/1': function (x, a, emit) {
    emit(anyMember(x, function (v) { return some(a[0], v, truthy); }) ? TRUE : FALSE);
  },
  'all/1': function (x, a, emit) {
    emit(anyMember(x, function (v) { return some(a[0], v, falsy); }) ? FALSE : TRUE);
  },
  /* The two-argument forms take a stream rather than the input's own
     members, which is what lets a test reach anywhere in a subtree:
     any(.. | objects; .containerPort? == 80). */
  'any/2': function (x, a, emit) {
    emit(some(a[0], x, function (v) { return some(a[1], v, truthy); }) ? TRUE : FALSE);
  },
  'all/2': function (x, a, emit) {
    emit(some(a[0], x, function (v) { return some(a[1], v, falsy); }) ? FALSE : TRUE);
  },

  'min/0': function (x, _a, emit) { emit(pick(wantType(x, 'array', 'min').v, null, -1)); },
  'max/0': function (x, _a, emit) { emit(pick(wantType(x, 'array', 'max').v, null, 1)); },
  'min_by/1': function (x, a, emit) { emit(pick(wantType(x, 'array', 'min_by').v, a[0], -1)); },
  'max_by/1': function (x, a, emit) { emit(pick(wantType(x, 'array', 'max_by').v, a[0], 1)); },

  'sort/0': function (x, _a, emit) {
    emit(arrayOf(wantType(x, 'array', 'sort').v.slice().sort(cmp)));
  },
  'sort_by/1': function (x, a, emit) {
    const pairs = keyed(wantType(x, 'array', 'sort_by').v, a[0]);
    emit(arrayOf(pairs.map(function (p) { return p.n; })));
  },
  'group_by/1': function (x, a, emit) {
    const runs = runsOf(keyed(wantType(x, 'array', 'group_by').v, a[0]));
    emit(arrayOf(runs.map(arrayOf)));
  },
  'unique/0': function (x, _a, emit) {
    const sorted = wantType(x, 'array', 'unique').v.slice().sort(cmp);
    const out: Node[] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (!i || cmp(sorted[i - 1], sorted[i]) !== 0) out.push(sorted[i]);
    }
    emit(arrayOf(out));
  },
  'unique_by/1': function (x, a, emit) {
    const runs = runsOf(keyed(wantType(x, 'array', 'unique_by').v, a[0]));
    emit(arrayOf(runs.map(function (r) { return r[0]; })));
  },

  'reverse/0': function (x, _a, emit) {
    if (is(x, 'string')) emit(leafOf(chars(x.r).reverse().join('')));
    else if (is(x, 'null')) emit(arrayOf([]));
    else emit(arrayOf(wantType(x, 'array', 'reverse').v.slice().reverse()));
  },

  'flatten/0': function (x, _a, emit) {
    const out: Node[] = [];
    flattenInto(wantType(x, 'array', 'flatten').v, Infinity, out);
    emit(arrayOf(out));
  },
  'flatten/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (d) {
      const depth = num(d, 'flatten');
      const out: Node[] = [];
      if (depth < 0) throw runErr('flatten needs a depth of 0 or more');
      flattenInto(wantType(x, 'array', 'flatten').v, depth, out);
      return arrayOf(out);
    });
  },

  'first/0': function (x, _a, emit) { emit(elem(wantType(x, 'array', 'first'), 0)); },
  'last/0': function (x, _a, emit) { emit(elem(wantType(x, 'array', 'last'), -1)); },
  /* The stream is stopped after its first output, so first(1, error) is 1. */
  'first/1': function (x, a, emit) {
    evUntil(a[0], x, function (v) { emit(v); return true; });
  },
  'last/1': function (x, a, emit) {
    const vals = collect(a[0], x);
    if (vals.length) emit(vals[vals.length - 1]);
  },
  /* jq 1.7 takes the whole stream for a negative count and stops once the
     count is reached, so a count of 1.8 gives two. */
  'limit/2': function (x, a, emit) {
    ev(a[0], x, function (count) {
      const n = num(count, 'limit');
      if (n < 0) {
        ev(a[1], x, emit);
        return;
      }
      if (n === 0) return;
      let seen = 0;
      evUntil(a[1], x, function (v) { emit(v); return ++seen >= n; });
    });
  },

  'range/1': function (x, a, emit) { rangeOf(null, a[0], null, x, emit); },
  'range/2': function (x, a, emit) { rangeOf(a[0], a[1], null, x, emit); },
  'range/3': function (x, a, emit) { rangeOf(a[0], a[1], a[2], x, emit); },

  'join/1': function (x, a, emit) {
    const list = wantType(x, 'array', 'join').v;
    overArg(a[0], x, emit, function (sep) {
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
  'split/1': function (x, a, emit) {
    const s = wantType(x, 'string', 'split').r;
    overArg(a[0], x, emit, function (sep) {
      return arrayOf(s.split(wantType(sep, 'string', 'split').r).map(leafOf));
    });
  },

  'startswith/1': function (x, a, emit) {
    const s = wantType(x, 'string', 'startswith').r;
    overArg(a[0], x, emit, function (p) {
      return s.lastIndexOf(wantType(p, 'string', 'startswith').r, 0) === 0 ? TRUE : FALSE;
    });
  },
  'endswith/1': function (x, a, emit) {
    const s = wantType(x, 'string', 'endswith').r;
    overArg(a[0], x, emit, function (p) {
      const t = wantType(p, 'string', 'endswith').r;
      return s.length >= t.length && s.indexOf(t, s.length - t.length) >= 0 ? TRUE : FALSE;
    });
  },
  'ltrimstr/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (p) {
      if (!is(x, 'string') || !is(p, 'string')) return x;
      return x.r.lastIndexOf(p.r, 0) === 0 ? leafOf(x.r.slice(p.r.length)) : x;
    });
  },
  'rtrimstr/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (p) {
      if (!is(x, 'string') || !is(p, 'string')) return x;
      const at = x.r.length - p.r.length;
      return at >= 0 && x.r.indexOf(p.r, at) === at ? leafOf(x.r.slice(0, at)) : x;
    });
  },
  'ascii_downcase/0': function (x, _a, emit) {
    emit(leafOf(wantType(x, 'string', 'ascii_downcase').r.replace(/[A-Z]/g, lower)));
  },
  'ascii_upcase/0': function (x, _a, emit) {
    emit(leafOf(wantType(x, 'string', 'ascii_upcase').r.replace(/[a-z]/g, upper)));
  },

  'tostring/0': function (x, _a, emit) {
    emit(is(x, 'string') ? x : leafOf(stringify(x)));
  },
  'tonumber/0': function (x, _a, emit) {
    if (is(x, 'number')) {
      emit(x);
      return;
    }
    const s = wantType(x, 'string', 'tonumber').r;
    const n = +s;
    if (s.trim() === '' || isNaN(n)) throw runErr('cannot parse "' + s + '" as a number');
    emit(leafOf(n));
  },
  'tojson/0': function (x, _a, emit) { emit(leafOf(stringify(x))); },
  /* JSON.parse is the syntax check and parseJSON the parse. parseJSON keeps
     key order and number text, and its string scanner never ends
     on text with no closing quote, so it only sees what JSON.parse accepted. */
  'fromjson/0': function (x, _a, emit) {
    const s = wantType(x, 'string', 'fromjson').r;
    try {
      JSON.parse(s);
    } catch {
      throw runErr('cannot parse "' + s + '" as JSON');
    }
    try {
      emit(parseJSON(s));
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
  'iterables/0': function (x, _a, emit) { if (x.t === 'a' || x.t === 'o') emit(x); },
  'scalars/0': function (x, _a, emit) { if (x.t === 'l') emit(x); },
  'values/0': function (x, _a, emit) { if (!(x.t === 'l' && x.r === null)) emit(x); },

  'match/1': function (x, a, emit) { withRe(x, a, 1, matchOne, emit); },
  'match/2': function (x, a, emit) { withRe(x, a, 2, matchOne, emit); },
  'capture/1': function (x, a, emit) { withRe(x, a, 1, captureOne, emit); },
  'capture/2': function (x, a, emit) { withRe(x, a, 2, captureOne, emit); },
  'scan/1': function (x, a, emit) { withRe(x, a, 1, scanOne, emit); },
  'scan/2': function (x, a, emit) { withRe(x, a, 2, scanOne, emit); },
  'splits/1': function (x, a, emit) { withRe(x, a, 1, splitOn, emit); },
  'splits/2': function (x, a, emit) { withRe(x, a, 2, splitOn, emit); },
  'split/2': function (x, a, emit) {
    withRe(x, a, 2, function (s, pattern, flags, out) {
      const parts: Node[] = [];
      splitOn(s, pattern, flags, function (p) { parts.push(p); });
      out(arrayOf(parts));
    }, emit);
  },
  'test/1': function (x, a, emit) { withRe(x, a, 1, testOne, emit); },
  'test/2': function (x, a, emit) { withRe(x, a, 2, testOne, emit); },
  /* The pattern is on the outside and the flags inside, as jq's own
     definition binds them: sub($re; str; $flags). */
  'sub/2': function (x, a, emit) {
    ev(a[0], x, function (re) { substitute(x, re, a[1], leafOf(''), false, emit); });
  },
  'sub/3': function (x, a, emit) {
    ev(a[0], x, function (re) {
      ev(a[2], x, function (flags) { substitute(x, re, a[1], flags, false, emit); });
    });
  },
  'gsub/2': function (x, a, emit) {
    ev(a[0], x, function (re) { substitute(x, re, a[1], leafOf(''), true, emit); });
  },
  'gsub/3': function (x, a, emit) {
    ev(a[0], x, function (re) {
      ev(a[2], x, function (flags) { substitute(x, re, a[1], flags, true, emit); });
    });
  },

  'paths/0': function (x, _a, emit) {
    pathsOf(x, [], function (_v, path) { emit(path); });
  },
  /* A path once for every truthy output of the filter on its value, which
     is what select does. */
  'paths/1': function (x, a, emit) {
    pathsOf(x, [], function (v, path) {
      ev(a[0], v, function (r) { if (truthy(r)) emit(path); });
    });
  },
  'getpath/1': function (x, a, emit) {
    overArg(a[0], x, emit, function (p) {
      return atPath(x, wantType(p, 'array', 'getpath').v);
    });
  },

  /* jq's definition, in which map takes every output of the filter and
     map_values the first:

         def walk(f): def w: if type == "object" then map_values(w)
           elif type == "array" then map(w) else . end | f; w; */
  'walk/1': function (x, a, emit) {
    step(x, emit);

    function step(n: Node, out: Emit): void {
      tick();
      if (n.t === 'a') {
        const list: Node[] = [];
        for (let i = 0; i < n.v.length; i++) step(n.v[i], function (v) { list.push(v); });
        n = arrayOf(list);
      } else if (n.t === 'o') {
        const m = members(n);
        const keys: string[] = [];
        const vals: Node[] = [];
        for (let i = 0; i < m.v.length; i++) {
          let first: Node | undefined;
          stopping(function (e) { step(m.v[i], e); }, function (v) { first = v; return true; });
          if (first !== undefined) {
            keys.push(m.k[i]);
            vals.push(first);
          }
        }
        n = objectOf(keys, vals);
      }
      ev(a[0], n, out);
    }
  },

  'while/2': function (x, a, emit) { loop(x, a, emit, true); },
  'until/2': function (x, a, emit) { loop(x, a, emit, false); },
  'isempty/1': function (x, a, emit) {
    emit(some(a[0], x, function () { return true; }) ? FALSE : TRUE);
  },
  'error/0': function (x) {
    throw runErr(is(x, 'string') ? x.r : stringify(x));
  },
  /* error(f) is f | error: it raises the first output, and raises nothing
     when there is none. */
  'error/1': function (x, a) {
    ev(a[0], x, function (m) {
      throw runErr(is(m, 'string') ? m.r : stringify(m));
    });
  },

  'explode/0': function (x, _a, emit) {
    emit(arrayOf(chars(wantType(x, 'string', 'explode').r)
      .map(function (c) { return leafOf(c.codePointAt(0)!); })));
  },
  'implode/0': function (x, _a, emit) {
    emit(leafOf(wantType(x, 'array', 'implode').v
      .map(function (n) { return String.fromCodePoint(num(n, 'implode')); }).join('')));
  },

  'now/0': function (_x, _a, emit) { emit(leafOf(Date.now() / 1000)); },
  'gmtime/0': function (x, _a, emit) { emit(broken(num(x, 'gmtime'))); },
  'mktime/0': function (x, _a, emit) { emit(leafOf(seconds(x, 'mktime'))); },
  'todate/0': function (x, _a, emit) {
    emit(leafOf(strftime(num(x, 'todate'), '%Y-%m-%dT%H:%M:%SZ')));
  },
  'todateiso8601/0': function (x, _a, emit) {
    emit(leafOf(strftime(num(x, 'todateiso8601'), '%Y-%m-%dT%H:%M:%SZ')));
  },
  'fromdate/0': function (x, _a, emit) { emit(leafOf(parseDate(x, 'fromdate'))); },
  'fromdateiso8601/0': function (x, _a, emit) { emit(leafOf(parseDate(x, 'fromdateiso8601'))); },
  'strftime/1': function (x, a, emit) {
    const secs = seconds(x, 'strftime');
    overArg(a[0], x, emit, function (f) {
      return leafOf(strftime(secs, wantType(f, 'string', 'strftime').r));
    });
  },
  /* The exponent is on the outside, so pow((2,3); (4,5)) gives 16, 81, 32,
     243 as jq does. */
  'pow/2': function (x, a, emit) {
    ev(a[1], x, function (e) {
      ev(a[0], x, function (b) {
        emit(leafOf(Math.pow(num(b, 'pow'), num(e, 'pow'))));
      });
    });
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
  builtins[name + '/0'] = function (x, _a, emit) { emit(leafOf(FORMATS[name](x))); };
});
