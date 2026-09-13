/* The page on a phone. A screen this size has no room to write a jq query in,
   and the browser's own find covers text search, so at 600px and below the page
   is the tree and the fold button: no search box, no mode select, no count, and
   no copy or filter button on any line.

   500px is what the old runner could ask headless Chrome for, and it is kept so
   that this covers the same window it always did. Phones in portrait are 430px
   and under, so they are narrower than this and inside the same rule. */

import { test, expect, settle } from '../fixtures.js';

test.use({ variant: 'default', viewport: { width: 500, height: 800 } });

const KEPT = [
  ['the title', 'header .name'],
  ['the fold button', '#fold'],
  ['the theme button', '#theme']
];

test('the page keeps the tree and loses the rest', async ({ page }) => {
  const got = await page.evaluate((kept) => ({
    width: window.innerWidth,
    q: __t.visible(__t.$('#q')),
    mode: __t.visible(__t.$('#mode')),
    stats: __t.visible(__t.$('#stats')),
    copies: __t.$$('#tree .cp').filter(__t.visible).length,
    filters: __t.$$('#tree .fq').filter(__t.visible).length,
    lines: __t.$$('#tree .node > .line').length,
    visible: kept.map(([, sel]) => __t.visible(__t.$(sel))),
    boxes: kept.map(([, sel]) => __t.box(__t.$(sel))),
    rows: __t.rows(kept.map(([, sel]) => __t.$(sel))),
    noSideways: document.documentElement.scrollWidth <= window.innerWidth
  }), KEPT);

  expect.soft(got.width, 'the window is phone-sized').toBeLessThanOrEqual(600);
  expect.soft(got.q, 'the search box is gone').toBe(false);
  expect.soft(got.mode, 'the mode select is gone').toBe(false);
  expect.soft(got.stats, 'the match count is gone').toBe(false);
  expect.soft(got.copies, 'no line shows a copy button').toBe(0);
  expect.soft(got.filters, 'no line shows a filter button').toBe(0);
  expect.soft(got.lines, 'and the lines themselves are all there').toBeGreaterThanOrEqual(10);

  /* What is left fits on one row and on screen. */
  KEPT.forEach(([name], i) => {
    expect.soft(got.visible[i], name + ' is still there').toBe(true);
    expect.soft(Math.round(got.boxes[i].right), name + ' stays on screen')
      .toBeLessThanOrEqual(got.width);
  });

  expect.soft(got.rows, 'the toolbar is one row').toBe(1);
  expect.soft(got.noSideways, 'the page has nothing to scroll sideways to').toBe(true);
});

test('folding is what the page is for here', async ({ page }) => {
  const items = page.locator('at=.items');

  await items.locator('> .line > .toggle').click();
  await settle(page);
  expect.soft(await page.evaluate(() => __t.at('.items').classList.contains('collapsed')),
    'the toggle collapses a branch').toBe(true);

  await items.locator('> .line > .fold').click();
  await settle(page);
  expect.soft(await page.evaluate(() => __t.at('.items').classList.contains('collapsed')),
    'the summary expands it again').toBe(false);

  await page.locator('#fold').click();
  await settle(page);
  const collapsed = await page.evaluate(() => ({
    collapsed: __t.$$('#tree .node.branch.collapsed').length,
    branches: __t.$$('#tree .node.branch').length
  }));
  expect.soft(collapsed.collapsed, 'collapse all collapses').toBe(collapsed.branches - 1);

  await page.locator('#fold').click();
  await settle(page);
  expect.soft(await page.evaluate(() => __t.$$('#tree .node.collapsed').length),
    'expand all expands').toBe(0);

  /* "/" would focus a box nobody can see. */
  await page.keyboard.press('/');
  await settle(page);
  expect.soft(await page.evaluate(() => document.activeElement === __t.$('#q')),
    '"/" does not put focus in the hidden box').toBe(false);
});
