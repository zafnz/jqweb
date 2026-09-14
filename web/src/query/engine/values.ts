/* What the engine knows about a value: its jq type, whether it counts as
   true, how two compare, how to reach inside one, and what the arithmetic
   operators make of two. A value is a node from model/node.ts. */

import { leafOf } from '../../model/node.ts';
import type { ArrayNode, LeafNode, Node, ObjectNode } from '../../model/node.ts';
import { checkNesting, NestingError } from '../../model/nesting.ts';
import { runErr } from './errors.ts';

export const NULL = leafOf(null);
export const TRUE = leafOf(true);
export const FALSE = leafOf(false);

/* ---- values ---- */

/* A jq type name, as typeOf gives it. */
export type JqType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

/* The node that holds a value of each jq type. */
interface Typed {
  null: LeafNode & { r: null };
  boolean: LeafNode & { r: boolean };
  number: LeafNode & { r: number };
  string: LeafNode & { r: string };
  array: ArrayNode;
  object: ObjectNode;
}

export function arrayOf(list: Node[]): ArrayNode { return bounded({ t: 'a', v: list }); }
export function objectOf(keys: string[], vals: Node[]): ObjectNode { return bounded({ t: 'o', k: keys, v: vals }); }

function bounded<T extends Node>(node: T): T {
  try {
    return checkNesting(node);
  } catch (e) {
    if (e instanceof NestingError) throw runErr(e.message);
    throw e;
  }
}

/* jq's name for a value's type, which is also what the type builtin
   returns and what the error messages are written in terms of. */
export function typeOf(n: Node): JqType {
  if (n.t === 'o') return 'object';
  if (n.t === 'a') return 'array';
  if (n.r === null) return 'null';
  const t = typeof n.r;
  return t === 'boolean' ? 'boolean' : t === 'number' ? 'number' : 'string';
}

/* Whether a value has jq type t, narrowing n to the node for that type. */
export function is<T extends JqType>(n: Node, t: T): n is Typed[T] {
  return typeOf(n) === t;
}

/* Only false and null are false; everything else, 0 and "" included, is
   true. */
export function truthy(n: Node): boolean { return !(n.t === 'l' && (n.r === null || n.r === false)); }

/* The members of an object as unique keys with their values, in document
   order. The document form can hold the same key twice, which jq's value
   model cannot, so the last one wins -- the choice a JSON parser makes. */
