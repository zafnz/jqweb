/* The part of a browser check that has to happen inside the page: finding a
   line of the document by its path, compositing colours, and measuring what
   the layout did with something.

   Playwright injects this before the page scripts run, so the body of a
   page.evaluate can reach it as __t. Elements are free to move around inside
   such a body; only what the body returns has to be a number, a string or an
   object of them.

   Nothing here ships in a rendered page. It is plain JavaScript because
   Playwright injects the file as written, with nothing compiling it first. */

/** @typedef {[number, number, number, number]} RGBA */

function browserHelpers() {
  'use strict';

  /**
   * @param {string} sel
   * @param {ParentNode} [root]
   */
  const $ = (sel, root = document) => root.querySelector(sel);
  /**
   * @param {string} sel
   * @param {ParentNode} [root]
   */
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* Required elements fail here with their selector rather than later while
     reading a property. $ remains nullable for checks of missing elements. */
  /**
   * @template {Element} T
   * @param {string} sel
   * @param {{new(): T}} kind
   * @param {ParentNode} [root]
   * @returns {T}
   */
  function get(sel, kind, root) {
    const el = $(sel, root);
    if (!(el instanceof kind)) throw new Error('get: ' + sel + ' is missing or has the wrong element type');
    return el;
  }

  /* The node in the document tree at a jq-style path, found the way the page
     finds it: by the data attributes emit() wrote. It is the walk resolvePath
     in src/page/tree.ts does, written again here because the page does not
     export that one and a walk of its own is what makes this a check of the
     markup rather than of tree.ts. fixtures.ts has a third copy, for the same
     reason. */
  /** @param {string} path */
  function at(path) {
    const segs = window.jqweb.parsePath(path);
    if (!segs) throw new Error('at: ' + path + ' is not a path');
    let node = get('#tree > .node', HTMLElement);
    for (const seg of segs) {
      const kids = $$(':scope > .kids > .node', node);
      const next = seg.key !== undefined
        ? kids.find((k) => k.getAttribute('data-key') === seg.key)
        : kids[seg.index < 0 ? kids.length + seg.index : seg.index];
      if (!(next instanceof HTMLElement)) throw new Error('at: ' + path + ' stops short');
      node = next;
    }
    return node;
  }

  /* ---- layout ---- */

  /** @param {Element | null} el */
  function visible(el) {
    if (!el) return false;
    for (let n = /** @type {Element | null} */ (el); n && n !== document.documentElement; n = n.parentElement) {
      if (n instanceof HTMLElement && n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  }

  /* Every node the page is showing, whichever view is on screen. A hidden node
     is one the search took away; a collapsed branch is still showing. */
  /** @param {string} [sel] */
  const shown = (sel) => $$(sel || 'main .node')
    .filter((n) => !n.closest('.node.hidden') && visible(n));

  /* How many rows a set of elements laid themselves out in. It counts middles
     rather than tops: the toolbar centres what is on a row, so a select and a
     span sitting side by side start at different heights and share a middle,
     and counting tops says every item is on a row of its own. */
  /** @param {Element[]} els */
  const rows = (els) => new Set(els.map((el) => {
    const b = el.getBoundingClientRect();
    return Math.round(b.top + b.height / 2);
  })).size;

  /* getBoundingClientRect gives back a DOMRect, which does not survive the trip
     out of the page; this is the same numbers in something that does. */
  /** @param {Element} el */
  function box(el) {
    const b = el.getBoundingClientRect();
    return {
      top: b.top, left: b.left, right: b.right, bottom: b.bottom,
      width: b.width, height: b.height
    };
  }

  /* ---- colour ---- */

  /* r, g, b and alpha out of whatever getComputedStyle gave back. The page
     writes hex and rgba(), so Chrome hands back rgb()/rgba() in one of its
     comma or slash spellings; "transparent" is the fourth answer. */
  /**
   * @param {string} text
   * @returns {RGBA}
   */
  function rgba(text) {
    if (!text || text === 'transparent' || text === 'none') return [0, 0, 0, 0];
    const n = text.match(/[\d.]+/g);
    if (!n || n.length < 3) return [0, 0, 0, 0];
    return [+n[0], +n[1], +n[2], n.length > 3 ? +n[3] : 1];
  }

  /* One colour laid over another. Backgrounds in the page are rgba overlays --
     --row-hover, --hit, --icon-chip -- so what a reader sees is the composite
     and not either colour on its own. */
  /**
   * @param {RGBA} top
   * @param {RGBA} bottom
   * @returns {RGBA}
   */
  function over(top, bottom) {
    const a = top[3];
    if (a >= 1) return [top[0], top[1], top[2], 1];
    return [
      top[0] * a + bottom[0] * (1 - a),
      top[1] * a + bottom[1] * (1 - a),
      top[2] * a + bottom[2] * (1 - a),
      1
    ];
  }

  /* What is actually behind an element: its own background composited over
     every ancestor's, down to the body. */
  /** @param {Element} el */
  function bg(el) {
    const stack = [];
    for (let n = /** @type {Element | null} */ (el); n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) stack.push(c);
      if (n === document.body) break;
    }
    /** @type {RGBA} */
    let out = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  }

  /** @param {RGBA} c */
  function luminance(c) {
    const ch = [c[0], c[1], c[2]].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /**
   * @param {RGBA} fg
   * @param {RGBA} back
   */
  const ratio = (fg, back) => {
    const a = luminance(fg), b = luminance(back);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  /* The contrast a reader gets on one element: its text colour, composited if
     it is translucent, against what is behind it. A pseudo-element takes its
     background from the element it hangs off, which is what bg() walks. */
  /**
   * @param {Element} el
   * @param {string} [pseudo]
   */
  function contrast(el, pseudo) {
    const back = bg(el);
    return ratio(over(rgba(getComputedStyle(el, pseudo || null).color), back), back);
  }

  /* Every colour in the page is a custom property, so a palette that forgets
     one leaves an element with no colour at all rather than a wrong one. */
  function customProps() {
    const names = new Set(/** @type {string[]} */ ([]));
    for (const style of $$('style')) {
      for (const m of (style.textContent || '').matchAll(/(--[a-z-]+)\s*:/g)) names.add(m[1]);
    }
    return Array.from(names);
  }

  /** @param {string} name */
  const prop = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* Repaints the page in one palette. page/theme.ts settled this before the
     body parsed; a spec checking both has to ask for the other one. */
  /** @param {'light' | 'dark'} theme */
  const paint = (theme) => document.documentElement.setAttribute('data-theme', theme);

  return {
    $, $$, get, at, bg, box, contrast, customProps, paint, prop, ratio, rgba, rows,
    shown, visible,
    /** @param {string | Element | null} sel */
    text: (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; return el ? el.textContent : null; }
  };
}

window.__t = browserHelpers();
