/* Regular expressions, for test, match, capture, scan, split/2, splits, sub
   and gsub. */

import { leafOf } from '../../model/node.ts';
import type { Node, ObjectNode } from '../../model/node.ts';
import { runErr } from './errors.ts';
import { first } from './evaluate.ts';
import type { Evaluation, Stream } from './evaluate.ts';
import type { Ast } from './parser.ts';
import { FALSE, NULL, TRUE, arrayOf, chars, distinct, field, is, num, objectOf,
  wantType } from './values.ts';

/* jq's regular expressions are Oniguruma and these are JavaScript's, which
   agree on ordinary patterns and part ways in the corners. Only the flags
   with a JavaScript equivalent are accepted. */
const RE_FLAGS = 'gimsuy';

function regex(pattern: string, flags: string): RegExp {
  for (let i = 0; i < flags.length; i++) {
    /* "d" and the second "g" are added by the matcher, not by the query. */
    if (RE_FLAGS.indexOf(flags.charAt(i)) < 0 && flags.charAt(i) !== 'd') {
      throw runErr('unsupported regex flag "' + flags.charAt(i) + '"');
    }
  }
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw runErr('bad regular expression: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/* jq counts characters and JavaScript indexes strings by 16-bit unit, so
   every offset a match reports has to be converted. This maps each unit
   index to the character index at or before it; a surrogate pair takes two
   units and counts once. */
function charOffsets(s: string): number[] {
  const map: number[] = new Array(s.length + 1);
  let at = 0;
  let i = 0;
  while (i < s.length) {
    map[i] = at;
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c < 0xDC00 && i + 1 < s.length) {
      map[i + 1] = at;
      i += 2;
    } else {
      i += 1;
    }
    at++;
  }
  map[s.length] = at;
  return map;
}

/* The name of each capture group by its number, or null for an unnamed one.
   JavaScript reports named groups in a bag with no numbering, and jq lists
   every capture in order with its name attached, so the pattern is read for
   the order. Escapes and character classes are skipped, as are the "(?"
   forms that do not capture. */
function groupNames(pattern: string): (string | null)[] {
  const names: (string | null)[] = [null];
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === '\\') { i += 2; continue; }
    if (inClass) {
      if (c === ']') inClass = false;
      i++;
      continue;
    }
    if (c === '[') { inClass = true; i++; continue; }
    if (c !== '(') { i++; continue; }
    if (pattern.charAt(i + 1) !== '?') { names.push(null); i++; continue; }
    const m = /^\(\?<([A-Za-z_$][A-Za-z0-9_$]*)>/.exec(pattern.slice(i));
    if (m) {
      names.push(m[1]);
      i += m[0].length;
    } else {
      i += 2;
    }
  }
  return names;
}

/* Every match of a pattern in a string, as the objects jq's match produces:
   {offset, length, string, captures: [{offset, length, string, name}]}. */
function* matchesOf(x: Node, pattern: string, flags: string, global: boolean, ctx: Evaluation): Generator<ObjectNode> {
  const s = wantType(x, 'string', 'match').r;
  const re = regex(pattern, flags.replace(/g/g, '') + 'gd');
  const names = groupNames(pattern);
  const off = charOffsets(s);
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const indices = m.indices!;
    const caps: Node[] = [];
    for (let i = 1; i < m.length; i++) {
      const at = indices[i];
      caps.push(objectOf(['offset', 'length', 'string', 'name'],
        at ? [leafOf(off[at[0]]), leafOf(off[at[1]] - off[at[0]]),
          leafOf(m[i]), names[i] === undefined || names[i] === null ? NULL : leafOf(names[i])]
          : [leafOf(-1), leafOf(0), NULL,
            names[i] === undefined || names[i] === null ? NULL : leafOf(names[i])]));
    }
    yield objectOf(['offset', 'length', 'string', 'captures'],
      [leafOf(off[m.index]), leafOf(off[m.index + m[0].length] - off[m.index]),
        leafOf(m[0]), arrayOf(caps)]);
    if (!global) break;
    /* An empty match would otherwise be found at the same place for ever. */
    if (m[0] === '') re.lastIndex += re.unicode && s.codePointAt(re.lastIndex)! > 0xFFFF ? 2 : 1;
    ctx.tick();
  }
}

