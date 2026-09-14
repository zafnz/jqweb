/* Regular expressions, for test, match, capture, scan, split/2, splits, sub
   and gsub. */

import { leafOf } from '../../model/node.ts';
import type { Node, ObjectNode } from '../../model/node.ts';
import { runErr } from './errors.ts';
import { collect, ev, tick } from './evaluate.ts';
import type { Emit } from './evaluate.ts';
import type { Ast } from './parser.ts';
import { FALSE, NULL, TRUE, arrayOf, chars, distinct, field, is, num, objectOf,
  typeOf, wantType } from './values.ts';

/* jq's regular expressions are Oniguruma and these are JavaScript's, which
   agree on ordinary patterns and part ways in the corners.

   What a query's modifier string asks for. jq's letters are g, i, x, n, s,
   m, p and l: g repeats the match, i is JavaScript's i, x lets the pattern
   carry blank space and comments, n leaves out empty matches, and m and p
   make "." match a newline, which is JavaScript's s. jq's s makes ^ and $
   mean the ends of the string, which they already do here, so it adds
   nothing. l asks for the longest of the alternatives, which JavaScript's
   matcher cannot do, so it is refused. */
interface Mode {
  global: boolean;
  flags: string;
  extended: boolean;
  notEmpty: boolean;
}

/* The modifiers of a regex builtin: a string of the letters above, or
   null for none. */
export function modeOf(flags: Node): Mode {
  const mode: Mode = { global: false, flags: '', extended: false, notEmpty: false };
  if (is(flags, 'null')) return mode;
  if (!is(flags, 'string')) throw runErr(typeOf(flags) + ' is not a string');
  for (let i = 0; i < flags.r.length; i++) {
    const c = flags.r.charAt(i);
    if (c === 'g') mode.global = true;
    else if (c === 'i') mode.flags = mode.flags.replace('i', '') + 'i';
    else if (c === 'x') mode.extended = true;
    else if (c === 'n') mode.notEmpty = true;
    else if (c === 'm' || c === 'p') mode.flags = mode.flags.replace('s', '') + 's';
    else if (c === 'l') throw runErr('the l modifier is not supported');
    else if (c !== 's') throw runErr(c + ' is not a valid modifier string');
  }
  return mode;
}

/* The pattern with the blank space and #-comments the x modifier allows
   taken out, outside character classes and escapes. This is the pattern
   both the matcher and groupNames read, so a bracket inside a comment does
   not count as a group. */
function unextend(p: string): string {
  let out = '';
  let inClass = false;
  let i = 0;
  while (i < p.length) {
    const c = p.charAt(i);
    if (c === '\\') { out += p.slice(i, i + 2); i += 2; continue; }
    if (inClass) {
      if (c === ']') inClass = false;
      out += c;
    } else if (c === '[') {
      inClass = true;
      out += c;
    } else if (c === '#') {
      while (i < p.length && p.charAt(i) !== '\n') i++;
    } else if (!/\s/.test(c)) {
      out += c;
    }
    i++;
  }
  return out;
}

/* Compiles a pattern already stripped for x. Always with d, so the indices
   of the groups can be read; the matcher adds g or y as it needs. */
function regex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags + 'd');
  } catch (e) {
    throw runErr('bad regular expression: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/* A match that is not empty, starting at "at", where the search found an
   empty one: the n modifier asks for the alternative that takes a
   character when the pattern has one, as "a*|b" does on "b". JavaScript
   has no such option, so the pattern is tried again at that one place
   with a lookbehind that fails at its end unless the end is past the
   start, which makes the matcher back into the other alternatives. */
function nonEmptyAt(pattern: string, mode: Mode, s: string, at: number): RegExpExecArray | null {
  const re = regex('(?:' + pattern + ')(?<=^[\\s\\S]{' + (at + 1) + ',})', mode.flags + 'y');
  re.lastIndex = at;
  return re.exec(s);
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
   {offset, length, string, captures: [{offset, length, string, name}]},
   each handed to found as it is made, so a consumer that has enough can
   stop the search. */
function matchesOf(x: Node, pattern: string, mode: Mode, global: boolean, found: (m: ObjectNode) => void): void {
  const s = wantType(x, 'string', 'match').r;
  const src = mode.extended ? unextend(pattern) : pattern;
  const re = regex(src, mode.flags + 'g');
  const names = groupNames(src);
  const off = charOffsets(s);
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '' && mode.notEmpty) {
      const alt = nonEmptyAt(src, mode, s, m.index);
      if (alt === null) {
        re.lastIndex = m.index + step(s, m.index);
        tick();
        continue;
      }
      m = alt;
      re.lastIndex = m.index + m[0].length;
    }
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
    found(objectOf(['offset', 'length', 'string', 'captures'],
      [leafOf(off[m.index]), leafOf(off[m.index + m[0].length] - off[m.index]),
        leafOf(m[0]), arrayOf(caps)]));
    if (!global) break;
    /* An empty match would otherwise be found at the same place for ever. */
    if (m[0] === '') re.lastIndex += step(s, re.lastIndex);
    tick();
  }
}

/* The width of the character at i: a search resumed between the halves of
   a surrogate pair finds the same empty match again. */
function step(s: string, i: number): number {
  const c = s.charCodeAt(i);
  return c >= 0xD800 && c < 0xDC00 ? 2 : 1;
}

/* Every match, for the operations that need all of them before they can
   say anything. */
function allMatches(x: Node, pattern: string, mode: Mode, global: boolean): ObjectNode[] {
  const out: ObjectNode[] = [];
  matchesOf(x, pattern, mode, global, function (m) { out.push(m); });
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
export function splitOn(x: Node, pattern: string, mode: Mode, emit: Emit): void {
  const s = wantType(x, 'string', 'splits').r;
  const cs = chars(s);
  const ms = allMatches(x, pattern, mode, true);
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
  const ms = allMatches(x, wantType(re, 'string', name).r, modeOf(flags), global);
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
export type Matcher = (x: Node, pattern: string, mode: Mode, emit: Emit) => void;

/* A regex builtin's pattern and flags come from its arguments, and jq runs
   the whole thing once per combination of them, the flags on the outside. */
export function withRe(x: Node, args: Ast[], arity: number, run: Matcher, emit: Emit): void {
  const over = function (f: Node): void {
    const mode = modeOf(f);
    ev(args[0], x, function (p) {
      run(x, wantType(p, 'string', 'a regex').r, mode, emit);
    });
  };
  if (arity > 1) ev(args[1], x, over);
  else over(NULL);
}

export function matchOne(x: Node, pattern: string, mode: Mode, emit: Emit): void {
  matchesOf(x, pattern, mode, mode.global, emit);
}
export function testOne(x: Node, pattern: string, mode: Mode, emit: Emit): void {
  let found = false;
  matchesOf(x, pattern, mode, false, function () { found = true; });
  emit(found ? TRUE : FALSE);
}
export function captureOne(x: Node, pattern: string, mode: Mode, emit: Emit): void {
  matchesOf(x, pattern, mode, mode.global, function (m) { emit(captureObject(m)); });
}
/* scan gives the matched text, or the captures when the pattern has any. */
export function scanOne(x: Node, pattern: string, mode: Mode, emit: Emit): void {
  matchesOf(x, pattern, mode, true, function (m) {
    const caps = wantType(field(m, 'captures'), 'array', 'scan').v;
    emit(caps.length
      ? arrayOf(caps.map(function (c) { return field(c, 'string'); }))
      : field(m, 'string'));
  });
}
