/* The part of a browser check that has to happen inside the page: finding a
   line of the document by its path, compositing colours, and measuring what
   the layout did with something.

   Playwright injects this before the page scripts run, so the body of a
   page.evaluate can reach it as __t. Elements are free to move around inside
   such a body; only what the body returns has to be a number, a string or an
   object of them.

   Nothing here ships in a rendered page. It runs in whatever Chrome the runner
   found, so it is written in the JavaScript that browser has rather than the
   ES5 the page scripts keep to. */

(() => {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* The node in the document tree at a jq-style path, found the way the page
     finds it: by the data attributes emit() wrote. */
  function at(path) {
    const segs = window.jqweb.parsePath(path);
    if (!segs) throw new Error('at: ' + path + ' is not a path');
    let node = $('#tree > .node');
    for (const seg of segs) {
      const kids = $$(':scope > .kids > .node', node);
      node = seg.key !== undefined
        ? kids.find((k) => k.dataset.key === seg.key)
        : kids[seg.index < 0 ? kids.length + seg.index : seg.index];
      if (!node) throw new Error('at: ' + path + ' stops short');
    }
    return node;
  }

  /* ---- layout ---- */

  function visible(el) {
    if (!el) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  }

  /* Every node the page is showing, whichever view is on screen. A hidden node
     is one the search took away; a collapsed branch is still showing. */
  const shown = (sel) => $$(sel || 'main .node')
    .filter((n) => !n.closest('.node.hidden') && visible(n));

  /* How many rows a set of elements laid themselves out in. It counts middles
     rather than tops: the toolbar centres what is on a row, so a select and a
     span sitting side by side start at different heights and share a middle,
     and counting tops says every item is on a row of its own. */
  const rows = (els) => new Set(els.map((el) => {
    const b = el.getBoundingClientRect();
    return Math.round(b.top + b.height / 2);
  })).size;

  /* getBoundingClientRect gives back a DOMRect, which does not survive the trip
     out of the page; this is the same numbers in something that does. */
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
  function rgba(text) {
    if (!text || text === 'transparent' || text === 'none') return [0, 0, 0, 0];
    const n = text.match(/[\d.]+/g);
    if (!n || n.length < 3) return [0, 0, 0, 0];
    return [+n[0], +n[1], +n[2], n.length > 3 ? +n[3] : 1];
  }

  /* One colour laid over another. Backgrounds in the page are rgba overlays --
     --row-hover, --hit, --icon-chip -- so what a reader sees is the composite
     and not either colour on its own. */
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
  function bg(el) {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) stack.push(c);
      if (n === document.body) break;
    }
    let out = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  }

  function luminance(c) {
    const ch = [c[0], c[1], c[2]].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  const ratio = (fg, back) => {
    const a = luminance(fg), b = luminance(back);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  /* The contrast a reader gets on one element: its text colour, composited if
     it is translucent, against what is behind it. A pseudo-element takes its
     background from the element it hangs off, which is what bg() walks. */
  function contrast(el, pseudo) {
    const back = bg(el);
    return ratio(over(rgba(getComputedStyle(el, pseudo || null).color), back), back);
  }

  /* Every colour in the page is a custom property, so a palette that forgets
     one leaves an element with no colour at all rather than a wrong one. */
  function customProps() {
    const names = new Set();
    for (const style of $$('style')) {
      for (const m of style.textContent.matchAll(/(--[a-z-]+)\s*:/g)) names.add(m[1]);
    }
    return Array.from(names);
  }

  const prop = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* Repaints the page in one palette. theme.js settled this before the body
     parsed; a spec checking both has to ask for the other one. */
  const paint = (theme) => document.documentElement.setAttribute('data-theme', theme);

  window.__t = {
    $, $$, at, bg, box, contrast, customProps, paint, prop, ratio, rgba, rows,
    shown, visible,
    text: (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; return el ? el.textContent : null; }
  };
})();
