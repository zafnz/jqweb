/* A half-typed name in the query a page opens with. Typing one holds the run
   back and offers the keys that could finish it, but a query given on the
   command line or in the address is the whole query, so it runs as written --
   nulls and all -- rather than opening on a list of completions. */

'use strict';

const { test, expect, type } = require('../fixtures.js');

test.use({ variant: 'default', address: '?q=.items[].ki' });

test('a half-typed query in the address runs rather than completing', async ({ page }) => {
  const got = await page.evaluate(() => ({
    box: __t.$('#q').value,
    suggestHidden: __t.$('#suggest').hidden,
    resultsHidden: __t.$('#results').hidden,
    results: __t.$$('#results .result').length,
    stats: __t.text('#stats')
  }));

  expect.soft(got.box, 'the box holds the query').toBe('.items[].ki');
  expect.soft(got.suggestHidden, 'no completions are offered').toBe(true);
  expect.soft(got.resultsHidden, 'the query ran').toBe(false);
  expect.soft(got.results, 'one result per item').toBe(10);
  expect.soft(got.stats, 'and the count says so').toBe('10 results');

  /* Typing the same text is a person still typing it, which completes. */
  await type(page, '.items[].ki');
  const typed = await page.evaluate(() => ({
    suggestHidden: __t.$('#suggest').hidden,
    first: __t.text('#suggest .sgt')
  }));

  expect.soft(typed.suggestHidden, 'typing it offers the key that finishes it').toBe(false);
  expect.soft(typed.first, 'and the completion is kind').toBe('.items[].kind');
});