export function members(n: ObjectNode): { k: string[]; v: Node[] } {
  const keys: string[] = [];
  const vals: Node[] = [];
  const seen: Record<string, number> = {};
  for (let i = 0; i < n.k.length; i++) {
    const at = seen['$' + n.k[i]];
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
export function chars(s: string): string[] { return Array.from(s); }

/* ---- ordering ----

   jq orders values across types as null < false < true < numbers < strings
   < arrays < objects, and that order is what sort, unique, group_by, min,
   max and the comparison operators all use. */
const RANK: Record<JqType, number> = { 'null': 0, boolean: 1, number: 3, string: 4, array: 5, object: 6 };

function rank(n: Node): number {
  const t = typeOf(n);
  return t === 'boolean' && n.t === 'l' ? (n.r ? 2 : 1) : RANK[t];
}

/* A leaf holding a number or a string. */
type OrderedLeaf = LeafNode & { r: string | number };

/* The branches go by rank. An equal rank of 3 or 4 is two numbers or two
   strings and 5 is two arrays, which TypeScript cannot follow through rank(),
   so the casts state it. Narrowing with checks on t and r instead makes sort_by
   and group_by over 10,000 records about 10% slower in Chrome. */
export function cmp(a: Node, b: Node): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra <= 2) return 0;                       /* null and the booleans */
  if (ra <= 4) {
    const x = (a as OrderedLeaf).r;
    const y = (b as OrderedLeaf).r;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (ra === 5) {
    const av = (a as ArrayNode).v;
    const bv = (b as ArrayNode).v;
    for (let i = 0; i < av.length && i < bv.length; i++) {
      const c = cmp(av[i], bv[i]);
      if (c) return c;
    }
    return av.length === bv.length ? 0 : av.length < bv.length ? -1 : 1;
  }
  if (a.t === 'o' && b.t === 'o') {
    /* Objects compare by their sorted key lists first, and only then by the
       values taken in that order. */
    const ma = members(a);
    const mb = members(b);
    const ka = ma.k.slice().sort();
    const kb = mb.k.slice().sort();
    const c = cmp(arrayOf(ka.map(leafOf)), arrayOf(kb.map(leafOf)));
    if (c) return c;
    for (let i = 0; i < ka.length; i++) {
      const d = cmp(ma.v[ma.k.indexOf(ka[i])], mb.v[mb.k.indexOf(kb[i])]);
      if (d) return d;
    }
  }
  return 0;
}

export function equal(a: Node, b: Node): boolean { return cmp(a, b) === 0; }

/* ---- digging into a value ---- */

/* One member of an object by name. Missing keys and null both give null,
   which is what makes .a.b.c safe to type at a document you have not read
   yet. */
export function field(n: Node, key: string): Node {
  if (n.t === 'o') {
    const i = n.k.lastIndexOf(key);
    return i < 0 ? NULL : n.v[i];
  }
  if (n.t === 'l' && n.r === null) return NULL;
  throw runErr('cannot index ' + typeOf(n) + ' with "' + key + '"');
}

/* One element of an array. A negative index counts from the end and a
   fractional one is rounded down, both as in jq; out of range gives null. */
export function elem(n: Node, i: number): Node {
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
export function lookup(n: Node, key: Node): Node {
  if (is(key, 'string')) return field(n, key.r);
  if (is(key, 'number')) return elem(n, key.r);
  const t = typeOf(key);
  if (t === 'null' && n.t === 'l' && n.r === null) return NULL;
  throw runErr('cannot index ' + typeOf(n) + ' with ' + t);
}

export function slice(n: Node, from: Node | null, to: Node | null): Node {
  if (n.t === 'l' && n.r === null) return NULL;
  const cs = n.t === 'a' ? n.v : is(n, 'string') ? chars(n.r) : null;
  if (cs === null) throw runErr('cannot slice ' + typeOf(n));
  const lo = bound(from, 0, cs.length);
  let hi = bound(to, cs.length, cs.length);
  if (hi < lo) hi = lo;
  return n.t === 'a' ? arrayOf(n.v.slice(lo, hi)) : leafOf(cs.slice(lo, hi).join(''));
}

/* One end of a slice: absent means the default, negative counts from the
   end, and anything past either end is pulled back to it. */
function bound(v: Node | null, dflt: number, len: number): number {
  if (v === null) return dflt;
  if (!is(v, 'number')) throw runErr('a slice bound must be a number');
  let i = Math.floor(v.r);
  if (i < 0) i += len;
  return i < 0 ? 0 : i > len ? len : i;
}

export function iterate(n: Node): Node[] {
  if (n.t === 'a') return n.v;
  if (n.t === 'o') return members(n).v;
  throw runErr('cannot iterate over ' + typeOf(n));
}

/* Every value in a subtree, the value itself first, which is what ".." and
   recurse produce. */
export function descend(n: Node, out: Node[]): void {
  out.push(n);
  if (n.t === 'a' || n.t === 'o') {
    const v = n.t === 'o' ? members(n).v : n.v;
    for (let i = 0; i < v.length; i++) descend(v[i], out);
  }
}

/* ---- arithmetic ----

   Each of these takes two values and returns one. What the operators mean
   beyond numbers is jq's: "+" joins strings, arrays and objects, "-"
   removes array elements, "*" merges objects recursively and repeats a
   string, and "/" splits one. */

export function add2(a: Node, b: Node): Node {
  if (is(a, 'null')) return b;
  if (is(b, 'null')) return a;
  if (is(a, 'number') && is(b, 'number')) return leafOf(a.r + b.r);
  if (is(a, 'string') && is(b, 'string')) return leafOf(a.r + b.r);
  if (a.t === 'a' && b.t === 'a') return arrayOf(a.v.concat(b.v));
  if (a.t === 'o' && b.t === 'o') return merge(a, b, false);
  throw runErr(typeOf(a) + ' and ' + typeOf(b) + ' cannot be added');
}

export function sub2(a: Node, b: Node): Node {
  if (is(a, 'number') && is(b, 'number')) return leafOf(a.r - b.r);
  if (a.t === 'a' && b.t === 'a') {
    return arrayOf(a.v.filter(function (n) {
      for (let i = 0; i < b.v.length; i++) if (equal(b.v[i], n)) return false;
      return true;
    }));
  }
  throw runErr(typeOf(a) + ' and ' + typeOf(b) + ' cannot be subtracted');
}

export function mul2(a: Node, b: Node): Node {
  if (is(a, 'number') && is(b, 'number')) return leafOf(a.r * b.r);
  if (is(a, 'string') && is(b, 'number')) return repeat(a.r, b.r);
  if (is(a, 'number') && is(b, 'string')) return repeat(b.r, a.r);
  if (a.t === 'o' && b.t === 'o') return merge(a, b, true);
  throw runErr(typeOf(a) + ' and ' + typeOf(b) + ' cannot be multiplied');
}

export function div2(a: Node, b: Node): Node {
  if (is(a, 'number') && is(b, 'number')) {
    if (b.r === 0) throw runErr('cannot divide by zero');
    return leafOf(a.r / b.r);
  }
  if (is(a, 'string') && is(b, 'string')) return arrayOf(a.r.split(b.r).map(leafOf));
  throw runErr(typeOf(a) + ' and ' + typeOf(b) + ' cannot be divided');
}

/* jq truncates both sides to integers before taking the remainder, so
   5.9 % 3 is 2, and keeps the sign of the left-hand side. */
export function mod2(a: Node, b: Node): Node {
  if (!is(a, 'number') || !is(b, 'number')) {
    throw runErr(typeOf(a) + ' and ' + typeOf(b) + ' cannot be divided');
  }
  const d = Math.trunc(b.r);
  if (d === 0) throw runErr('cannot divide by zero');
  return leafOf(Math.trunc(a.r) % d);
}

/* A negative count gives null and a fractional one is rounded down, so
   "ab" * 2.5 is "abab" and "ab" * -1 is null. */
function repeat(s: string, n: number): Node {
  if (n < 0) return NULL;
  let out = '';
  for (let i = Math.floor(n); i > 0; i--) out += s;
  return leafOf(out);
}

/* Object "+" takes the right-hand value wherever both have a key; object
   "*" merges the two values instead when both are objects. */
function merge(a: ObjectNode, b: ObjectNode, deep: boolean): ObjectNode {
  const ma = members(a);
  const mb = members(b);
  const keys = ma.k.slice();
  const vals = ma.v.slice();
  for (let i = 0; i < mb.k.length; i++) {
    const at = keys.indexOf(mb.k[i]);
    if (at < 0) {
      keys.push(mb.k[i]);
      vals.push(mb.v[i]);
    } else {
      const here = vals[at];
      const there = mb.v[i];
      vals[at] = deep && here.t === 'o' && there.t === 'o' ? merge(here, there, true) : there;
    }
  }
  return objectOf(keys, vals);
}

export function wantType<T extends JqType>(n: Node, t: T, name: string): Typed[T] {
  if (!is(n, t)) throw runErr(name + ' needs ' + t + ', not ' + typeOf(n));
  return n;
}

export function num(n: Node, name: string): number {
  if (!is(n, 'number')) throw runErr(name + ' needs a number, not ' + typeOf(n));
  return n.r;
}

/* An object with any repeated key collapsed to its last value, which is the
   only shape jq's value model has. */
export function distinct(n: ObjectNode): ObjectNode {
  const m = members(n);
  return objectOf(m.k, m.v);
}
