/* The rendered tree as the page reads it back: the path a line sits at, the
   line a path leads to, and bringing that line into view. All of it reads the
   data attributes emit() in model/render.ts writes on each node. */

import type { Segment } from '../model/path.ts';
import { pathText } from '../model/path.ts';

/* How far a path got: the deepest node reached and how many segments matched
   on the way. depth === segs.length is a full match. */
export interface Found {
  node: HTMLElement;
  depth: number;
}

/* Runs fn over every node in either view matching sel. querySelectorAll
   gives a NodeList, which in older browsers has no forEach of its own. */
export function each(sel: string, fn: (n: HTMLElement) => void): void {
  Array.prototype.forEach.call(document.querySelectorAll<HTMLElement>('main ' + sel), fn);
}

/* The tree node an element in a line belongs to. Every button and summary
   the renderer writes is inside one. */
export function nodeOf(el: Element): HTMLElement {
  const node = el.closest<HTMLElement>('.node');
  if (!node) throw new Error('jqweb: not inside a tree node');
  return node;
}

/* Where a node sits, as the segments parsePath produces, read back off the
   data attributes emit() wrote by walking up its ancestors.

   The walk stops at whichever tree the node is in, so in the result view the
   segments are relative to the result the node sits in rather than to the
   document. */
export function segsOf(node: HTMLElement): Segment[] {
  const segs: Segment[] = [];
  let n: HTMLElement | null = node;
  while (n) {
    if (n.dataset.index !== undefined) {
      segs.unshift({ index: +n.dataset.index });
    } else if (n.dataset.key !== undefined) {
      segs.unshift({ key: n.dataset.key });
    }
    /* Skip the .kids wrapper between a node and its parent node. */
    n = n.parentElement && n.parentElement.closest<HTMLElement>('.node');
  }
  return segs;
}

/* The jq-style path of a node, which is what parsePath() reads, so a copied
   path can be pasted straight back into the search box. */
export function pathOf(node: HTMLElement): string {
  return pathText(segsOf(node));
}

/* Walks segs from root, returning the deepest node reached and how many
   segments matched. A partial match is still useful, since it says where a
   path stopped resolving. */
export function resolvePath(root: HTMLElement, segs: Segment[]): Found {
  let node = root, i = 0;
  for (; i < segs.length; i++) {
    const next = childMatching(node, segs[i]);
    if (!next) break;
    node = next;
  }
  return { node: node, depth: i };
}

/* The child of node named by one path segment, or null. */
function childMatching(node: HTMLElement, seg: Segment): HTMLElement | null {
  const kids = node.querySelectorAll<HTMLElement>(':scope > .kids > .node');
  /* Keys are compared as text, because an object's members are in document
     order rather than sorted, so there is nothing to look them up by. */
  if (seg.key !== undefined) {
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].dataset.key === seg.key) return kids[i];
    }
    return null;
  }
  /* A negative index counts from the end, as in jq. The data-index check
     keeps a path from resolving against an object, whose children are in
     the same place but carry keys instead. */
  const i = seg.index < 0 ? kids.length + seg.index : seg.index;
  return kids[i] && kids[i].dataset.index === String(i) ? kids[i] : null;
}

/* Shows target with its whole subtree, plus the ancestors leading to it,
   and scrolls it into view below header. */
export function showPath(header: HTMLElement, target: HTMLElement, mark: boolean): void {
  each('.node', function (n) { n.classList.add('hidden'); n.classList.remove('hit'); });
  /* Reveal and expand the line of ancestors, so the target is reachable. */
  for (let n: HTMLElement | null = target; n; n = n.parentElement && n.parentElement.closest<HTMLElement>('.node')) {
    n.classList.remove('hidden', 'collapsed');
  }
  if (mark) target.classList.add('hit');
  Array.prototype.forEach.call(target.querySelectorAll('.node'), function (d: Element) {
    d.classList.remove('hidden');
  });
  reveal(header, target);
}

/* Scrolls a revealed node into view.

   Centring is right for a line, and wrong for anything taller than the
   window: the middle of a whole document is halfway down it, so typing "."
   -- which resolves to the root -- used to throw the reader into the middle
   of the file. A node that does not fit is put under the header by its top
   instead, and one already on screen is left where it is, so that typing a
   path one character at a time does not drag the page around. */
const GAP = 4;   /* a little air between the header and what it scrolled to */

function reveal(header: HTMLElement, target: HTMLElement): void {
  const below = header.getBoundingClientRect().bottom;
  const box = target.getBoundingClientRect();
  if (box.top >= below && box.top <= window.innerHeight) return;
  if (box.height > window.innerHeight - below) {
    window.scrollBy(0, box.top - below - GAP);
  } else {
    target.scrollIntoView({ block: 'center' });
  }
}
