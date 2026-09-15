/* The value model. A document is held as these nodes rather than as
   JavaScript values, so an object keeps its keys in document order,
   duplicates included, and a number keeps the text it was written with.
   parse.ts builds them from the document; the renderer and the jq engine both
   read the same nodes, so a query result renders without being parsed again.
   Nothing here touches the DOM. */

import { esc, quote } from './escape.ts';
import { span } from './render.ts';

/* A JSON scalar, as the jq engine compares and computes with it. */
export type Scalar = string | number | boolean | null;

/* A scalar. r is the value itself and h its rendered markup. A number leaf
   also carries n, its text: as written in the document, or as JavaScript
   prints a computed number. stringify writes n rather than r, so a number
   that has not been computed with comes back as the document had it. */
export interface LeafNode {
  t: 'l';
  r: Scalar;
  n?: string;
  h: string;
}

/* An object. k and v are parallel arrays rather than a map, which keeps
   duplicate keys and their order. */
export interface ObjectNode {
  t: 'o';
  k: string[];
  v: Node[];
}

export interface ArrayNode {
  t: 'a';
  v: Node[];
}

export type Node = ObjectNode | ArrayNode | LeafNode;

/* Builds a leaf node for a scalar that was computed rather than read from
   the document, which is where every result of arithmetic, length, keys and
   the rest comes from. A number has no text as written, so it is rendered
   the way JavaScript prints it. */
export function leafOf(v: Scalar): LeafNode {
  if (v === null) return { t: 'l', r: null, h: span('null', 'null') };
  if (v === true || v === false) return { t: 'l', r: v, h: span('bool', String(v)) };
  if (typeof v === 'number') {
    /* JSON has no way to write a NaN or an infinity. The value is kept as
       it is, so that what is computed from it next comes out as jq's would,
       and only its text is jq's: null for a NaN, and the largest double for
       an infinity, so 1000 | exp shows as 1.7976931348623157e+308 and
       (1000 | exp) / 2 shows the same. */
    if (v !== v) return { t: 'l', r: v, n: 'null', h: span('null', 'null') };
    const text = String(v === Infinity ? Number.MAX_VALUE : v === -Infinity ? -Number.MAX_VALUE : v);
    return { t: 'l', r: v, n: text, h: span('num', text) };
  }
  return { t: 'l', r: v, h: span('str', esc(quote(v))) };
}

/* Writes a node back out as JSON text. With indent -- a string such as two
   spaces -- containers are broken across lines; without it the result is
   compact. A number is written from the text it was read with, so a value
   that has not been computed with comes back exactly as the document had
   it. */
export function stringify(node: Node, indent?: string): string {
  const out: string[] = [];
  write(node, '');
  return out.join('');

  function write(n: Node, pad: string): void {
    if (n.t === 'l') {
      out.push(typeof n.r === 'string' ? quote(n.r)
        : typeof n.r === 'number' ? (n.n !== undefined ? n.n : String(n.r))
          : String(n.r));
      return;
    }
    const obj = n.t === 'o';
    if (!n.v.length) { out.push(obj ? '{}' : '[]'); return; }
    const inner = pad + (indent || '');
    const nl = indent ? '\n' : '';
    out.push((obj ? '{' : '[') + nl);
    for (let i = 0; i < n.v.length; i++) {
      out.push(inner);
      if (obj) out.push(quote(n.k[i]) + (indent ? ': ' : ':'));
      write(n.v[i], inner);
      out.push(i < n.v.length - 1 ? ',' + nl : nl);
    }
    out.push(pad + (obj ? '}' : ']'));
  }
}
