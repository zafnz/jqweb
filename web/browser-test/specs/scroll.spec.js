/* Where the page goes when a search reveals something. Three of these are
   settled bugs rather than guesses: centring a node taller than the window put
   the middle of the document in the middle of the screen, so typing "." threw
   the reader halfway down the file; and a path typed one character at a time
   dragged the page around on every keystroke. */

import { test, expect, settle, type, near } from '../fixtures.js';

test.use({ variant: 'default' });

/* Scrolling is instant -- page.js asks for block: 'center' and no behaviour --
   so this only has to put the page somewhere and let the handlers run. */
async function scrollTo(page, y) {
  await page.evaluate((to) => window.scrollTo(0, to === 'bottom'
    ? document.documentElement.scrollHeight : to), y);
  await settle(page, 150);
}

test('a revealed line comes out from under the toolbar', async ({ page }) => {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const inner = await page.evaluate(() => window.innerHeight);
  expect.soft(height, 'the document is taller than the window')
    .toBeGreaterThanOrEqual(inner * 3);

  /* ---- the root ---- */

  await scrollTo(page, 'bottom');
  expect.soft(await page.evaluate(() => window.scrollY), 'the page is scrolled to the bottom')
    .toBeGreaterThanOrEqual(inner);

  await type(page, '.');
  const root = await page.evaluate(() => ({
    scrollY: window.scrollY,
    top: __t.$('#tree > .node').getBoundingClientRect().top,
    below: __t.$('header').getBoundingClientRect().bottom
  }));
  expect.soft(root.scrollY, '. goes to the top of the document, not the middle of it')
    .toBeLessThanOrEqual(50);
  near(root.top, root.below, 12, 'which puts the first line under the toolbar');

  /* ---- something further down than the window ---- */

  await type(page, '');
  await scrollTo(page, 0);
  await type(page, '.items[9].status');
  const far = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    top: __t.$('#tree .node.hit').getBoundingClientRect().top,
    below: __t.$('header').getBoundingClientRect().bottom,
    inner: window.innerHeight,
    scrollY: window.scrollY
  }));
  expect.soft(far.stats, 'the path landed').toBe('.items[9].status');
  expect.soft(Math.round(far.top), 'what it landed on is not behind the toolbar')
    .toBeGreaterThanOrEqual(Math.round(far.below) - 1);
  expect.soft(far.top, 'and is on screen').toBeLessThanOrEqual(far.inner);

  /* ---- what is already on screen stays where it is ---- */

  /* Typing a path a character at a time walks down through nodes that are
     already visible, and re-centring on each of them drags the page under the
     reader while they are still typing. */
  const settled = far.scrollY;
  await type(page, '.items[9].status.phase');
  expect.soft(await page.evaluate(() => window.scrollY),
    'a target already on screen does not move the page').toBe(settled);
  await type(page, '.items[9].status.restarts');
  expect.soft(await page.evaluate(() => window.scrollY), 'nor does its neighbour').toBe(settled);
});

test('every revealed line clears the toolbar', async ({ page }) => {
  for (const path of ['.items[0].kind', '.items[5].metadata.name', '.mixed[3]', '.counts.scale']) {
    await type(page, '');
    await scrollTo(page, 'bottom');
    await type(page, path);
    const got = await page.evaluate(() => ({
      top: __t.$('#tree .node.hit').getBoundingClientRect().top,
      below: __t.$('header').getBoundingClientRect().bottom,
      inner: window.innerHeight
    }));
    expect.soft(Math.round(got.top), path + ' comes out from under the toolbar')
      .toBeGreaterThanOrEqual(Math.round(got.below) - 1);
    expect.soft(Math.round(got.top), path + ' is brought on screen')
      .toBeLessThanOrEqual(got.inner);
  }
});

test('a text search does not scroll anywhere', async ({ page }) => {
  /* It marks every match, and there is no one line to scroll to. Hiding what
     did not match shortens the document, so the browser may have nowhere near
     600 left to be scrolled to -- what it must not do is scroll somewhere of
     its own choosing. */
  await type(page, '');
  await scrollTo(page, 600);
  await type(page, 'cron');
  const got = await page.evaluate(() => ({
    scrollY: window.scrollY,
    most: document.documentElement.scrollHeight - window.innerHeight
  }));
  expect.soft(got.scrollY, 'a text search does not scroll anywhere')
    .toBe(Math.min(600, Math.max(0, got.most)));
});
