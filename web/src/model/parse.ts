/* Reading the embedded document into nodes. */

import type { Node } from './node.ts';
import { esc, quote } from './escape.ts';
import { span } from './render.ts';

/* The embedded document is compact JSON, parsed here rather than with
   JSON.parse because the tree shows object keys in document order and
   numbers exactly as written, neither of which survives JSON.parse. The
   nodes it returns are described in node.ts.

   This is a recursive-descent scanner over src. The read position i lives
   here, and the three helpers below close over it: each one advances i as a
   side effect rather than taking and returning a position, which is what
   keeps their call sites short enough to read. Nothing validates the input,
   because the Go side has already rejected anything that is not a single
   well-formed JSON document. */
export function parseJSON(src: string): Node {
  let i = 0;

  /* Skips whitespace by advancing the shared i. Every JSON space character
     (space, tab, CR, LF) is <= 32, and nothing else in a well-formed document
     is. */
  function ws(): void { while (i < src.length && src.charCodeAt(i) <= 32) i++; }

  /* Reads a string literal starting at src[i] and returns its value. Walks
     to the closing quote (34), stepping two characters past a backslash (92)
     so that an escaped quote does not end the scan, then hands the slice --
     quotes included -- to JSON.parse to undo the escaping. */
  function str(): string {
    const start = i++;
    while (src.charCodeAt(i) !== 34) i += src.charCodeAt(i) === 92 ? 2 : 1;
    return JSON.parse(src.slice(start, ++i));
  }

  /* Reads one value at src[i] and returns its node, recursing for members
     and elements. */
  function value(): Node {
    ws();
    const c = src.charAt(i);
    if (c === '{') {
      const keys: string[] = [];
      const vals: Node[] = [];
      i++; ws();
      if (src.charAt(i) === '}') {
        i++;
      } else {
        /* Read "key": value pairs. The post-increment in the test consumes
           the separator that follows each pair, which is either a comma
           (keep going) or the closing brace (stop). */
        for (;;) {
          ws();
          keys.push(str());
          ws(); i++;                 /* ':' */
          vals.push(value());
          ws();
          if (src.charAt(i++) === '}') break;
        }
      }
      return { t: 'o', k: keys, v: vals };
    }
    if (c === '[') {
      const vals: Node[] = [];
      i++; ws();
      if (src.charAt(i) === ']') {
        i++;
      } else {
        /* As above: the separator after each element is consumed by the
           test, and tells us whether another element follows. value()
           leaves i on it, so only trailing whitespace needs skipping. */
        for (;;) {
          vals.push(value());
          ws();
          if (src.charAt(i++) === ']') break;
        }
      }
      return { t: 'a', v: vals };
    }
    if (c === '"') {
      const lit = str();
      return { t: 'l', r: lit, h: span('str', esc(quote(lit))) };
    }
    /* Anything else is a number or one of the three literals. Read up to
       whatever ends it -- a delimiter or whitespace -- and keep the text
       exactly as written, since that is the point of not using JSON.parse.
       The class is then decided by the text itself, for coloring. */
    const start = i;
    while (i < src.length && ',]}'.indexOf(src.charAt(i)) < 0 && src.charCodeAt(i) > 32) i++;
    const lit = src.slice(start, i);
    if (lit === 'null') return { t: 'l', r: null, h: span('null', lit) };
    if (lit === 'true' || lit === 'false') return { t: 'l', r: lit === 'true', h: span('bool', lit) };
    return { t: 'l', r: +lit, n: lit, h: span('num', lit) };
  }

  return value();
}
