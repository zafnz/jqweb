/* A page built with a query on the command line opens on that query, run as
   though it had been typed into the box. */

import { test, expect, type } from '../fixtures.js';

test.use({ variant: 'query' });

test('the page opens on the query it was built with', async ({ page }) => {
  const got = await page.evaluate(() => ({
    box: __t.$('#q').value,
    mode: __t.$('#mode').value,
    bad: __t.$('#q').classList.contains('bad'),
    resultsHidden: __t.$('#results').hidden,
    treeHidden: __t.$('#tree').hidden,
    results: __t.$$('#results .result').length,
    stats: __t.text('#stats'),
    first: __t.text(__t.$('#results .result'))
  }));

  expect.soft(got.box, 'the box holds the query').toBe('.items[] | .metadata.name');
  expect.soft(got.mode, 'auto reads it as a query, so the select stays on auto').toBe('auto');
  expect.soft(got.bad, 'the query ran without a fault').toBe(false);
  expect.soft(got.resultsHidden, 'its results are on screen').toBe(false);
  expect.soft(got.treeHidden, 'in place of the document').toBe(true);
  expect.soft(got.results, 'one result per item').toBe(10);
  expect.soft(got.stats, 'and the count says so').toBe('10 results');
  expect.soft(got.first, 'the first is the first name').toContain('web-0');

  /* From there it is the search box it always was. */
  await type(page, '');
  const cleared = await page.evaluate(() => ({
    treeHidden: __t.$('#tree').hidden,
    resultsHidden: __t.$('#results').hidden,
    hidden: __t.$$('#tree .node.hidden').length
  }));

  expect.soft(cleared.treeHidden, 'clearing the box brings the document back').toBe(false);
  expect.soft(cleared.resultsHidden, 'and puts the results away').toBe(true);
  expect.soft(cleared.hidden, 'with nothing in it hidden').toBe(0);
});
