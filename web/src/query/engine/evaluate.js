/* Running a parsed query against one input.

   A call carries the builtin the parser looked up for it, so this module does
   not import the builtin table, which imports ev from here. */

import { leafOf } from '../../model/node.ts';
import { runErr } from './errors.js';
import { FALSE, TRUE, add2, arrayOf, cmp, descend, distinct, div2, field,
  iterate, lookup, mod2, mul2, num, objectOf, slice, sub2, truthy,
  typeOf } from './values.js';

/* Evaluating a query that fans out -- ".. | select(...)" over a large
   document -- can do a lot of work before it produces anything. The counter
   bounds it so a mistyped query reports an error instead of hanging the
   tab. */
var STEP_LIMIT = 5000000;
var steps = 0;

/* Runs a whole query against one input. The step count starts again from
   nothing, so a query run many times is bounded on each run rather than
   across all of them. */
function evaluate(ast, input) {
  steps = 0;
  return ev(ast, input);
}

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
      return a.fn(x, a.args);
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

export { ev, evaluate, push, tick };
