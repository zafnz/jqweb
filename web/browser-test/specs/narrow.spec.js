/* The toolbar in a window too small to hold it in one row. It is allowed to
   wrap; what it may not do is push the page sideways, leave the search box
   below its floor, or put anything out of reach.

   The window is just wider than a phone. At 600px and below the toolbar loses
   the search box altogether, which phone.spec.js covers. */

'use strict';

const { test, expect, settle, type, clickAway, near } = require('../fixtures.js');

test.use({ variant: 'default', viewport: { width: 640, height: 800 } });

const ITEMS = [
  ['the title', 'header .name'],
  ['the mode select', '#mode'],
  ['the search box', '.qwrap'],
  ['the count', '#stats'],
  ['the fold button', '#fold'],
  ['the theme button', '#theme']
];

test('the toolbar wraps rather than overflowing', async ({ page }) => {
  const got = await page.evaluate((items) => ({
    width: window.innerWidth,
    rows: __t.rows(items.map(([, sel]) => __t.$(sel))),
    bar: __t.box(__t.$('header')),
    boxes: items.map(([, sel]) => __t.box(__t.$(sel))),
    visible: items.map(([, sel]) => __t.visible(__t.$(sel))),
    noSideways: document.documentElement.scrollWidth <= window.innerWidth,
    q: __t.box(__t.$('#q'))
  }), ITEMS);

  expect.soft(got.width, 'the window really is a narrow one').toBeLessThanOrEqual(700);
  expect.soft(got.width, 'but wider than a phone').toBeGreaterThanOrEqual(601);
  expect.soft(got.rows, 'the toolbar wraps rather than staying in one row')
    .toBeGreaterThanOrEqual(2);
  expect.soft(got.bar.height, 'and is taller for it').toBeGreaterThanOrEqual(40);

  /* Wrapping is what keeps everything on screen; overflowing would not. */
  ITEMS.forEach(([name], i) => {
    expect.soft(Math.round(got.boxes[i].right), name + ' stays on screen')
      .toBeLessThanOrEqual(Math.round(got.bar.right));
    expect.soft(got.visible[i], name + ' is still reachable').toBe(true);
  });

  expect.soft(got.noSideways, 'the page has nothing to scroll sideways to').toBe(true);

  /* The box keeps its floor: below it there is not enough of a query visible to
     edit one. */
  expect.soft(got.q.width, 'the search box holds its minimum width')
    .toBeGreaterThanOrEqual(220);
});

test('what hangs off the box follows it down', async ({ page }) => {
  await type(page, '.items[');
  const err = await page.evaluate(() => ({
    fault: __t.box(__t.$('#fault')),
    q: __t.box(__t.$('#q')),
    wrap: __t.box(__t.$('.qwrap')),
    inner: window.innerWidth
  }));

  expect.soft(Math.round(err.fault.top), 'the error message follows the box down')
    .toBeGreaterThanOrEqual(Math.round(err.q.bottom));
  near(err.fault.width, err.wrap.width, 1, 'and is as wide as it');
  expect.soft(Math.round(err.fault.right), 'and stays on screen')
    .toBeLessThanOrEqual(Math.round(err.inner));

  await type(page, '');
  await page.locator('at=.items[0].kind').locator('> .line > .fq').click();
  await settle(page);
  const menu = await page.evaluate(() => ({
    suggest: __t.box(__t.$('#suggest')),
    q: __t.box(__t.$('#q')),
    inner: window.innerWidth,
    /* A query too long to show is broken across lines rather than widening the
       list until the page scrolls sideways. */
    wordBreak: getComputedStyle(__t.$('#suggest .sgt')).wordBreak,
    noSideways: document.documentElement.scrollWidth <= window.innerWidth
  }));

  expect.soft(Math.round(menu.suggest.top), 'the suggestion list follows it too')
    .toBeGreaterThanOrEqual(Math.round(menu.q.bottom));
  expect.soft(Math.round(menu.suggest.right), 'and stays on screen')
    .toBeLessThanOrEqual(Math.round(menu.inner));
  expect.soft(menu.wordBreak, 'a long query wraps inside the list').toBe('break-all');
  expect.soft(menu.noSideways, 'and the page still has nothing to scroll sideways to').toBe(true);

  /* Long values in the document get the same treatment: a line wraps rather
     than running off the side. */
  await clickAway(page);
  await type(page, '');
  const doc = await page.evaluate(() => ({
    whiteSpace: getComputedStyle(__t.$('#tree .line')).whiteSpace,
    noSideways: document.documentElement.scrollWidth <= window.innerWidth
  }));
  expect.soft(doc.whiteSpace, 'a line of the document wraps').toBe('pre-wrap');
  expect.soft(doc.noSideways, 'the document does not widen the page').toBe(true);
});
