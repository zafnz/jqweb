/* Running a parsed query against one input.

   An expression is run with a sink: ev hands each output to emit as it is
   produced, and never holds a whole stream. That is what lets first, limit
   and isempty stop a stream part way, and what keeps the outputs "?" had
   already passed on when the expression then fails.

   A call carries the builtin the parser looked up for it, so this module does
   not import the builtin table, which imports ev from here. */

import { leafOf } from '../../model/node.ts';
import type { Node } from '../../model/node.ts';
import { isJqError, runErr, workErr } from './errors.ts';
import type { Ast, Entry } from './parser.ts';
import { FALSE, TRUE, add2, arrayOf, cmp, descend, distinct, div2, field, is,
  iterate, lookup, mod2, mul2, num, objectOf, slice, sub2, truthy,
  typeOf } from './values.ts';

/* Every output an expression produces for one input, in order. */
export type Stream = Node[];

/* Where an expression sends each output as it is produced. */
export type Emit = (n: Node) => void;

/* A builtin: the input, the argument expressions still unrun, and where to
   send each output. */
export type Builtin = (x: Node, args: Ast[], emit: Emit) => void;

/* A node for one of the operators that joins two expressions. */
type Binary = Extract<Ast, { l: Ast }>;

/* Evaluating a query that fans out -- ".. | select(...)" over a large
   document -- can do a lot of work before it produces anything. The counter
   bounds it so a mistyped query reports an error instead of hanging the
   tab. */
const STEP_LIMIT = 5000000;
let steps = 0;

/* Runs a whole query against one input, sending each output to emit as it
   is produced. The step count starts again from nothing, so a query run
   many times is bounded on each run rather than across all of them. */
export function stream(ast: Ast, input: Node, emit: Emit): void {
  steps = 0;
  ev(ast, input, emit);
}

/* Runs a whole query against one input and returns every output. */
export function evaluate(ast: Ast, input: Node): Stream {
  const out: Stream = [];
  stream(ast, input, function (n) { out.push(n); });
  return out;
}

/* Bounds the work one query may do, so a filter that fans out over a large
   document reports an error instead of hanging the tab. */
export function tick(): void {
  if (++steps > STEP_LIMIT) throw workErr('query produced too much work');
}

/* Whether an expression always produces exactly one output, and can only
   fail before producing it: the input, a literal, a field or index of one,
   arithmetic, a comparison, and, or, negation, or an if over them. A loop
   whose steps are scalar can be run as a loop, because no output can come
   after the one the step gave. */
const SCALAR = new WeakMap<Ast, boolean>();
export function scalar(a: Ast): boolean {
  let s = SCALAR.get(a);
  if (s !== undefined) return s;
  switch (a.op) {
    case '.': case 'lit': s = true; break;
    case 'field': s = scalar(a.src); break;
    case 'neg': s = scalar(a.e); break;
    case 'index': s = scalar(a.src) && scalar(a.e); break;
    case 'if': s = scalar(a.c) && scalar(a.t) && scalar(a.f); break;
    case 'and': case 'or':
    case '==': case '!=': case '<': case '<=': case '>': case '>=':
    case '+': case '-': case '*': case '/': case '%':
      s = scalar(a.l) && scalar(a.r);
      break;
    default: s = false;
  }
  SCALAR.set(a, s);
  return s;
}

/* The one output of a scalar expression. */
export function one(a: Ast, x: Node): Node {
  let v: Node | undefined;
  ev(a, x, function (n) { v = n; });
  return v!;
}

/* Every output of an expression, for the builtins that need the whole
   stream before they can say anything: sort_by, last, array construction. */
export function collect(a: Ast, x: Node): Stream {
  const out: Stream = [];
  ev(a, x, function (n) { out.push(n); });
  return out;
}

/* Runs produce, and stops it as soon as take returns true for an output.
   The stop is a throw through produce, which the try here catches; it is a
   plain object rather than an Error because no stack trace is wanted, and
   a fresh one each time so that one consumer cannot catch another's. */
export function stopping(produce: (emit: Emit) => void, take: (n: Node) => boolean): void {
  const stop = {};
  try {
    produce(function (n) { if (take(n)) throw stop; });
  } catch (e) {
    if (e !== stop) throw e;
  }
}

/* Runs an expression until take returns true for one of its outputs. */
export function evUntil(a: Ast, x: Node, take: (n: Node) => boolean): void {
  stopping(function (emit) { ev(a, x, emit); }, take);
}

/* The first output of an expression, or undefined when it has none. The
   rest of the stream is never run, so map_values(., error) takes the value
   and never reaches the error. */
export function firstOf(a: Ast, x: Node): Node | undefined {
  let found: Node | undefined;
  evUntil(a, x, function (n) { found = n; return true; });
  return found;
}

/* Whether any output of an expression satisfies f, stopping at the first
   that does. */
export function some(a: Ast, x: Node, f: (n: Node) => boolean): boolean {
  let found = false;
  evUntil(a, x, function (n) { return (found = f(n)); });
  return found;
}

/* An error on its way back through an expression from something its output
   went on to. "?" catches only what fails inside the expression it wraps,
   as jq 1.7 does, so the emit it passes down wraps whatever comes back up,
   and its catch unwraps that and lets it carry on. */
class Downstream {
  e: unknown;
  constructor(e: unknown) { this.e = e; }
}

function guard(emit: Emit): Emit {
  return function (n) {
    try {
      emit(n);
    } catch (e) {
      throw new Downstream(e);
    }
  };
}

