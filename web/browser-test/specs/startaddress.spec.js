/* A query in a ?q= on the page's address, which a link to a served page can
   carry. It is a jq query however it reads, so a bare word such as keys is run
   rather than searched for. */

'use strict';

const { test, expect } = require('../fixtures.js');

test.use({ variant: 'default', address: '?q=keys' });

test('a query in the address runs as a query', async ({ page }) => {
  const got = await page.evaluate(() => ({
    box: __t.$('#q').value,
    mode: __t.$('#mode').value,
    resultsHidden: __t.$('#results').hidden,
    stats: __t.text('#stats')
  }));

  expect.soft(got.box, 'the box holds the query from the address').toBe('keys');
  expect.soft(got.mode, 'the select is on jq, where auto would search for the word').toBe('jq');
  expect.soft(got.resultsHidden, 'its result is on screen').toBe(false);
  expect.soft(got.stats, 'and the count says what it is').toBe('1 result, 8 items');
});
