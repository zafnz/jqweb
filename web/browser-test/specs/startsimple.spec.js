/* A page built with --simple and a query. There is no engine to run it, so the
   page reads it the way it reads anything typed, and .items[3] is a path to
   look up. */

import { test, expect } from '../fixtures.js';

test.use({ variant: 'simplequery' });

test('a simple page opens on the path it was given', async ({ page }) => {
  const got = await page.evaluate(() => ({
    box: __t.$('#q').value,
    stats: __t.text('#stats'),
    marked: __t.$('#tree .node.hit') === __t.at('.items[3]'),
    outsideHidden: __t.at('.items[0]').classList.contains('hidden')
  }));

  expect.soft(got.box, 'the box holds the query').toBe('.items[3]');
  expect.soft(got.stats, 'the path resolves').toBe('.items[3]');
  expect.soft(got.marked, 'and its line is marked').toBe(true);
  expect.soft(got.outsideHidden, 'the lines outside it are hidden').toBe(true);
});
