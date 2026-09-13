/* The markup for the tree, and for the value on each leaf. */

import type { Node } from './node.ts';
import { esc, quote } from './escape.ts';

/* Wraps a rendered value in the span the stylesheet colors by class. */
export function span(cls: 'str' | 'num' | 'bool' | 'null', text: string): string {
  return '<span class="v ' + cls + '">' + text + '</span>';
}

/* The buttons at the end of every line. The second one only goes into a page
   that can act on it -- it opens a list of queries built from the line, which
   needs the query engine -- so renderTree is told whether to emit it, and the
   pair is worked out once per tree rather than once per line. */
const CP = '<button class="cp" title="Copy path">&#x29C9;</button>';
const FQ = '<button class="fq" title="Filter on this value">&#x2261;</button>';
let buttons = CP;

/* Renders a parsed document as the markup for the whole tree. The caller
   assigns it to innerHTML in one go: for a large document that is around
   twice as fast as building the same nodes with createElement, and it keeps
   this file free of the DOM. */
export function renderTree(root: Node, withFilter?: boolean): string {
  const out: string[] = [];
  buttons = withFilter ? CP + FQ : CP;
  emit(out, root, null, -1, false);
  return out.join('');
}

/* Emits one tree node. key is non-null for object members, idx >= 0 for
   array elements; the root has neither. comma appends a trailing comma.

   Fragments are pushed onto out rather than concatenated, and children are
   emitted between their parent's opening and closing fragments, so the
   recursion writes the markup in document order.

   Every node is <div class="node ..."> wrapping a <div class="line">, and a
   branch adds <div class="kids"> for its children and a <div class="closer">
   for the bracket that follows them. The key or index is repeated in a data
   attribute, which is what page.js reads back to reconstruct a path. */
function emit(out: string[], node: Node, key: string | null, idx: number, comma: boolean): void {
  const attrs = key !== null ? ' data-key="' + esc(key) + '"'
    : idx >= 0 ? ' data-index="' + idx + '"' : '';
  /* A member's copy button sits right after its key; an array element or
     the root has no key to sit after, so its button goes at the end. */
  let keyPart = '', endBtn = buttons;   /* unkeyed nodes get the buttons at the end of the line */
  if (key !== null) {
    keyPart = '<span class="key">' + esc(quote(key)) + '</span>' + buttons +
      '<span class="pn">: </span>';
    endBtn = '';
  }
  const c = comma ? '<span class="c">,</span>' : '';

  /* A scalar is one line. The empty .sp span aligns it with the branches,
     whose toggle button occupies that space. */
  if (node.t === 'l') {
    out.push('<div class="node leaf"' + attrs + '><div class="line"><span class="sp"></span>' +
      keyPart + node.h + c + endBtn + '</div></div>');
    return;
  }
  const obj = node.t === 'o';
  const open = obj ? '{' : '[';
  const close = obj ? '}' : ']';
  const n = node.v.length;
  /* An empty container has nothing to expand, so it renders as a leaf
     showing both brackets together. */
  if (!n) {
    out.push('<div class="node leaf"' + attrs + '><div class="line"><span class="sp"></span>' +
      keyPart + '<span class="p">' + open + close + '</span>' + c + endBtn + '</div></div>');
    return;
  }
  /* A branch line carries both states: the opening bracket, shown when
     expanded, and a .fold summary ("... 3 items }"), shown when collapsed.
     The stylesheet picks which by the node's collapsed class. */
  const noun = (obj ? 'key' : 'item') + (n === 1 ? '' : 's');
  out.push('<div class="node branch"' + attrs +
    '><div class="line"><button class="toggle" aria-label="Toggle"></button>' +
    keyPart + '<span class="p">' + open + '</span>' +
    '<span class="fold"> &#x2026; ' + n + ' ' + noun + ' <span class="p">' + close + '</span>' +
    c + '</span>' + endBtn + '</div><div class="kids">');
  /* Children carry their own key or index, and every child but the last is
     followed by a comma. */
  for (let j = 0; j < n; j++) {
    emit(out, node.v[j], obj ? node.k[j] : null, obj ? -1 : j, j < n - 1);
  }
  out.push('</div><div class="closer"><span class="p">' + close + '</span>' + c + '</div></div>');
}
