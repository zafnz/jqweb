/* The text filter: hiding every line of the tree whose key and value do not
   contain what was typed. */

/* A tree node, with the lowercased text the filter compares against cached on
   the element by ownText. */
interface Searched extends HTMLElement {
  _q?: string;
}

/* Lowercased key + leaf value text for one node, cached on the element.
   Filtering reads every node on every keystroke, and the text of a node
   never changes, so it is worth keeping. */
function ownText(n: Searched): string {
  if (n._q === undefined) {
    let s = '';
    if (n.dataset.key !== undefined) s += n.dataset.key.toLowerCase() + '\n';
    /* Only this node's own value, not its descendants': the > combinators
       stop querySelector from reaching into a child node. */
    const v = n.querySelector(':scope > .line > .v');
    if (v) s += v.textContent.toLowerCase();
    n._q = s;
  }
  return n._q;
}

/* Hides every node under root whose key and value do not contain needle,
   keeping the ones that lead to or hang off a match, and returns how many
   matched. */
export function textFilter(root: HTMLElement, needle: string): number {
  let hits = 0;
  /* Returns whether this subtree contains a match. "forced" keeps the whole
     subtree of a matching node visible without counting it as a match. */
  function walk(node: Searched, forced: boolean): boolean {
    const own = ownText(node).indexOf(needle) !== -1;
    if (own) hits++;
    /* Recurse before deciding: a node with no match of its own is still
       kept when a descendant matched. */
    let childKeep = false;
    const kids = node.querySelectorAll<Searched>(':scope > .kids > .node');
    for (let i = 0; i < kids.length; i++) {
      if (walk(kids[i], forced || own)) childKeep = true;
    }
    node.classList.toggle('hidden', !(own || forced || childKeep));
    node.classList.toggle('hit', own);
    /* A match inside a collapsed branch would be invisible otherwise. */
    if (childKeep) node.classList.remove('collapsed');
    return own || childKeep;
  }
  walk(root, false);
  return hits;
}
