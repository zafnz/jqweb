/* Evaluation is lazy inside the engine; the page collects the final stream.
   Calls retain the builtin resolved by the parser, avoiding a table import. */

import { leafOf } from '../../model/node.ts';
import type { Node } from '../../model/node.ts';
import { isJqError, runErr, workErr } from './errors.ts';
import type { Ast, Entry } from './parser.ts';
import { FALSE, TRUE, add2, arrayOf, cmp, distinct, div2, field, is,
  iterate, lookup, mod2, mul2, num, objectOf, slice, sub2, truthy,
  typeOf } from './values.ts';

export type Stream = Iterable<Node>;
export type Builtin = (x: Node, args: Ast[], ctx: Evaluation) => Stream;

const STEP_LIMIT = 5000000;
const FRAME_LIMIT = 4096;

export function evaluate(ast: Ast, input: Node): Node[] {
  return Array.from(new Evaluation().ev(ast, input));
}

/* A collector is explicit: arrays and sorting need the whole stream, but
   operators and value arguments must let their consumer stop early. */
export function push(out: Node[], list: Stream): void {
  for (const n of list) out.push(n);
}

export function first(stream: Stream): Node | undefined {
  for (const n of stream) return n;
  return undefined;
}

const COMPARE: Record<'==' | '!=' | '<' | '<=' | '>' | '>=', (c: number) => boolean> = {
  '==': c => c === 0, '!=': c => c !== 0, '<': c => c < 0,
  '<=': c => c <= 0, '>': c => c > 0, '>=': c => c >= 0
};
const ARITH: Record<'+' | '-' | '*' | '/' | '%', (a: Node, b: Node) => Node> = {
  '+': add2, '-': sub2, '*': mul2, '/': div2, '%': mod2
};

type ScalarFilter = (ctx: Evaluation, x: Node) => Node;
const scalars = new WeakMap<Ast, ScalarFilter | null>();

/* A scalar expression cannot yield and then fail: it either returns its
   sole value or throws before it. Compile that subset to direct calls so
   predicates over large arrays do not allocate iterators per operand.
   Unknown calls and anything that can be empty or branch stay lazy. */
function scalar(a: Ast): ScalarFilter | null {
  const cached = scalars.get(a);
  if (cached !== undefined) return cached;
  let f: ScalarFilter | null = null;
  switch (a.op) {
    case '.': f = (_, x) => x; break;
    case 'lit': f = () => a.n; break;
    case 'field': {
      const src = scalar(a.src);
      if (src) f = (ctx, x) => field(src(ctx, x), a.name);
      break;
    }
    case 'neg': {
      const e = scalar(a.e);
      if (e) f = (ctx, x) => leafOf(-num(e(ctx, x), 'negation'));
      break;
    }
    case '+': case '-': case '*': case '/': case '%':
    case '==': case '!=': case '<': case '<=': case '>': case '>=': {
      const l = scalar(a.l);
      const r = scalar(a.r);
      const op = a.op;
      const apply = op in ARITH ? ARITH[op as keyof typeof ARITH]
        : (l: Node, r: Node) => COMPARE[op as keyof typeof COMPARE](cmp(l, r)) ? TRUE : FALSE;
      if (l && r) f = (ctx, x) => {
        const right = r(ctx, x);
        return apply(l(ctx, x), right);
      };
      break;
    }
    case 'and': case 'or': {
      const l = scalar(a.l);
      const r = scalar(a.r);
      const decided = a.op === 'or';
      if (l && r) f = (ctx, x) => {
        if (truthy(l(ctx, x)) === decided) return decided ? TRUE : FALSE;
        return truthy(r(ctx, x)) ? TRUE : FALSE;
      };
      break;
    }
  }
  const result: ScalarFilter | null = f ? (ctx, x) => { ctx.tick(); return f(ctx, x); } : null;
  scalars.set(a, result);
  return result;
}

/* Each execution owns its budget, including suspended builtin iterators.
   Resource exhaustion is not a jq error that ? can hide and keep running. */
export class Evaluation {
  private steps = 0;

  tick(): void {
    if (++this.steps > STEP_LIMIT) throw workErr('query produced too much work');
  }

  ev(a: Ast, x: Node): Stream {
    const fast = scalar(a);
    return fast ? [fast(this, x)] : this.stream(a, x);
  }

  isScalar(a: Ast): boolean { return scalar(a) !== null; }

