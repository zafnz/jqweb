/* Regular expressions, for test, match, capture, scan, split/2, splits, sub
   and gsub. */

import { leafOf } from '../../model/node.ts';
import { runErr } from './errors.js';
import { ev, push, tick } from './evaluate.js';
import { FALSE, NULL, TRUE, arrayOf, chars, distinct, field, objectOf, typeOf,
  wantType } from './values.js';

/* jq's regular expressions are Oniguruma and these are JavaScript's, which
   agree on ordinary patterns and part ways in the corners. Only the flags
   with a JavaScript equivalent are accepted. */
var RE_FLAGS = 'gimsuy';

function regex(pattern, flags) {
  var i;
  for (i = 0; i < flags.length; i++) {
    /* "d" and the second "g" are added by the matcher, not by the query. */
    if (RE_FLAGS.indexOf(flags.charAt(i)) < 0 && flags.charAt(i) !== 'd') {
      throw runErr('unsupported regex flag "' + flags.charAt(i) + '"');
    }
  }
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw runErr('bad regular expression: ' + e.message);
  }
}

/* jq counts characters and JavaScript indexes strings by 16-bit unit, so
   every offset a match reports has to be converted. This maps each unit
   index to the character index at or before it; a surrogate pair takes two
   units and counts once. */
function charOffsets(s) {
  var map = new Array(s.length + 1), at = 0, i = 0, c;
  while (i < s.length) {
    map[i] = at;
    c = s.charCodeAt(i);
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
function groupNames(pattern) {
  var names = [null], inClass = false, i = 0, c, m;
  while (i < pattern.length) {
    c = pattern.charAt(i);
    if (c === '\\') { i += 2; continue; }
    if (inClass) {
      if (c === ']') inClass = false;
      i++;
      continue;
    }
    if (c === '[') { inClass = true; i++; continue; }
    if (c !== '(') { i++; continue; }
    if (pattern.charAt(i + 1) !== '?') { names.push(null); i++; continue; }
    m = /^\(\?<([A-Za-z_$][A-Za-z0-9_$]*)>/.exec(pattern.slice(i));
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
function matchesOf(x, pattern, flags, global) {
  var s = wantType(x, 'string', 'match').r;
  var re = regex(pattern, flags.replace(/g/g, '') + 'gd');
  var names = groupNames(pattern), off = charOffsets(s), out = [], m, i, at;
  while ((m = re.exec(s)) !== null) {
    var caps = [];
    for (i = 1; i < m.length; i++) {
      at = m.indices[i];
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
function captureObject(match) {
  var caps = field(match, 'captures').v, keys = [], vals = [], name, i;
  for (i = 0; i < caps.length; i++) {
    name = field(caps[i], 'name');
    if (typeOf(name) === 'string') {
      keys.push(name.r);
      vals.push(field(caps[i], 'string'));
    }
  }
  return distinct(objectOf(keys, vals));
}

/* The pieces of a string either side of every match. */
function splitOn(x, pattern, flags) {
  var s = wantType(x, 'string', 'splits').r;
  var cs = chars(s), ms = matchesOf(x, pattern, flags, true), out = [], at = 0, i, m;
  for (i = 0; i < ms.length; i++) {
    m = ms[i];
    out.push(leafOf(cs.slice(at, field(m, 'offset').r).join('')));
    at = field(m, 'offset').r + field(m, 'length').r;
  }
  out.push(leafOf(cs.slice(at).join('')));
  return out;
}

/* Replaces matches, running the replacement as a filter over each match's
   named captures -- gsub("(?<c>l)"; "[" + .c + "]") is jq's own example. A
   replacement that yields several values yields several whole strings, so
   the results are built across the matches rather than one at a time. */
function substitute(x, pattern, replacement, flags, global) {
  var s = wantType(x, 'string', 'sub').r;
  var cs = chars(s), ms = matchesOf(x, pattern, flags, global), out = [];
  build(0, 0, '');
  return out;

  function build(i, at, acc) {
    tick();
    if (i === ms.length) {
      out.push(leafOf(acc + cs.slice(at).join('')));
      return;
    }
    var m = ms[i], start = field(m, 'offset').r, len = field(m, 'length').r;
    var before = acc + cs.slice(at, start).join('');
    var reps = ev(replacement, captureObject(m)), j;
    for (j = 0; j < reps.length; j++) {
      build(i + 1, start + len, before + wantType(reps[j], 'string', 'sub').r);
    }
  }
}

/* A regex builtin's pattern and flags come from its arguments, and jq runs
   the whole thing once per combination of them. */
function withRe(x, args, arity, run) {
  var pats = ev(args[0], x), flags = arity > 1 ? ev(args[1], x) : [leafOf('')];
  var out = [], i, j;
  for (i = 0; i < flags.length; i++) {
    for (j = 0; j < pats.length; j++) {
      push(out, run(x, wantType(pats[j], 'string', 'a regex').r,
        typeOf(flags[i]) === 'string' ? flags[i].r : ''));
    }
  }
  return out;
}

/* The single value an argument stands for, where a stream would make no
   sense -- the pattern of a substitution, whose replacement is already run
   once per match. */
function one(arg, x, name) {
  var vals = ev(arg, x);
  if (!vals.length) throw runErr(name + ' needs a pattern');
  return wantType(vals[0], 'string', name).r;
}

function matchOne(x, pattern, flags) {
  return matchesOf(x, pattern, flags, flags.indexOf('g') >= 0);
}
function testOne(x, pattern, flags) {
  return [matchesOf(x, pattern, flags, false).length ? TRUE : FALSE];
}
function captureOne(x, pattern, flags) {
  return matchOne(x, pattern, flags).map(captureObject);
}
/* scan gives the matched text, or the captures when the pattern has any. */
function scanOne(x, pattern, flags) {
  return matchesOf(x, pattern, flags.replace(/g/g, '') + 'g', true).map(function (m) {
    var caps = field(m, 'captures').v;
    return caps.length
      ? arrayOf(caps.map(function (c) { return field(c, 'string'); }))
      : field(m, 'string');
  });
}

function match(x, patArg, flagArg) {
  var s = wantType(x, 'string', 'test').r;
  var pats = ev(patArg, x), flags = flagArg ? ev(flagArg, x) : [leafOf('')];
  var out = [], i, j;
  for (i = 0; i < flags.length; i++) {
    for (j = 0; j < pats.length; j++) {
      out.push(regex(wantType(pats[j], 'string', 'test').r,
        wantType(flags[i], 'string', 'test').r).test(s) ? TRUE : FALSE);
    }
  }
  return out;
}

export { captureOne, match, matchOne, one, scanOne, splitOn, substitute,
  testOne, withRe };
