/* The page on a phone. At 600px and below it keeps the search box, in auto mode,
   but loses the mode select, count and line buttons that take room away from
   reading and filtering the tree.

   390px exercises the layout at a common portrait-phone width rather than only
   at the wide edge of the media query. */

import { test, expect, settle } from '../fixtures.ts';

test.use({ variant: 'default', viewport: { width: 390, height: 800 } });

const KEPT = [
  ['the title', 'header .name'],
  ['the search box', '.qwrap'],
  ['the fold button', '#fold'],
  ['the theme button', '#theme']
];

test('the toolbar keeps search and loses the smaller controls', async ({ page }) => {
  const got = await page.evaluate((kept) => ({
    width: window.innerWidth,
    q: __t.visible(__t.$('#q')),
    modeValue: __t.get('#mode', HTMLSelectElement).value,
    mode: __t.visible(__t.$('#mode')),
    stats: __t.visible(__t.$('#stats')),
    copies: __t.$$('#tree .cp').filter(__t.visible).length,
    filters: __t.$$('#tree .fq').filter(__t.visible).length,
    lines: __t.$$('#tree .node > .line').length,
    visible: kept.map(([, sel]) => __t.visible(__t.$(sel))),
    boxes: kept.map(([, sel]) => __t.box(__t.get(sel, HTMLElement))),
    rows: __t.rows(kept.map(([, sel]) => __t.get(sel, HTMLElement))),
    controlsRow: __t.rows([
      __t.get('header .name', HTMLElement),
      __t.get('#fold', HTMLElement),
      __t.get('#theme', HTMLElement)
    ]),
    qBox: __t.box(__t.get('#q', HTMLInputElement)),
    controlsBottom: Math.max(
      __t.box(__t.get('header .name', HTMLElement)).bottom,
      __t.box(__t.get('#fold', HTMLElement)).bottom,
      __t.box(__t.get('#theme', HTMLElement)).bottom
    ),
    noSideways: document.documentElement.scrollWidth <= window.innerWidth
  }), KEPT);

  expect.soft(got.width, 'the window is phone-sized').toBeLessThanOrEqual(600);
  expect.soft(got.q, 'the search box stays').toBe(true);
  expect.soft(got.mode, 'the mode select is gone').toBe(false);
  expect.soft(got.modeValue, 'the hidden mode starts on auto').toBe('auto');
  expect.soft(got.stats, 'the match count is gone').toBe(false);
  expect.soft(got.copies, 'no line shows a copy button').toBe(0);
  expect.soft(got.filters, 'no line shows a filter button').toBe(0);
  expect.soft(got.lines, 'and the lines themselves are all there').toBeGreaterThanOrEqual(10);

  /* What is left wraps as needed and stays on screen. */
  KEPT.forEach(([name], i) => {
    expect.soft(got.visible[i], name + ' is still there').toBe(true);
    expect.soft(Math.round(got.boxes[i].right), name + ' stays on screen')
      .toBeLessThanOrEqual(got.width);
  });

  expect.soft(got.controlsRow, 'the title and buttons share the first row').toBe(1);
  expect.soft(got.rows, 'the toolbar has exactly two rows').toBe(2);
  expect.soft(Math.round(got.qBox.top), 'the search box fills the second row')
    .toBeGreaterThanOrEqual(Math.round(got.controlsBottom));
  expect.soft(got.noSideways, 'the page has nothing to scroll sideways to').toBe(true);
});

test('the box automatically filters text and runs jq', async ({ page }) => {
  await page.locator('#q').fill('cron');
  await settle(page);
  const filtered = await page.evaluate(() => ({
    mode: __t.get('#mode', HTMLSelectElement).value,
    resultsHidden: __t.get('#results', HTMLElement).hidden,
    matches: __t.$$('#tree .node.hit').length,
    count: __t.text('#stats')
  }));
  expect.soft(filtered.mode, 'the box is still on auto').toBe('auto');
  expect.soft(filtered.resultsHidden, 'a bare word filters the document').toBe(true);
  expect.soft(filtered.matches, 'matching lines are marked').toBeGreaterThan(0);
  expect.soft(filtered.count, 'the hidden count records the matches').toContain('matches');

  await page.locator('#q').fill('.items | length');
  await settle(page);
  const queried = await page.evaluate(() => ({
    resultsHidden: __t.get('#results', HTMLElement).hidden,
    treeHidden: __t.get('#tree', HTMLElement).hidden,
    value: __t.text('#results .result .v'),
    count: __t.text('#stats')
  }));
  expect.soft(queried.resultsHidden, 'a jq expression shows results').toBe(false);
  expect.soft(queried.treeHidden, 'the results replace the document').toBe(true);
  expect.soft(queried.value, 'the expression is evaluated').toBe('10');
  expect.soft(queried.count, 'the hidden count records the result').toBe('1 result');
});

test('folding and the search shortcut remain reachable', async ({ page }) => {
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

  /* The same shortcut as the wide page reaches the visible box. */
  await page.keyboard.press('/');
  await settle(page);
  expect.soft(await page.evaluate(() => document.activeElement === __t.get('#q', HTMLInputElement)),
    '"/" focuses the search box').toBe(true);
});