const COMPARE: Record<'==' | '!=' | '<' | '<=' | '>' | '>=', (c: number) => boolean> = {
  '==': function (c) { return c === 0; },
  '!=': function (c) { return c !== 0; },
  '<': function (c) { return c < 0; },
  '<=': function (c) { return c <= 0; },
  '>': function (c) { return c > 0; },
  '>=': function (c) { return c >= 0; }
};
const ARITH: Record<'+' | '-' | '*' | '/' | '%', (a: Node, b: Node) => Node> = {
  '+': add2, '-': sub2, '*': mul2, '/': div2, '%': mod2
};

/* Runs one expression against one input, sending each output to emit. */
export function ev(a: Ast, x: Node, emit: Emit): void {
  tick();
  switch (a.op) {
    case '.':
      emit(x);
      return;
    case 'lit':
      emit(a.n);
      return;
    case 'recurse':
      descend(x, emit);
      return;
    case '|':
      ev(a.l, x, function (v) { ev(a.r, v, emit); });
      return;
    case ',':
      ev(a.l, x, emit);
      ev(a.r, x, emit);
      return;
    case '//':
      alternative(a, x, emit);
      return;
    case 'and':
    case 'or':
      logical(a, x, emit);
      return;
    case '==': case '!=': case '<': case '<=': case '>': case '>=': {
      const test = COMPARE[a.op];
      pair(a, x, emit, function (l, r) { return test(cmp(l, r)) ? TRUE : FALSE; });
      return;
    }
    case '+': case '-': case '*': case '/': case '%':
      pair(a, x, emit, ARITH[a.op]);
      return;
    case 'neg':
      ev(a.e, x, function (v) { emit(leafOf(-num(v, 'negation'))); });
      return;
    case 'opt':
      optional(a.e, x, emit);
      return;
    case 'field':
      ev(a.src, x, function (v) { emit(field(v, a.name)); });
      return;
    /* The index is on the outside and the value inside, so ([1,2],[3,4])[0,1]
       gives 1, 3, 2, 4 as jq does. */
    case 'index':
      ev(a.e, x, function (k) {
        ev(a.src, x, function (v) { emit(lookup(v, k)); });
      });
      return;
    case 'slice':
      maybe(a.from, x, function (from) {
        maybe(a.to, x, function (to) {
          ev(a.src, x, function (v) { emit(slice(v, from, to)); });
        });
      });
      return;
    case 'iterate':
      ev(a.src, x, function (v) {
        const list = iterate(v);
        for (let i = 0; i < list.length; i++) emit(list[i]);
      });
      return;
    case 'array':
      emit(arrayOf(a.e ? collect(a.e, x) : []));
      return;
    case 'object':
      buildObject(a.entries, 0, [], [], x, emit);
      return;
    case 'if':
      ev(a.c, x, function (c) { ev(truthy(c) ? a.t : a.f, x, emit); });
      return;
    case 'call':
      a.fn(x, a.args, emit);
      return;
  }
}

/* An expression that may be absent, as either end of a slice can be: absent
   stands for one output of null. */
function maybe(a: Ast | null, x: Node, f: (n: Node | null) => void): void {
  if (a) ev(a, x, f);
  else f(null);
}

/* Applies a two-value operator across both streams. jq runs the right-hand
   one on the outside, so (1,2) + (10,20) gives 11, 12, 21, 22. */
function pair(a: Binary, x: Node, emit: Emit, f: (l: Node, r: Node) => Node): void {
  ev(a.r, x, function (r) {
    ev(a.l, x, function (l) { emit(f(l, r)); });
  });
}

/* "?" drops the error an expression raises and keeps what it had produced
   before then. An error from further down the pipeline goes on up, and so
   does running out of work, which no query can carry on from. */
function optional(e: Ast, x: Node, emit: Emit): void {
  try {
    ev(e, x, guard(emit));
  } catch (err) {
    if (err instanceof Downstream) throw err.e;
    if (!(isJqError(err) && err.jq === 'run' && !err.fatal)) throw err;
  }
}

/* a // b keeps every truthy output of a, and falls back to b when a
   produced none of them. An error in a is an error, as in jq 1.7. */
function alternative(a: Binary, x: Node, emit: Emit): void {
  let found = false;
  ev(a.l, x, function (v) {
    if (!truthy(v)) return;
    found = true;
    emit(v);
  });
  if (!found) ev(a.r, x, emit);
}

/* and/or stop at the left-hand value when it settles the answer, which
   matters because the right-hand side may well fail on the value that made
   it unnecessary. */
function logical(a: Binary, x: Node, emit: Emit): void {
  const decided = a.op === 'or';
  ev(a.l, x, function (l) {
    if (truthy(l) === decided) {
      emit(decided ? TRUE : FALSE);
      return;
    }
    ev(a.r, x, function (r) { emit(truthy(r) ? TRUE : FALSE); });
  });
}

/* Object construction runs each member's key and value as a stream, so
   {a: (1,2)} makes two objects. Members are taken left to right with the
   first on the outside, which is the order jq produces. */
function buildObject(entries: Entry[], i: number, keys: string[], vals: Node[], x: Node, emit: Emit): void {
  if (i === entries.length) {
    emit(distinct(objectOf(keys.slice(), vals.slice())));
    return;
  }
  ev(entries[i].k, x, function (key) {
    if (!is(key, 'string')) {
      throw runErr('an object key must be a string, not ' + typeOf(key));
    }
    ev(entries[i].v, x, function (v) {
      keys.push(key.r);
      vals.push(v);
      buildObject(entries, i + 1, keys, vals, x, emit);
      keys.pop();
      vals.pop();
    });
  });
}
