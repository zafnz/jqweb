/* The toolbar with room to lay itself out. It is a flex row holding a title, a
   select, a search box that takes what is left, a count and two buttons, and
   the failure it is prone to is one of them taking room from another. */

import { test, expect, settle, type, near } from '../fixtures.js';

test.use({ variant: 'default' });

/* Named here rather than taken from the element, because an id and a class name
   do not read the same way in a failure. */
const ITEMS = [
  ['the title', 'header .name'],
  ['the mode select', '#mode'],
  ['the search box', '.qwrap'],
  ['the count', '#stats'],
  ['the fold button', '#fold'],
  ['the theme button', '#theme']
];

test('the toolbar lays out in one row', async ({ page }) => {
  const got = await page.evaluate((items) => ({
    rows: __t.rows(items.map(([, sel]) => __t.$(sel))),
    bar: __t.box(__t.$('header')),
    boxes: items.map(([, sel]) => __t.box(__t.$(sel))),
    noSideways: document.documentElement.scrollWidth <= window.innerWidth,
    q: __t.box(__t.$('#q')),
    fold: __t.box(__t.$('#fold')),
    stats: __t.box(__t.$('#stats')),
    theme: __t.box(__t.$('#theme'))
  }), ITEMS);

  expect.soft(got.rows, 'the toolbar has room for one row').toBe(1);

  /* Nothing hangs off either end of it. */
  ITEMS.forEach(([name], i) => {
    expect.soft(Math.round(got.boxes[i].left), name + ' starts inside the toolbar')
      .toBeGreaterThanOrEqual(Math.round(got.bar.left));
    expect.soft(Math.round(got.boxes[i].right), name + ' ends inside the toolbar')
      .toBeLessThanOrEqual(Math.round(got.bar.right));
  });

  expect.soft(got.noSideways, 'and the page has nothing to scroll sideways to').toBe(true);

  /* The box takes what the fixed-width items leave, which is most of it. */
  expect.soft(got.q.width, 'the search box is wider than its floor').toBeGreaterThanOrEqual(220);
  expect.soft(got.q.width, 'and takes the room the rest do not want')
    .toBeGreaterThanOrEqual(got.bar.width / 3);

  /* The two buttons are pushed to the far end, so the box grows into the gap
     rather than the gap sitting between the buttons and the edge. */
  expect.soft(Math.round(got.fold.left), 'the fold button is past the count')
    .toBeGreaterThanOrEqual(Math.round(got.stats.right));
  near(got.theme.right, got.bar.right - 14, 2, 'the theme button is at the end');
});

test('a long count does not crowd anything out', async ({ page }) => {
  /* The count sits between the box and the buttons and grows leftwards into
     nothing: a long path put there must not push the buttons off the end. */
  await type(page, '.items[9].metadata.labels.namespace-that-is-long-enough-to-crowd');
  const got = await page.evaluate(() => ({
    bar: __t.box(__t.$('header')),
    theme: __t.box(__t.$('#theme')),
    q: __t.box(__t.$('#q'))
  }));

  expect.soft(Math.round(got.theme.right), 'a long count leaves the theme button where it was')
    .toBeLessThanOrEqual(Math.round(got.bar.right));
  expect.soft(got.q.width, 'and does not squeeze the search box').toBeGreaterThanOrEqual(220);
});

test('the toolbar stays at the top', async ({ page }) => {
  /* Which is what makes the box reachable from the bottom of a long file. */
  expect.soft(await page.evaluate(() => getComputedStyle(__t.$('header')).position),
    'the toolbar is stuck to the top').toBe('sticky');

  await page.evaluate(() => window.scrollTo(0, 1200));
  await settle(page, 150);
  const scrolled = await page.evaluate(() => ({
    scrollY: window.scrollY,
    top: Math.round(__t.box(__t.$('header')).top),
    zIndex: +getComputedStyle(__t.$('header')).zIndex
  }));

  expect.soft(scrolled.scrollY, 'the page really scrolled').toBeGreaterThanOrEqual(1000);
  expect.soft(scrolled.top, 'and the toolbar is still at the top').toBe(0);
  expect.soft(scrolled.zIndex, 'over the document rather than under it').toBeGreaterThanOrEqual(1);

  /* Whatever is under the header is behind it, so the first line of the
     document has to start below it rather than beneath it. */
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page, 150);
  const rested = await page.evaluate(() => ({
    tree: Math.round(__t.box(__t.$('#tree')).top),
    header: Math.round(__t.box(__t.$('header')).bottom)
  }));
  expect.soft(rested.tree, 'the document starts below the toolbar')
    .toBeGreaterThanOrEqual(rested.header);
});
