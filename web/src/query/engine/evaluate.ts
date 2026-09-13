/* Running a parsed query against one input.

   A call carries the builtin the parser looked up for it, so this module does
   not import the builtin table, which imports ev from here. */

import { leafOf } from '../../model/node.ts';
import type { Node } from '../../model/node.ts';
import { isJqError, runErr } from './errors.ts';
import type { Ast, Entry } from './parser.ts';
import { FALSE, TRUE, add2, arrayOf, cmp, descend, distinct, div2, field, is,
  iterate, lookup, mod2, mul2, num, objectOf, slice, sub2, truthy,
  typeOf } from './values.ts';

/* Every output an expression produces for one input, in order. */
export type Stream = Node[];

/* A builtin: the input and the argument expressions, still unrun, to the
   stream it produces. */
export type Builtin = (x: Node, args: Ast[]) => Stream;

/* A node for one of the operators that joins two expressions. */
type Binary = Extract<Ast, { l: Ast }>;

/* Evaluating a query that fans out -- ".. | select(...)" over a large
   document -- can do a lot of work before it produces anything. The counter
   bounds it so a mistyped query reports an error instead of hanging the
   tab. */
const STEP_LIMIT = 5000000;
let steps = 0;

/* Runs a whole query against one input. The step count starts again from
   nothing, so a query run many times is bounded on each run rather than
   across all of them. */
export function evaluate(ast: Ast, input: Node): Stream {
  steps = 0;
  return ev(ast, input);
}

/* Bounds the work one query may do, so a filter that fans out over a large
   document reports an error instead of hanging the tab. */
export function tick(): void {
  if (++steps > STEP_LIMIT) throw runErr('query produced too much work');
}

/* Appends one stream to another. push.apply would do it in a single call,
   but a stream can be long enough to overflow the argument stack. */
export function push(out: Stream, list: Stream): void {
  for (let i = 0; i < list.length; i++) out.push(list[i]);
}

const COMPARE: Record<string, (c: number) => boolean> = {
  '==': function (c) { return c === 0; },
  '!=': function (c) { return c !== 0; },
  '<': function (c) { return c < 0; },
  '<=': function (c) { return c <= 0; },
  '>': function (c) { return c > 0; },
  '>=': function (c) { return c >= 0; }
};
const ARITH: Record<string, (a: Node, b: Node) => Node> = { '+': add2, '-': sub2, '*': mul2, '/': div2, '%': mod2 };

/* Runs one expression against one input and returns its stream. */
export function ev(a: Ast, x: Node): Stream {
  tick();
  switch (a.op) {
    case '.':
      return [x];
    case 'lit':
      return [a.n];
    case 'recurse': {
      const out: Stream = [];
      descend(x, out);
      return out;
    }
    case '|': {
      const out: Stream = [];
      const vals = ev(a.l, x);
      for (let i = 0; i < vals.length; i++) push(out, ev(a.r, vals[i]));
      return out;
    }
    case ',':
      return ev(a.l, x).concat(ev(a.r, x));
    case '//':
      return alternative(a, x);
    case 'and':
    case 'or':
      return logical(a, x);
    case '==': case '!=': case '<': case '<=': case '>': case '>=': {
      const test = COMPARE[a.op];
      return pair(a, x, function (l, r) { return test(cmp(l, r)) ? TRUE : FALSE; });
    }
    case '+': case '-': case '*': case '/': case '%':
      return pair(a, x, ARITH[a.op]);
    case 'neg': {
      const out: Stream = [];
      const vals = ev(a.e, x);
      for (let i = 0; i < vals.length; i++) {
        out.push(leafOf(-num(vals[i], 'negation')));
      }
      return out;
    }
    case 'opt':
      try {
        return ev(a.e, x);
      } catch (e) {
        if (isJqError(e) && e.jq === 'run') return [];
        throw e;
      }
    case 'field': {
      const out: Stream = [];
      const vals = ev(a.src, x);
      for (let i = 0; i < vals.length; i++) out.push(field(vals[i], a.name));
      return out;
    }
    case 'index': {
      const out: Stream = [];
      const vals = ev(a.src, x);
      const to = ev(a.e, x);
      for (let i = 0; i < vals.length; i++) {
        for (let j = 0; j < to.length; j++) out.push(lookup(vals[i], to[j]));
      }
      return out;
    }
    case 'slice': {
      const out: Stream = [];
      const vals = ev(a.src, x);
      const from = a.from ? ev(a.from, x) : [null];
      const to = a.to ? ev(a.to, x) : [null];
      for (let i = 0; i < vals.length; i++) {
        for (let j = 0; j < from.length; j++) {
          for (let k = 0; k < to.length; k++) out.push(slice(vals[i], from[j], to[k]));
        }
      }
      return out;
    }
    case 'iterate': {
      const out: Stream = [];
      const vals = ev(a.src, x);
      for (let i = 0; i < vals.length; i++) push(out, iterate(vals[i]));
      return out;
    }
    case 'array':
      return [arrayOf(a.e ? ev(a.e, x) : [])];
    case 'object': {
      const out: Stream = [];
      buildObject(a.entries, 0, [], [], x, out);
      return out;
    }
    case 'if': {
      const out: Stream = [];
      const vals = ev(a.c, x);
      for (let i = 0; i < vals.length; i++) push(out, ev(truthy(vals[i]) ? a.t : a.f, x));
      return out;
    }
    case 'call':
      return a.fn(x, a.args);
  }
}

