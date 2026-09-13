/* Reading a query, first pass: the text to tokens, which parser.js reads by
   recursive descent. Positions are kept on every token so a parse error can
   point at the offending character. */

import { parseErr } from './errors.js';

var IDENT_HEAD = /[A-Za-z_]/;
var IDENT_TAIL = /[A-Za-z0-9_]/;
var DIGIT = /[0-9]/;

/* Longest first, so "==" is not read as two "=" and "//" is not read as two
   "/". The ones this subset rejects are still lexed, so that the parser can
   name them instead of stopping at a character it does not recognise. */
var OPS = ['?//', '==', '!=', '<=', '>=', '//', '|=', '+=', '-=', '*=', '/=',
  '%=', '..', '|', ',', '(', ')', '[', ']', '{', '}', ':', ';', '+', '-',
  '*', '%', '/', '<', '>', '=', '?', '.'];

var ESCAPES = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f',
  n: '\n', r: '\r', t: '\t'
};

function lex(src) {
  var toks = [], i = 0, c, p, j, buf, d, e, hex, name;
  while (i < src.length) {
    c = src.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    /* jq takes "#" to the end of the line as a comment. */
    if (c === '#') {
      while (i < src.length && src.charAt(i) !== '\n') i++;
      continue;
    }
    p = i;
    if (c === '"') {
      j = i + 1;
      buf = '';
      for (;;) {
        if (j >= src.length) throw parseErr('unterminated string', p);
        d = src.charAt(j);
        if (d === '"') { j++; break; }
        if (d !== '\\') { buf += d; j++; continue; }
        e = src.charAt(j + 1);
        if (e === '(') throw parseErr('string interpolation is not supported', j);
        if (ESCAPES[e] !== undefined) { buf += ESCAPES[e]; j += 2; continue; }
        if (e === 'u') {
          hex = src.substr(j + 2, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw parseErr('bad \\u escape', j);
          buf += String.fromCharCode(parseInt(hex, 16));
          j += 6;
          continue;
        }
        throw parseErr('bad escape "\\' + e + '"', j);
      }
      toks.push({ k: 'str', v: buf, p: p });
      i = j;
      continue;
    }
    if (DIGIT.test(c)) {
      j = i;
      while (j < src.length && DIGIT.test(src.charAt(j))) j++;
      if (src.charAt(j) === '.') {
        j++;
        while (j < src.length && DIGIT.test(src.charAt(j))) j++;
      }
      if (src.charAt(j) === 'e' || src.charAt(j) === 'E') {
        j++;
        if (src.charAt(j) === '+' || src.charAt(j) === '-') j++;
        while (j < src.length && DIGIT.test(src.charAt(j))) j++;
      }
      toks.push({ k: 'num', v: +src.slice(i, j), p: p });
      i = j;
      continue;
    }
    /* ".name" is one token: it is a suffix rather than a "." applied to
       something called name, and keeping it together is what lets the
       parser tell .a.b from a call. */
    if (c === '.' && IDENT_HEAD.test(src.charAt(i + 1))) {
      j = i + 1;
      while (j < src.length && IDENT_TAIL.test(src.charAt(j))) j++;
      toks.push({ k: 'field', v: src.slice(i + 1, j), p: p });
      i = j;
      continue;
    }
    if (IDENT_HEAD.test(c)) {
      j = i;
      while (j < src.length && IDENT_TAIL.test(src.charAt(j))) j++;
      name = src.slice(i, j);
      /* "and" and "or" are written as words but behave as operators, so
         they are lexed as ones and the parser needs no special case. */
      toks.push(name === 'and' || name === 'or'
        ? { k: 'op', v: name, p: p } : { k: 'ident', v: name, p: p });
      i = j;
      continue;
    }
    if (c === '$' || c === '@') {
      j = i + 1;
      while (j < src.length && IDENT_TAIL.test(src.charAt(j))) j++;
      toks.push({ k: c === '$' ? 'var' : 'format', v: src.slice(i, j), p: p });
      i = j;
      continue;
    }
    for (j = 0; j < OPS.length; j++) {
      if (src.substr(i, OPS[j].length) === OPS[j]) break;
    }
    if (j === OPS.length) throw parseErr('unexpected "' + c + '"', p);
    toks.push({ k: 'op', v: OPS[j], p: p });
    i += OPS[j].length;
  }
  toks.push({ k: 'eof', v: '', p: src.length });
  return toks;
}

export { lex };
