/* Format strings: @base64 and the rest, which jq writes as a filter named
   with an @. builtins.js puts each in the builtin table under its own name. */

import { stringify } from '../../model/node.ts';
import { runErr } from './errors.js';
import { typeOf, wantType } from './values.js';

var FORMATS = {
  '@text': function (x) { return typeOf(x) === 'string' ? x.r : stringify(x); },
  '@json': function (x) { return stringify(x); },
  '@uri': function (x) {
    return asText(x).replace(/[^A-Za-z0-9\-_.~]/g, function (c) {
      return Array.prototype.map.call(utf8(c), function (b) {
        return '%' + (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
      }).join('');
    });
  },
  '@html': function (x) {
    return asText(x).replace(/[&<>'"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c];
    });
  },
  '@base64': function (x) { return base64(asText(x)); },
  '@base64d': function (x) { return unbase64(asText(x)); },
  '@csv': function (x) { return row(x, ',', true); },
  '@tsv': function (x) { return row(x, '\t', false); },
  '@sh': function (x) {
    var vals = x.t === 'a' ? x.v : [x];
    return vals.map(function (v) {
      if (typeOf(v) === 'string') return "'" + v.r.replace(/'/g, "'\\''") + "'";
      if (v.t === 'a' || v.t === 'o') throw runErr('cannot quote ' + typeOf(v) + ' for a shell');
      return stringify(v);
    }).join(' ');
  }
};

function asText(x) { return typeOf(x) === 'string' ? x.r : stringify(x); }

/* One row of @csv or @tsv. Both take an array; csv quotes strings and
   doubles the quotes inside them, tsv escapes the characters that would end
   a field or a line. */
function row(x, sep, quoted) {
  return wantType(x, 'array', 'a format string').v.map(function (v) {
    var t = typeOf(v);
    if (t === 'null') return '';
    if (t === 'number' || t === 'boolean') return stringify(v);
    if (t !== 'string') throw runErr(t + ' cannot go in a row');
    if (quoted) return '"' + v.r.replace(/"/g, '""') + '"';
    return v.r.replace(/\\/g, '\\\\').replace(/\t/g, '\\t')
      .replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }).join(sep);
}

/* UTF-8 bytes of a string, which @uri percent-encodes and @base64 packs. */
function utf8(s) {
  var out = [], i, c;
  for (i = 0; i < s.length; i++) {
    c = s.codePointAt(i);
    if (c > 0xFFFF) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(s) {
  var b = utf8(s), out = '', i, n;
  for (i = 0; i < b.length; i += 3) {
    n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
    out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63) +
      (i + 1 < b.length ? B64.charAt((n >> 6) & 63) : '=') +
      (i + 2 < b.length ? B64.charAt(n & 63) : '=');
  }
  return out;
}

function unbase64(s) {
  var clean = s.replace(/[^A-Za-z0-9+/]/g, ''), bytes = [], i, n, have;
  for (i = 0; i < clean.length; i += 4) {
    have = Math.min(4, clean.length - i);
    n = 0;
    for (var j = 0; j < 4; j++) n = (n << 6) | (j < have ? B64.indexOf(clean.charAt(i + j)) : 0);
    bytes.push((n >> 16) & 255);
    if (have > 2) bytes.push((n >> 8) & 255);
    if (have > 3) bytes.push(n & 255);
  }
  return fromUTF8(bytes);
}

/* Bytes back to a string. Anything that is not valid UTF-8 comes through as
   the replacement character, which is what jq does with it. */
function fromUTF8(b) {
  var out = '', i = 0, c, n, cp;
  while (i < b.length) {
    c = b[i];
    n = c < 0x80 ? 0 : c < 0xE0 ? 1 : c < 0xF0 ? 2 : 3;
    cp = n === 0 ? c : c & (0x3F >> n);
    for (var j = 1; j <= n; j++) cp = (cp << 6) | (b[i + j] & 63);
    out += i + n < b.length || n === 0 ? String.fromCodePoint(cp) : '\uFFFD';
    i += n + 1;
  }
  return out;
}

export { FORMATS };