  private *stream(a: Ast, x: Node): Generator<Node> {
    this.tick();
    switch (a.op) {
      case '.': yield x; return;
      case 'lit': yield a.n; return;
      case 'recurse':
        yield* this.descend(x, n => n.t === 'l' ? [] : iterate(n));
        return;
      case '|':
        for (const n of this.ev(a.l, x)) yield* this.ev(a.r, n);
        return;
      case ',':
        yield* this.ev(a.l, x);
        yield* this.ev(a.r, x);
        return;
      case '//': {
        let found = false;
        for (const n of this.ev(a.l, x)) {
          if (truthy(n)) { found = true; yield n; }
        }
        if (!found) yield* this.ev(a.r, x);
        return;
      }
      case 'and': case 'or': {
        const decided = a.op === 'or';
        for (const n of this.ev(a.l, x)) {
          if (truthy(n) === decided) yield decided ? TRUE : FALSE;
          else for (const r of this.ev(a.r, x)) yield truthy(r) ? TRUE : FALSE;
        }
        return;
      }
      case '==': case '!=': case '<': case '<=': case '>': case '>=':
        for (const [l, r] of this.args([a.l, a.r], x)) {
          yield COMPARE[a.op](cmp(l, r)) ? TRUE : FALSE;
        }
        return;
      case '+': case '-': case '*': case '/': case '%':
        for (const [l, r] of this.args([a.l, a.r], x)) yield ARITH[a.op](l, r);
        return;
      case 'neg':
        for (const n of this.ev(a.e, x)) yield leafOf(-num(n, 'negation'));
        return;
      case 'opt':
        try { yield* this.ev(a.e, x); }
        catch (e) {
          if (!isJqError(e) || e.jq !== 'run' || e.fatal) throw e;
        }
        return;
      case 'field':
        for (const n of this.ev(a.src, x)) yield field(n, a.name);
        return;
      case 'index':
        for (const [src, key] of this.args([a.src, a.e], x)) yield lookup(src, key);
        return;
      case 'slice':
        for (const from of a.from ? this.ev(a.from, x) : [null]) {
          for (const to of a.to ? this.ev(a.to, x) : [null]) {
            for (const src of this.ev(a.src, x)) yield slice(src, from, to);
          }
        }
        return;
      case 'iterate':
        for (const n of this.ev(a.src, x)) yield* iterate(n);
        return;
      case 'array':
        yield arrayOf(a.e ? Array.from(this.ev(a.e, x)) : []);
        return;
      case 'object':
        yield* this.object(a.entries, 0, [], [], x);
        return;
      case 'if':
        for (const n of this.ev(a.c, x)) yield* this.ev(truthy(n) ? a.t : a.f, x);
        return;
      case 'call':
        yield* a.fn(x, a.args, this);
    }
  }

  /* Native value arguments evaluate rightmost first; jq-defined filters
     such as range bind them leftmost first. Restart each inner expression
     rather than caching it: errors and empty streams make that observable. */
  *args(args: Ast[], x: Node, leftFirst = false): Generator<Node[]> {
    const vals: Node[] = [];
    const ctx = this;
    yield* bind(0);
    function* bind(depth: number): Generator<Node[]> {
      if (depth === args.length) { yield vals.slice(); return; }
      const i = leftFirst ? depth : args.length - 1 - depth;
      for (const n of ctx.ev(args[i], x)) {
        vals[i] = n;
        yield* bind(depth + 1);
      }
    }
  }

  /* Suspended iterators preserve depth-first order without prefetching a
     sibling that might fail. Bound pending continuations as well as steps
     so an unending recursive filter cannot exhaust memory. */
  *descend(x: Node, next: (n: Node) => Stream, singleNext = false): Generator<Node> {
    yield* this.loop(x, function* (n) {
      yield { value: n, emit: true };
      for (const child of next(n)) yield { value: child, emit: false, tail: singleNext };
    });
  }

  *loop(x: Node, step: (n: Node) => Iterable<{ value: Node; emit: boolean; tail?: boolean }>): Generator<Node> {
    const stack = [step(x)[Symbol.iterator]()];
    try {
      while (stack.length) {
        this.tick();
        const item = stack[stack.length - 1].next();
        if (item.done) { stack.pop(); continue; }
        if (item.value.emit) yield item.value.value;
        else {
          // A proven scalar step has no pending sibling or later error.
          if (item.value.tail) stack.pop()!.return?.();
          if (stack.length >= FRAME_LIMIT) throw workErr('query produced too much work');
          stack.push(step(item.value.value)[Symbol.iterator]());
        }
      }
    } finally {
      for (let i = stack.length - 1; i >= 0; i--) stack[i].return?.();
    }
  }

  private *object(entries: Entry[], i: number, keys: string[], vals: Node[], x: Node): Generator<Node> {
    if (i === entries.length) {
      yield distinct(objectOf(keys.slice(), vals.slice()));
      return;
    }
    for (const key of this.ev(entries[i].k, x)) {
      if (!is(key, 'string')) throw runErr('an object key must be a string, not ' + typeOf(key));
      for (const value of this.ev(entries[i].v, x)) {
        keys.push(key.r);
        vals.push(value);
        yield* this.object(entries, i + 1, keys, vals, x);
        keys.pop();
        vals.pop();
      }
    }
  }
}
