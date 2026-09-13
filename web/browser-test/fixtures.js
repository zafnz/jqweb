/* What every spec starts from: a page of the variant it asked for, with the
   in-page helpers injected, the clock under the test's control, and an "at="
   selector engine that names a line of the document by its jq path.

   A spec says which page it wants with test.use:

       test.use({ variant: 'simple', viewport: { width: 460, height: 800 } });

   and gets `page` already loaded and settled. */

import { test as base, expect, selectors } from '@playwright/test';
import path from 'node:path';
import { pageURL } from './pages.js';

const helpers = path.join(import.meta.dirname, 'helpers.js');

/* How far to wind the clock after an action. page.js waits 120ms for a pause
   in typing and leaves a copy button ticked for 900ms, so this covers both.
   The clock is under the test's control, so winding it costs nothing. */
const SETTLE = 1000;

/* Finds a line of the tree by its jq path, so a spec can say which line it
   means instead of counting its way through the markup. It is a selector
   engine rather than a helper so that what it finds is an ordinary locator,
   with the waiting, the clicking and the failure message that come with one. */
function atEngine() {
  return {
    query(root, selector) {
      const doc = root.ownerDocument || root;
      const segs = doc.defaultView.jqweb.parsePath(selector);
      if (!segs) return null;
      let node = (root.querySelector ? root : doc).querySelector('#tree > .node');
      for (const seg of segs) {
        if (!node) return null;
        const kids = Array.from(node.querySelectorAll(':scope > .kids > .node'));
        node = seg.key !== undefined
          ? kids.find((k) => k.dataset.key === seg.key)
          : kids[seg.index < 0 ? kids.length + seg.index : seg.index];
      }
      return node || null;
    },
    queryAll(root, selector) {
      const one = this.query(root, selector);
      return one ? [one] : [];
    }
  };
}

/* Registering the same engine twice throws, and Playwright keeps one registry
   for the whole run. */
let registered = false;

const test = base.extend({
  /* Which rendered page this spec drives, and anything added after its file
     name in the address. */
  variant: ['default', { option: true }],
  address: ['', { option: true }],

  atSelector: [async ({}, use) => {
    if (!registered) {
      registered = true;
      await selectors.register('at', atEngine);
    }
    await use();
  }, { scope: 'worker', auto: true }],

  page: async ({ page, variant, address }, use) => {
    /* Before the page loads, so the page's own timers are the fake ones and
       the helpers are there for the first evaluate. */
    await page.clock.install();
    await page.addInitScript({ path: helpers });
    await page.goto(pageURL(variant, address));
    await page.clock.runFor(SETTLE);
    await use(page);
  }
});

/* Winding the clock forward is how an action is followed through: the search
   box debounce and the copy-button tick both come back on a timer. */
async function settle(page, ms) {
  await page.clock.runFor(ms === undefined ? SETTLE : ms);
}

/* Typing into the search box. fill() sets the value and fires the input event
   page.js debounces, which is what a person typing produces. */
async function type(page, text) {
  await page.locator('#q').fill(text);
  await settle(page);
}

/* A click that is not on the search box or the suggestion list, which is what
   puts the list away. It is dispatched rather than aimed, because everywhere
   on the page that is neither of those is a line of the document or a link,
   and clicking one of those does something of its own. */
async function clickAway(page) {
  await page.evaluate(() => document.body.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  await settle(page);
}

/* Attention leaving the search box and coming back to it. Focusing the element
   that already has it fires nothing, so a spec that only focuses is not doing
   what a person does. */
async function refocus(page, selector) {
  const box = page.locator(selector || '#q');
  await box.blur();
  await settle(page, 100);
  await box.focus();
  await settle(page);
}

/* |got - want| <= tol. It is the distance that is asserted rather than the
   measurement, so that the name stays the same whatever the page measured and a
   failure still reads as "expected <= 1, received 3.2". toBeCloseTo counts
   decimal places instead, which is not what any of these tolerances mean. */
function near(got, want, tol, name) {
  expect.soft(Math.abs(got - want), name).toBeLessThanOrEqual(tol);
}

export { test, expect, settle, type, clickAway, refocus, near, SETTLE };
