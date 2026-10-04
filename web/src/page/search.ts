/* The search box: text to find or a path to show, and in a page with the query
   engine, anything the query UI reads as a query. startSearch builds that UI,
   because the UI calls back in here to run the box again and to show where a
   path led. */

import type { Node as ValueNode } from '../model/node.ts';
import type { Segment } from '../model/path.ts';
import { parsePath } from '../model/path.ts';
import { find } from './dom.ts';
import { textFilter } from './filter.ts';
import type { Found } from './tree.ts';
import { each, pathOf, resolvePath, showPath } from './tree.ts';

/* What the page hands the query UI: the document to run a query against, and
   what only this closure holds -- the tree root that resolve walks, the header
   and count that showFound writes to, the run that rerun repeats, and the
   browser history that record writes the box to. */
export interface QueryHost {
  value: ValueNode;
  resolve(segs: Segment[]): Found;
  showFound(found: Found, want: number): boolean;
  rerun(): void;
  record(how?: EntryWrite): void;
}

/* What the query UI hands back. run reports whether the displayed values
   changed, and showDocument reports whether it restored the original tree. */
export interface QueryUI {
  wants(raw: string): boolean;
  run(raw: string, force?: boolean): boolean;
  filter(node: HTMLElement): void;
  clearFault(): void;
  showDocument(): boolean;
  forget(): void;
}

/* How record writes the box to the browser's history: push always starts a
   new entry, replace always rewrites the current one, and leaving it out
   decides by how long ago the last write was. */
export type EntryWrite = 'push' | 'replace';

/* One history entry: what the box and the mode select held. */
interface Entry {
  q: string;
  mode: string;
}

/* jqui from query/ui.ts, which the full entry passes to startPage and the
   simple entry replaces with null. */
export type StartQuery = (host: QueryHost) => QueryUI;

/* Wires up the search box over the document value, rendered as the tree whose
   top node is root. Returns the query UI, or null in a page built with
   --simple. */
