/* The search box: text to find or a path to show, and in a page with the query
   engine, anything the query UI reads as a query. startSearch builds that UI,
   because the UI calls back in here to run the box again and to show where a
   path led. */

import type { Node as ValueNode } from '../model/node.ts';
import type { Segment } from '../model/path.ts';
import { parsePath } from '../model/path.ts';
import { copy } from './clipboard.ts';
import { find } from './dom.ts';
import { textFilter } from './filter.ts';
import type { Found } from './tree.ts';
import { each, pathOf, resolvePath, segsOf, showPath } from './tree.ts';

/* What the page hands the query UI: the document to run a query against, and
   the parts of the page the UI cannot look up for itself. resolve and segsOf
   walk the rendered tree rather than the value. */
export interface QueryHost {
  value: ValueNode;
  resolve(segs: Segment[]): Found;
  showFound(found: Found, want: number): void;
  segsOf(node: HTMLElement): Segment[];
  copy(text: string, btn: Element): void;
  rerun(force?: boolean): void;
}

/* What the query UI hands back. */
export interface QueryUI {
  wants(raw: string): boolean;
  run(raw: string, force?: boolean): void;
  filter(node: HTMLElement): void;
  clearFault(): void;
  showDocument(): void;
}

/* jqui from query.js, which the full entry passes to startPage and the simple
   entry replaces with null. */
export type StartQuery = (host: QueryHost) => QueryUI;

/* Wires up the search box over the document value, rendered as the tree whose
   top node is root. Returns the query UI, or null in a page built with
   --simple. */
export function startSearch(jqui: StartQuery | null, value: ValueNode, root: HTMLElement): QueryUI | null {
  const header = find('header', HTMLElement);
  const input = find('#q', HTMLInputElement);
  const stats = find('#stats', HTMLElement);

  /* A query given on the command line is in the page as the box's value. One
     in a ?q= on the page's address takes its place, so a link to a served
     page can carry a query of its own. Whichever it is runs at the end of
     this function, once everything it needs is set up. */
  const asked = new URLSearchParams(location.search).get('q');
  if (asked !== null) input.value = asked;

  /* The query half, or null in a page built with --simple. It reads the search
     box, so it needs the document to run against and the two path helpers,
     which walk the rendered tree rather than the value. */
  const query = jqui ? jqui({
    value: value,
    resolve: function (segs) { return resolvePath(root, segs); },
    showFound: showFound,
    segsOf: segsOf,
    copy: copy,
    rerun: run
  }) : null;

  /* Searching walks the whole tree, so wait for a pause in typing rather than
     doing it on every keystroke. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  /* "/" focuses the search box, Escape clears it. */
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && e.target !== input) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape' && e.target === input) { input.value = ''; run(); }
  });

  /* A phone gets the tree and the fold button only: page.css hides the search
     box, the mode select, the count and the line buttons at this same width.
     A window narrowed to it with a search in the box would be left filtered,
     or showing query results, with no box to clear them from, so the search
     is cleared on the way in. */
  const phone = window.matchMedia('(max-width: 600px)');
  phone.addEventListener('change', function () {
    if (phone.matches && input.value) { input.value = ''; run(); }
  });

  /* Runs whatever is in the box. Without query.js that is text to find or a
     path, as it has always been; with it, the mode decides. force runs a
     half-typed name as written rather than completing it, which is what the
     query the page opened with is given, since nobody is part way through
     typing it. */
  function run(force?: boolean): void {
    const raw = input.value.trim();
    if (query) query.clearFault();
    if (!raw) { reset(); return; }
    if (!query) { runPath(raw); return; }
    if (query.wants(raw)) { query.run(raw, force); return; }
    query.showDocument();
    findText(raw);
  }

  /* What a page built with --simple does, and what every page did before the
     engine existed: text containing "." or "[" may be a path such as
     .a.b[3].c, so it is tried as one first, and a bare word is always a text
     filter. A path that does not resolve falls back to text filtering unless
     it was written with a leading dot, which takes it as a path regardless. */
  function runPath(raw: string): void {
    if (/[.[]/.test(raw)) {
      const segs = parsePath(raw);
      if (segs) {
        const found = resolvePath(root, segs);
        if (found.depth === segs.length || raw.charAt(0) === '.') {
          showFound(found, segs.length);
          return;
        }
      }
    }
    findText(raw);
  }

  /* Reveals the node a path led to, or says how far it got. A partial match is
     still worth showing, since it says where the path stopped resolving. */
  function showFound(found: Found, want: number): void {
    if (found.depth === want) {
      showPath(header, found.node, true);
      stats.textContent = pathOf(found.node);
      return;
    }
    showPath(header, found.node, found.depth > 0);
    stats.textContent = found.depth ? 'no path past ' + pathOf(found.node) : 'no such path';
  }

  /* Filters the tree on raw as text, ignoring case, and reports the count. */
  function findText(raw: string): void {
    const hits = textFilter(root, raw.toLowerCase());
    stats.textContent = hits === 1 ? '1 match' : hits + ' matches';
  }

  /* Clears any filtering and shows the whole document again. Collapsed state
     is left alone: it is the reader's, not the search's. */
  function reset(): void {
    if (query) query.showDocument();
    each('.node', function (n) { n.classList.remove('hidden', 'hit'); });
    stats.textContent = '';
  }

  /* Whatever the box started with runs as though it had been typed, except
     that it is run as written: it was given whole rather than a letter at a
     time, so a name in it that no key finishes is still the query. */
  if (input.value.trim()) run(true);

  return query;
}
