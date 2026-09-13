/* The interactive half of the page: builds the tree from the embedded
   document, then wires up expanding and collapsing, copying a path, the theme
   button and the search box. Everything under page/ needs the DOM; the
   parsing, rendering and path reading it calls live in model/.

   Reading the box as a jq query lives in query.js, which every page has unless
   --simple left it out. These modules are in every page either way, so they
   work without it: the full entry passes jqui from query.js to startPage, and
   the simple entry passes null. */

import { parseJSON } from '../model/parse.ts';
import { renderTree } from '../model/render.ts';
import { copy } from './clipboard.ts';
import { find } from './dom.ts';
import { startSearch } from './search.ts';
import type { StartQuery } from './search.ts';
import type { Preference } from './theme.ts';
import { each, nodeOf, pathOf } from './tree.ts';

export function startPage(jqui: StartQuery | null): void {
  /* Build the whole tree in one write. The document is served inside the page
     as JSON rather than as markup, which keeps the file smaller and lets the
     tree be rendered here where the collapsing state lives. The parsed
     document is kept as well, because a query runs against it. */
  const value = parseJSON(find('#data', HTMLScriptElement).textContent);
  find('#tree', HTMLElement).innerHTML = renderTree(value, !!jqui);
  const root = find('#tree > .node', HTMLElement);

  const query = startSearch(jqui, value, root);

  /* The toolbar's theme button reports what is in force and cycles when
     clicked; the palette itself was settled by page/theme.ts in the head
     script before the body was parsed. */
  const GLYPH: Record<Preference, string> = { auto: '◐', light: '☀', dark: '☾' };
  const themeButton = find('#theme', HTMLElement);
  themeButton.addEventListener('click', function () { showTheme(jqtheme.cycle()); });
  showTheme(jqtheme.current());

  function showTheme(pref: Preference): void {
    themeButton.textContent = GLYPH[pref];
    themeButton.title = 'Theme: ' + pref;
  }

  /* One delegated listener for every line in either view, however many there
     are: a click either hits a copy button, a toggle, or the collapsed
     summary, which expands the node it belongs to. */
  find('main', HTMLElement).addEventListener('click', function (e) {
    if (!(e.target instanceof Element)) return;
    const cp = e.target.closest('.cp');
    if (cp) { copy(pathOf(nodeOf(cp)), cp); return; }
    const fq = e.target.closest('.fq');
    if (fq) { if (query) query.filter(nodeOf(fq)); return; }
    const tg = e.target.closest('.toggle');
    if (tg) { nodeOf(tg).classList.toggle('collapsed'); return; }
    const fold = e.target.closest('.fold');
    if (fold) { nodeOf(fold).classList.remove('collapsed'); }
  });

  /* One button for both, saying what the next click will do. Collapsing leaves
     the root expanded, so the document is still readable rather than a single
     line.

     Folding a branch by hand does not change what the button says. It reports
     the last thing it did rather than the state of the tree, which would mean
     walking every node to answer a question nobody asked. */
  const foldButton = find('#fold', HTMLElement);
  let folded = false;
  foldButton.addEventListener('click', function () {
    folded = !folded;
    each('.node.branch', function (n) {
      if (!folded) n.classList.remove('collapsed');
      else if (n !== root) n.classList.add('collapsed');
    });
    foldButton.textContent = folded ? 'Expand all' : 'Collapse all';
  });
}
