/* Reading a query, second pass: recursive descent over the tokens from
   lexer.ts, building the tree evaluate.ts runs. */

import { leafOf } from '../../model/node.ts';
import type { LeafNode } from '../../model/node.ts';
import type { Segment } from '../../model/path.ts';
import { builtins } from './builtins.ts';
import { parseErr } from './errors.ts';
import type { Builtin } from './evaluate.ts';
import { lex } from './lexer.ts';
import type { Token } from './lexer.ts';
import { FALSE, NULL, TRUE } from './values.ts';

/* The operators that join two expressions, each kept as the op of the node
   holding its two sides. */
export type BinaryOp = '|' | ',' | '//' | 'or' | 'and' | '==' | '!=' | '<' | '<=' | '>' | '>='
  | '+' | '-' | '*' | '/' | '%';

/* One member of an object construction: the expressions for its key and its
   value. */
export interface Entry {
  k: Ast;
  v: Ast;
}

/* A parsed query, as a tree of these. p is where in the query each one
   starts. A call holds the builtin its name and argument count found. */
export type Ast =
  | { op: '.' | 'recurse'; p: number }
  | { op: 'lit'; n: LeafNode; p: number }
  | { op: BinaryOp; l: Ast; r: Ast; p: number }
  | { op: 'neg' | 'opt'; e: Ast; p: number }
  | { op: 'field'; src: Ast; name: string; p: number }
  | { op: 'index'; src: Ast; e: Ast; p: number }
  | { op: 'slice'; src: Ast; from: Ast | null; to: Ast | null; p: number }
  | { op: 'iterate'; src: Ast; p: number }
  | { op: 'array'; e: Ast | null; p: number }
  | { op: 'object'; entries: Entry[]; p: number }
  | { op: 'if'; c: Ast; t: Ast; f: Ast; p: number }
  | { op: 'call'; key: string; fn: Builtin; args: Ast[]; p: number };

/* Binary operators by binding power, loosest first. Only the pipe is
   right-associative. */