/* The named captures of one match as an object, which is what capture gives
   back and what the replacement in sub and gsub is run against. */
function captureObject(match: Node): ObjectNode {
  const caps = wantType(field(match, 'captures'), 'array', 'capture').v;
  const keys: string[] = [];
  const vals: Node[] = [];
  for (let i = 0; i < caps.length; i++) {
    const name = field(caps[i], 'name');
    if (is(name, 'string')) {
      keys.push(name.r);
      vals.push(field(caps[i], 'string'));
    }
  }
  return distinct(objectOf(keys, vals));
}

/* The pieces of a string either side of every match. */
export function* splitOn(x: Node, pattern: string, flags: string, ctx: Evaluation): Stream {
  const s = wantType(x, 'string', 'split').r;
  const cs = chars(s);
  let at = 0;
  for (const m of matchesOf(x, pattern, flags, true, ctx)) {
    yield leafOf(cs.slice(at, num(field(m, 'offset'), 'splits')).join(''));
    at = num(field(m, 'offset'), 'splits') + num(field(m, 'length'), 'splits');
  }
  yield leafOf(cs.slice(at).join(''));
}

/* Replaces matches, running the replacement as a filter over each match's
   named captures -- gsub("(?<c>l)"; "[" + .c + "]") is jq's own example. A
   replacement that yields several values yields several whole strings, so
   the results are built across the matches rather than one at a time. */
export function substitute(ctx: Evaluation, x: Node, pattern: string, replacement: Ast, flags: string, global: boolean): Stream {
  const s = wantType(x, 'string', 'sub').r;
  const cs = chars(s);
  const ms = Array.from(matchesOf(x, pattern, flags, global, ctx));
  // jq collects the replacement alternatives before emitting whole strings.
  return Array.from(build(0, 0, ''));

  function* build(i: number, at: number, acc: string): Stream {
    ctx.tick();
    if (i === ms.length) {
      yield leafOf(acc + cs.slice(at).join(''));
      return;
    }
    const m = ms[i];
    const start = num(field(m, 'offset'), 'sub');
    const len = num(field(m, 'length'), 'sub');
    const before = acc + cs.slice(at, start).join('');
    for (const rep of ctx.ev(replacement, captureObject(m))) {
      yield* build(i + 1, start + len, before + wantType(rep, 'string', 'sub').r);
    }
  }
}

/* A regex builtin's pattern and flags come from its arguments, and jq runs
   the whole thing once per combination of them. */
export function* withRe(ctx: Evaluation, x: Node, args: Ast[], arity: number,
  run: (x: Node, pattern: string, flags: string, ctx: Evaluation) => Stream,
  leftFirst = false): Stream {
  for (const vals of ctx.args(args.slice(0, arity), x, leftFirst)) {
    const pattern = wantType(vals[0], 'string', 'a regex').r;
    const flags = arity > 1 && !is(vals[1], 'null') ? wantType(vals[1], 'string', 'regex flags').r : '';
    yield* run(x, pattern, flags, ctx);
  }
}

export function matchOne(x: Node, pattern: string, flags: string, ctx: Evaluation): Stream {
  return matchesOf(x, pattern, flags, flags.includes('g'), ctx);
}
export function testOne(x: Node, pattern: string, flags: string, ctx: Evaluation): Stream {
  return [first(matchesOf(x, pattern, flags, false, ctx)) === undefined ? FALSE : TRUE];
}
export function* captureOne(x: Node, pattern: string, flags: string, ctx: Evaluation): Stream {
  for (const m of matchOne(x, pattern, flags, ctx)) yield captureObject(m);
}
/* scan gives the matched text, or the captures when the pattern has any. */
export function* scanOne(x: Node, pattern: string, flags: string, ctx: Evaluation): Stream {
  for (const m of matchesOf(x, pattern, flags, true, ctx)) {
    const caps = wantType(field(m, 'captures'), 'array', 'scan').v;
    yield caps.length
      ? arrayOf(caps.map(function (c) { return field(c, 'string'); }))
      : field(m, 'string');
  }
}