export function startSearch(jqui: StartQuery | null, value: ValueNode, root: HTMLElement): QueryUI | null {
  const header = find('header', HTMLElement);
  const input = find('#q', HTMLInputElement);
  const stats = find('#stats', HTMLElement);
  /* In the page with or without the engine; only query/ui.ts reads it, but
     every history entry records it. */
  const mode = find('#mode', HTMLSelectElement);

  let documentTarget: HTMLElement | null = root;

  /* The query half, or null in a page built with --simple. */
  const query = jqui ? jqui({
    value: value,
    resolve: function (segs) { return resolvePath(root, segs); },
    showFound: showFound,
    rerun: function () { step(); },
    record: record
  }) : null;

  /* A query given on the command line is in the page as the box's value, and
     jqui has set the select for it. A ?q= on the page's address takes its
     place and is read as though it had been typed, with the select on auto,
     since the history writes the box there whichever way it was read. A
     history entry the page is loading into, on a reload or on coming back from
     another page, takes the place of both, since it holds the box and the
     select as they were. Whichever it is runs at the end of this function,
     once everything it needs is set up. */
  const kept = entryOf(history.state);
  const asked = new URLSearchParams(location.search).get('q');
  if (kept) {
    input.value = kept.q;
    mode.value = kept.mode;
  } else if (asked !== null) {
    input.value = asked;
    mode.value = 'auto';
  }

  /* Searching walks the whole tree, so wait for a pause in typing rather than
     doing it on every keystroke. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(step, 120);
  });
  /* "/" focuses the search box, Escape clears it. */
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && e.target !== input) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape' && e.target === input) { input.value = ''; step('push'); }
  });

  /* Record only a changed view, after half a second without another change.
     Capture the box now: it may contain an incomplete query by write time.
     Writes close together replace one entry; a longer pause starts another. */
  const HISTORY_MS = 500;
  const EDIT_MS = 1000;
  let written = 0;
  let historyTimer: ReturnType<typeof setTimeout> | undefined;

  function record(how?: EntryWrite): void {
    const entry: Entry = { q: input.value, mode: mode.value };
    clearTimeout(historyTimer);
    historyTimer = setTimeout(function () {
      const at = entryOf(history.state);
      if (at && at.q === entry.q && at.mode === entry.mode) return;
      const now = Date.now();
      if (how === 'replace' || (!how && now - written < EDIT_MS)) {
        history.replaceState(entry, '', addressOf(entry.q));
      } else {
        history.pushState(entry, '', addressOf(entry.q));
      }
      written = now;
    }, HISTORY_MS);
  }

  window.addEventListener('popstate', function (e) {
    const entry = entryOf(e.state);
    if (!entry) return;
    clearTimeout(timer);
    clearTimeout(historyTimer);
    input.value = entry.q;
    mode.value = entry.mode;
    if (query) query.forget();
    run(true);
    /* Typing after going back starts an entry of its own rather than
       rewriting the one gone back to. */
    written = 0;
  });

  /* Runs the box and records it only when the view changes. */
  function step(how?: EntryWrite): void {
    if (run()) record(how);
  }

  /* Runs whatever is in the box. Without query/ui.ts that is text to find or a
     path, as it has always been; with it, the mode decides. force runs a
     half-typed name as written rather than completing it, which is what the
     query the page opened with is given, since nobody is part way through
     typing it. Returns whether the displayed view changed. */
  function run(force?: boolean): boolean {
    const raw = input.value.trim();
    if (query) query.clearFault();
    if (!raw) return reset();
    if (!query) return runPath(raw);
    if (query.wants(raw)) return query.run(raw, force);
    const restored = query.showDocument();
    const changed = findText(raw);
    return restored || changed;
  }

  /* What a page built with --simple does, and what every page did before the
     engine existed: text containing "." or "[" may be a path such as
     .a.b[3].c, so it is tried as one first, and a bare word is always a text
     filter. A path that does not resolve falls back to text filtering unless
     it was written with a leading dot, which takes it as a path regardless. */
  function runPath(raw: string): boolean {
    if (/[.[]/.test(raw)) {
      const segs = parsePath(raw);
      if (segs) {
        const found = resolvePath(root, segs);
        if (found.depth === segs.length || raw.charAt(0) === '.') {
          return showFound(found, segs.length);
        }
      }
    }
    return findText(raw);
  }

  /* Reveals the node a path led to, or says how far it got. A partial match is
     still worth showing, since it says where the path stopped resolving. */
  function showFound(found: Found, want: number): boolean {
    const changed = documentTarget !== found.node;
    documentTarget = found.node;
    if (found.depth === want) {
      showPath(header, found.node, true);
      stats.textContent = pathOf(found.node);
      return changed;
    }
    showPath(header, found.node, found.depth > 0);
    stats.textContent = found.depth ? 'no path past ' + pathOf(found.node) : 'no such path';
    return changed;
  }

  /* Filters the tree on raw as text, ignoring case, and reports the count. */
  function findText(raw: string): boolean {
    const { hits, changed } = textFilter(root, raw.toLowerCase());
    documentTarget = null;
    stats.textContent = hits === 1 ? '1 match' : hits + ' matches';
    return changed;
  }

  /* Clears any filtering and shows the whole document again. Collapsed state
     is left alone: it is the reader's, not the search's. */
  function reset(): boolean {
    const restored = query?.showDocument() || false;
    const changed = documentTarget !== root;
    documentTarget = root;
    each('.node', function (n) { n.classList.remove('hidden', 'hit'); });
    stats.textContent = '';
    return restored || changed;
  }

  /* Whatever the box started with runs as though it had been typed, except
     that it is run as written: it was given whole rather than a letter at a
     time, so a name in it that no key finishes is still the query. */
  if (input.value.trim()) run(true);
  /* The address stays as the page was opened with. A command-line query that
     auto reads as text runs on jq, and written to ?q= it would open as text. */
  history.replaceState({ q: input.value, mode: mode.value } satisfies Entry, '');

  return query;
}

/* The page's address with q as its ?q=, or with no ?q= for an empty box. The
   rest of the address is kept. */
function addressOf(q: string): string {
  const url = new URL(location.href);
  if (q.trim()) url.searchParams.set('q', q);
  else url.searchParams.delete('q');
  return url.href;
}

/* The entry in a history state, or null for a state this page did not write. */
function entryOf(state: unknown): Entry | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Partial<Entry>;
  return typeof s.q === 'string' && typeof s.mode === 'string' ? { q: s.q, mode: s.mode } : null;
}
