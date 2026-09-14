/* Regular expressions, for test, match, capture, scan, split/2, splits, sub
   and gsub. */

import { leafOf } from '../../model/node.ts';
import type { Node, ObjectNode } from '../../model/node.ts';
import { runErr } from './errors.ts';
import { collect, ev, tick } from './evaluate.ts';
import type { Emit } from './evaluate.ts';
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
function matchesOf(x: Node, pattern: string, flags: string, global: boolean): ObjectNode[] {
  const s = wantType(x, 'string', 'match').r;
  const re = regex(pattern, flags.replace(/g/g, '') + 'gd');
  const names = groupNames(pattern);
  const off = charOffsets(s);
  const out: ObjectNode[] = [];
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
    out.push(objectOf(['offset', 'length', 'string', 'captures'],
      [leafOf(off[m.index]), leafOf(off[m.index + m[0].length] - off[m.index]),
        leafOf(m[0]), arrayOf(caps)]));
    if (!global) break;
    /* An empty match would otherwise be found at the same place for ever. */
    if (m[0] === '') re.lastIndex++;
    tick();
  }
  return out;
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
export function splitOn(x: Node, pattern: string, flags: string, emit: Emit): void {
  const s = wantType(x, 'string', 'splits').r;
  const cs = chars(s);
  const ms = matchesOf(x, pattern, flags, true);
  let at = 0;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    emit(leafOf(cs.slice(at, num(field(m, 'offset'), 'splits')).join('')));
    at = num(field(m, 'offset'), 'splits') + num(field(m, 'length'), 'splits');
  }
  emit(leafOf(cs.slice(at).join('')));
}

/* Replaces matches, running the replacement as a filter over each match's
   named captures -- gsub("(?<c>l)"; "[" + .c + "]") is jq's own example.
   This is jq 1.7's definition: the replacement's outputs are numbered, and
   the n-th result is built from the n-th output at every match that has
   one, so gsub("X"; ("1","2")) on "aXbX" gives "a1b1" and "a2b2". A match
   with fewer outputs than the others contributes nothing to the later
   results, not even the text before it, and no results at all leaves the
   input as it was. */
export function substitute(x: Node, re: Node, replacement: Ast, flags: Node, global: boolean, emit: Emit): void {
  const name = global ? 'gsub' : 'sub';
  const s = wantType(x, 'string', name).r;
  const cs = chars(s);
  const ms = matchesOf(x, wantType(re, 'string', name).r, is(flags, 'string') ? flags.r : '', global);
  const results: string[] = [];
  let previous = 0;
  for (let i = 0; i < ms.length; i++) {
    tick();
    const start = num(field(ms[i], 'offset'), name);
    const gap = cs.slice(previous, start).join('');
    const inserts = collect(replacement, captureObject(ms[i]));
    for (let j = 0; j < inserts.length; j++) {
      results[j] = (results[j] || '') + gap + wantType(inserts[j], 'string', name).r;
    }
    previous = start + num(field(ms[i], 'length'), name);
  }
  if (!results.length) {
    emit(x);
    return;
  }
  const tail = cs.slice(previous).join('');
  for (let j = 0; j < results.length; j++) emit(leafOf((results[j] || '') + tail));
}

/* One regex operation over a string, sending what it finds to emit. */
export type Matcher = (x: Node, pattern: string, flags: string, emit: Emit) => void;

/* A regex builtin's pattern and flags come from its arguments, and jq runs
   the whole thing once per combination of them, the flags on the outside. */
export function withRe(x: Node, args: Ast[], arity: number, run: Matcher, emit: Emit): void {
  const over = function (f: Node): void {
    ev(args[0], x, function (p) {
      run(x, wantType(p, 'string', 'a regex').r, is(f, 'string') ? f.r : '', emit);
    });
  };
  if (arity > 1) ev(args[1], x, over);
  else over(leafOf(''));
}

export function matchOne(x: Node, pattern: string, flags: string, emit: Emit): void {
  const ms = matchesOf(x, pattern, flags, flags.indexOf('g') >= 0);
  for (let i = 0; i < ms.length; i++) emit(ms[i]);
}
export function testOne(x: Node, pattern: string, flags: string, emit: Emit): void {
  emit(matchesOf(x, pattern, flags, false).length ? TRUE : FALSE);
}
export function captureOne(x: Node, pattern: string, flags: string, emit: Emit): void {
  const ms = matchesOf(x, pattern, flags, flags.indexOf('g') >= 0);
  for (let i = 0; i < ms.length; i++) emit(captureObject(ms[i]));
}
/* scan gives the matched text, or the captures when the pattern has any. */
export function scanOne(x: Node, pattern: string, flags: string, emit: Emit): void {
  const ms = matchesOf(x, pattern, flags.replace(/g/g, '') + 'g', true);
  for (let i = 0; i < ms.length; i++) {
    const caps = wantType(field(ms[i], 'captures'), 'array', 'scan').v;
    emit(caps.length
      ? arrayOf(caps.map(function (c) { return field(c, 'string'); }))
      : field(ms[i], 'string'));
  }
}
