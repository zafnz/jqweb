/* The half of a browser driver that is the same in all of them: recording
   checks, driving the page, and handing the findings back to run.js.

   run.js injects this ahead of the driver, so a driver file is nothing but
   its checks. The findings leave the page as base64 in <pre id="report">,
   which is the only thing that survives Chrome's --dump-dom without needing
   anything unescaped on the way out.

   Nothing here ships in a rendered page. It runs in whatever Chrome the
   runner found, so it is written in the JavaScript that browser has rather
   than the ES5 the page scripts keep to. */
var T = (function () {
  'use strict';

  const checks = [];
  const noise = [];

  window.addEventListener('error', (e) => {
    noise.push('uncaught: ' + (e.message || e.error));
  });
  window.addEventListener('unhandledrejection', (e) => {
    noise.push('unhandled rejection: ' + (e.reason && e.reason.message || e.reason));
  });

  /* ---- recording ---- */

  function record(name, ok, detail) {
    checks.push({ name: name, ok: !!ok, detail: ok ? '' : String(detail === undefined ? '' : detail) });
    return !!ok;
  }

  /* A value as it should read in a failure line: short, and quoted where the
     difference between "" and undefined is the whole point. */
  function show(v) {
    if (typeof v === 'string') return JSON.stringify(v.length > 120 ? v.slice(0, 117) + '...' : v);
    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
    if (v && v.nodeType === 1) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
    return String(v);
  }

  const api = {
    check: (name, ok, detail) => record(name, ok, detail),
    eq: (name, got, want) => record(name, got === want, 'got ' + show(got) + ', want ' + show(want)),
    ne: (name, got, avoid) => record(name, got !== avoid, 'got ' + show(got) + ', want anything else'),
    has: (name, hay, needle) =>
      record(name, String(hay).indexOf(needle) >= 0, show(hay) + ' does not contain ' + show(needle)),
    atLeast: (name, got, min) => record(name, got >= min, show(got) + ' is under ' + show(min)),
    atMost: (name, got, max) => record(name, got <= max, show(got) + ' is over ' + show(max)),
    near: (name, got, want, tol) =>
      record(name, Math.abs(got - want) <= tol, show(got) + ' is not within ' + show(tol) + ' of ' + show(want)),
    note: (text) => { noise.push(text); }
  };

  /* ---- the page ---- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  api.$ = $;
  api.$$ = $$;

  /* Every node the page is showing, whichever view is on screen. A hidden
     node is one the search took away; a collapsed branch is still showing. */
  api.shown = (sel) => $$(sel || 'main .node').filter((n) => !n.closest('.node.hidden') && visible(n));

  function visible(el) {
    if (!el) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.hidden) return false;
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  }
  api.visible = visible;

  api.text = (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; return el ? el.textContent : null; };

  /* How many rows a set of elements laid themselves out in. It counts middles
     rather than tops: the toolbar centres what is on a row, so a select and a
     span sitting side by side start at different heights and share a middle,
     and counting tops says every item is on a row of its own. */
  api.rows = (els) => new Set(els.map((el) => {
    const b = el.getBoundingClientRect();
    return Math.round(b.top + b.height / 2);
  })).size;

  api.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* How long to leave between an action and reading the result. page.js waits
     120ms for a pause in typing before it searches, and every other handler
     is synchronous, so this covers the lot. Virtual time makes it free. */
  const SETTLE = 400;

  api.click = async (el) => {
    if (!el) throw new Error('click: no element');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.click();
    await api.sleep(SETTLE);
  };

  /* A click that is not on the search box or the suggestion list, which is
     what puts the list away. */
  api.clickAway = async () => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await api.sleep(SETTLE);
  };

  /* Typing into the search box: the value plus the input event page.js
     debounces, because setting value alone fires nothing. */
  api.type = async (text) => {
    const q = $('#q');
    q.value = text;
    q.dispatchEvent(new Event('input', { bubbles: true }));
    await api.sleep(SETTLE);
  };

  /* Attention leaving the search box and coming back to it. Calling focus()
     on the element that already has it fires nothing, so a driver that only
     focuses is not doing what a person does. */
  api.refocus = async (el) => {
    const target = el || $('#q');
    target.blur();
    await api.sleep(50);
    target.focus();
    await api.sleep(SETTLE);
  };

  api.press = async (key, target) => {
    (target || document).dispatchEvent(
      new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
    await api.sleep(SETTLE);
  };

  /* Picks a value out of the mode select the way a person does: the change
     event is what query.js listens for, and assigning value fires nothing. */
  api.mode = async (value) => {
    const m = $('#mode');
    m.value = value;
    m.dispatchEvent(new Event('change', { bubbles: true }));
    await api.sleep(SETTLE);
  };

  /* The node in the document tree at a jq-style path, found the way the page
     finds it: by the data attributes emit() wrote. */
  api.at = (path) => {
    const segs = jqweb.parsePath(path);
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
  };

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
  api.rgba = rgba;

  /* One colour laid over another. Backgrounds in the page are rgba overlays
     -- --row-hover, --hit, --icon-chip -- so what a reader sees is the
     composite and not either colour on its own. */
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
  api.bg = bg;

  function luminance(c) {
    const ch = [c[0], c[1], c[2]].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  api.ratio = (fg, back) => {
    const a = luminance(fg), b = luminance(back);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  /* The contrast a reader gets on one element: its text colour, composited if
     it is translucent, against what is behind it. A pseudo-element takes its
     background from the element it hangs off, which is what bg() walks. */
  api.contrast = (el, pseudo) => {
    const back = bg(el);
    return api.ratio(over(rgba(getComputedStyle(el, pseudo || null).color), back), back);
  };

  /* Repaints the page in one palette. theme.js settled this before the body
     parsed; a driver checking both has to ask for the other one. */
  api.paint = async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    await api.sleep(50);
  };

  /* ---- handing the findings back ---- */

  let written = false;

  function report() {
    if (written) return;
    written = true;
    const json = JSON.stringify({ checks: checks, noise: noise });
    const pre = document.createElement('pre');
    pre.id = 'report';
    pre.textContent = btoa(String.fromCharCode.apply(null, new TextEncoder().encode(json)));
    document.body.appendChild(pre);
  }

  /* Runs a driver and writes the report however it ends. A driver that throws
     is a failed driver rather than a silent one: without this the page would
     dump with no report at all and the runner could only say it saw nothing. */
  api.run = (fn) => {
    Promise.resolve()
      .then(() => fn(api))
      .catch((e) => { record('driver ran to the end', false, (e && e.stack) || String(e)); })
      .then(report);
  };

  return api;
})();
