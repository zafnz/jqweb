/* A page built with one query and opened with another in its address. The one
   in the address runs, since whoever opened the page chose it after the page
   was built. */

import { test, expect } from '../fixtures.ts';

test.use({ variant: 'query', address: '?q=.kind' });

test('the address beats the query the page was built with', async ({ page }) => {
  const got = await page.evaluate(() => ({
    box: __t.get('#q', HTMLInputElement).value,
    resultsHidden: __t.get('#results', HTMLElement).hidden,
    marked: __t.get('#tree .node.hit', HTMLElement) === __t.at('.kind'),
    stats: __t.text('#stats')
  }));

  expect.soft(got.box, 'the box holds the query from the address').toBe('.kind');
  expect.soft(got.resultsHidden, 'which is a path, so it is shown in the document').toBe(true);
  expect.soft(got.marked, 'the line it names is marked').toBe(true);
  expect.soft(got.stats, 'and the count names it').toBe('.kind');
});