const BINOPS: { ops: BinaryOp[]; right?: boolean }[] = [
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
const OBJ_VALUE_LEVEL = 2;

/* Syntax this subset leaves out, by the token that gives it away, and what
   to say about it. */
const MISSING: Record<string, string> = Object.assign(Object.create(null), {
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
});

/* Whether an operator's text is one of ops, narrowing it to that type. */
function among<T extends string>(v: string, ops: readonly T[]): v is T {
  return ops.some(function (op) { return op === v; });
}

/* "1", "1 or 2", "1, 2 or 3". */
function orList(ns: number[]): string {
  const sorted = ns.slice().sort(function (a, b) { return a - b; });
  if (sorted.length < 2) return String(sorted[0]);
  return sorted.slice(0, -1).join(', ') + ' or ' + sorted[sorted.length - 1];
}

/* Which argument counts each builtin name accepts, worked out once from the
   builtin table so that a wrong count can say so rather than claim the name
   does not exist. suggest.ts reads it too, for the names a half-typed one
   could finish and whether a whole one runs without an argument. */
let arityCache: Record<string, number[]> | null = null;
export function arities(): Record<string, number[]> {
  if (!arityCache) {
    const found: Record<string, number[]> = Object.create(null);
    for (const key in builtins) {
      const cut = key.lastIndexOf('/');
      const name = key.slice(0, cut);
      if (!found[name]) found[name] = [];
      found[name].push(+key.slice(cut + 1));
    }
    arityCache = found;
  }
  return arityCache;
}

export function parse(src: string): Ast {
  const toks = lex(src);
  let at = 0;

  function peek(): Token { return toks[at]; }
  function isOp(v: string): boolean { return toks[at].k === 'op' && toks[at].v === v; }
  function isWord(v: string): boolean { return toks[at].k === 'ident' && toks[at].v === v; }
  function eat(v: string): boolean { return isOp(v) ? (at++, true) : false; }
  function want(v: string): void {
    if (!eat(v)) reject(peek(), 'expected "' + v + '"');
  }
  function wantWord(v: string): void {
    if (!isWord(v)) reject(peek(), 'expected "' + v + '"');
    at++;
  }

  /* Always throws. Syntax this subset leaves out is named, wherever it turns
     up, in preference to the fallback: the query is valid jq and the reader
     wants to know it is the page that is limited, not the query that is
     wrong. */
  function reject(t: Token, fallback?: string): never {
    if (t.k === 'var') throw parseErr('variables are not supported', t.p);
    if (t.k === 'format') throw parseErr('format strings are not supported', t.p);
    if ((t.k === 'op' || t.k === 'ident') && MISSING[t.v]) {
      throw parseErr(MISSING[t.v], t.p);
    }
    if (fallback) throw parseErr(fallback, t.p);
    if (t.k === 'eof') throw parseErr('query ends early', t.p);
    throw parseErr('unexpected "' + t.v + '"', t.p);
  }

  function expr(level = 0): Ast {
    if (level >= BINOPS.length) return unary();
    let lhs = expr(level + 1);
    const lv = BINOPS[level];
    for (;;) {
      const t = peek();
      if (t.k !== 'op' || !among(t.v, lv.ops)) return lhs;
      at++;
      lhs = { op: t.v, l: lhs, r: lv.right ? expr(level) : expr(level + 1), p: t.p };
      if (lv.right) return lhs;
    }
  }

  function unary(): Ast {
    if (isOp('-')) {
      const p = peek().p;
      at++;
      return { op: 'neg', e: unary(), p: p };
    }
    return postfix(primary());
  }

  /* The suffixes that dig into a value: a field, an index, a slice,
     iteration, and "?" which drops the value instead of failing when it is
     the wrong type. They chain, so .a[0].b? is four of them over the
     identity. */
  function postfix(src: Ast): Ast {
    for (;;) {
      const t = peek();
      const next = toks[at + 1];
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
  function brackets(src: Ast): Ast {
    const p = peek().p;
    at++;
    if (eat(']')) return { op: 'iterate', src: src, p: p };
    if (eat(':')) {
      const to = expr();
      want(']');
      return { op: 'slice', src: src, from: null, to: to, p: p };
    }
    const first = expr();
    if (eat(':')) {
      const to = isOp(']') ? null : expr();
      want(']');
      return { op: 'slice', src: src, from: first, to: to, p: p };
    }
    want(']');
    return { op: 'index', src: src, e: first, p: p };
  }

  function primary(): Ast {
    const t = peek();
    if (t.k === 'num' || t.k === 'str') {
      at++;
      return { op: 'lit', n: leafOf(t.v), p: t.p };
    }
    /* A leading ".foo" or ".[0]" is the identity with a suffix, which
       postfix() reads next, so the dot is left where it is. */
    if (t.k === 'field') return { op: '.', p: t.p };
    if (t.k === 'op' && t.v === '.') {
      const after = toks[at + 1];
      if (!(after.k === 'str' || (after.k === 'op' && after.v === '['))) at++;
      return { op: '.', p: t.p };
    }
    if (t.k === 'op' && t.v === '..') { at++; return { op: 'recurse', p: t.p }; }
    if (t.k === 'op' && t.v === '(') {
      at++;
      const e = expr();
      want(')');
      return e;
    }
    if (t.k === 'op' && t.v === '[') {
      at++;
      if (eat(']')) return { op: 'array', e: null, p: t.p };
      const e = expr();
      want(']');
      return { op: 'array', e: e, p: t.p };
    }
    if (t.k === 'op' && t.v === '{') { at++; return object(t.p); }
    /* "@base64" and the rest are filters whose names begin with an @. The
       "@base64 \"text\"" form, which formats an interpolated string, needs
       interpolation and so is not here. */
    if (t.k === 'format') {
      if (!builtins[t.v + '/0']) throw parseErr(t.v + ' is not a supported format', t.p);
      if (toks[at + 1].k === 'str') {
        throw parseErr(t.v + ' applied to a string needs interpolation, ' +
          'which is not supported', t.p);
      }
      at++;
      const key = t.v + '/0';
      return { op: 'call', key: key, fn: builtins[key], args: [], p: t.p };
    }
    if (t.k === 'ident' && !MISSING[t.v]) {
      if (t.v === 'if') return conditional();
      if (t.v === 'true' || t.v === 'false' || t.v === 'null') {
        at++;
        return { op: 'lit', n: t.v === 'null' ? NULL : t.v === 'true' ? TRUE : FALSE, p: t.p };
      }
      at++;
      const args: Ast[] = [];
      if (eat('(')) {
        for (;;) {
          args.push(expr());
          if (!eat(';')) break;
        }
        want(')');
      }
      const key = t.v + '/' + args.length;
      if (!builtins[key]) {
        const counts = arities()[t.v];
        if (!counts) throw parseErr(t.v + ' is not a supported filter', t.p);
        throw parseErr(t.v + ' takes ' + orList(counts) +
          (counts.length === 1 && counts[0] === 1 ? ' argument, not ' : ' arguments, not ') +
          args.length, t.p);
      }
      return { op: 'call', key: key, fn: builtins[key], args: args, p: t.p };
    }
    return reject(t);
  }

  /* if A then B elif C then D else E end. jq lets the else be left out, in
     which case a false condition passes the input through unchanged. */
  function conditional(): Ast {
    const p = peek().p;
    at++;
    const cond = expr();
    wantWord('then');
    const yes = expr();
    if (isWord('elif')) return { op: 'if', c: cond, t: yes, f: conditional(), p: p };
    let no: Ast;
    if (isWord('else')) { at++; no = expr(); } else { no = { op: '.', p: p }; }
    wantWord('end');
    return { op: 'if', c: cond, t: yes, f: no, p: p };
  }

  /* {a: .x, "b": 1, (.k): 2, c} -- a bare key is shorthand for c: .c. */
  function object(p: number): Ast {
    const entries: Entry[] = [];
    if (eat('}')) return { op: 'object', entries: entries, p: p };
    for (;;) {
      const t = peek();
      let key: Ast;
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
      let val: Ast;
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
  const ast = expr();
  if (peek().k !== 'eof') reject(peek());
  return ast;
}

/* The segments of a query that is only a walk down the document, in the
   form parsePath produces, or null for anything else. query/ui.ts uses it to
   keep the old behaviour for a pasted path: highlight the node in the
   document rather than replacing the view with a copy of it. */
export function pathSegs(a: Ast): Segment[] | null {
  if (a.op === '.') return [];
  if (a.op === 'field') {
    const base = pathSegs(a.src);
    return base && base.concat([{ key: a.name }]);
  }
  if (a.op === 'index') {
    const v = constant(a.e);
    const base = v && pathSegs(a.src);
    if (!v || !base) return null;
    if (typeof v.r === 'string') return base.concat([{ key: v.r }]);
    if (typeof v.r === 'number' && v.r % 1 === 0) return base.concat([{ index: v.r }]);
  }
  return null;
}

/* The value a constant expression stands for, or null. A negative index is
   written as a minus over a literal rather than lexed as one, so .a[-1] has
   to be seen through to be recognised as a path. */
function constant(a: Ast): LeafNode | null {
  if (a.op === 'lit') return a.n;
  if (a.op === 'neg' && a.e.op === 'lit' && typeof a.e.n.r === 'number') {
    return leafOf(-a.e.n.r);
  }
  return null;
}