/* Applies a two-value operator across both streams. jq runs the right-hand
   one on the outside, so (1,2) + (10,20) gives 11, 12, 21, 22. */
function pair(a: Binary, x: Node, f: (l: Node, r: Node) => Node): Stream {
  const l = ev(a.l, x);
  const r = ev(a.r, x);
  const out: Stream = [];
  for (let i = 0; i < r.length; i++) {
    for (let j = 0; j < l.length; j++) out.push(f(l[j], r[i]));
  }
  return out;
}

/* a // b keeps every truthy output of a, and falls back to b when a
   produced none of them or failed outright. */
function alternative(a: Binary, x: Node): Stream {
  const out: Stream = [];
  try {
    const vals = ev(a.l, x);
    for (let i = 0; i < vals.length; i++) if (truthy(vals[i])) out.push(vals[i]);
  } catch (e) {
    if (!isJqError(e) || e.jq !== 'run') throw e;
  }
  return out.length ? out : ev(a.r, x);
}

/* and/or stop at the left-hand value when it settles the answer, which
   matters because the right-hand side may well fail on the value that made
   it unnecessary. */
function logical(a: Binary, x: Node): Stream {
  const vals = ev(a.l, x);
  const decided = a.op === 'or';
  const out: Stream = [];
  for (let i = 0; i < vals.length; i++) {
    if (truthy(vals[i]) === decided) {
      out.push(decided ? TRUE : FALSE);
      continue;
    }
    const rest = ev(a.r, x);
    for (let j = 0; j < rest.length; j++) out.push(truthy(rest[j]) ? TRUE : FALSE);
  }
  return out;
}

/* Object construction runs each member's key and value as a stream, so
   {a: (1,2)} makes two objects. Members are taken left to right with the
   first on the outside, which is the order jq produces. */
function buildObject(entries: Entry[], i: number, keys: string[], vals: Node[], x: Node, out: Stream): void {
  if (i === entries.length) {
    out.push(distinct(objectOf(keys.slice(), vals.slice())));
    return;
  }
  const ks = ev(entries[i].k, x);
  for (let j = 0; j < ks.length; j++) {
    const key = ks[j];
    if (!is(key, 'string')) {
      throw runErr('an object key must be a string, not ' + typeOf(key));
    }
    const vs = ev(entries[i].v, x);
    for (let m = 0; m < vs.length; m++) {
      keys.push(key.r);
      vals.push(vs[m]);
      buildObject(entries, i + 1, keys, vals, x, out);
      keys.pop();
      vals.pop();
    }
  }
}
