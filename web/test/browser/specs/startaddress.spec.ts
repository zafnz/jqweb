/* A ?q= on the page's address, which a link to a served page can carry and
   which the page writes as the box changes. It is read as though it had been
   typed, so a bare word is searched for; startoverride.spec.ts and
   startpartial.spec.ts open on queries. */

import { test, expect } from '../fixtures.ts';

test.use({ variant: 'default', address: '?q=Running' });

test('a word in the address is searched for', async ({ page }) => {
  const got = await page.evaluate(() => ({
    box: __t.get('#q', HTMLInputElement).value,
    mode: __t.get('#mode', HTMLSelectElement).value,
    resultsHidden: __t.get('#results', HTMLElement).hidden,
    hits: __t.$$('#tree .node.hit').length,
    stats: __t.text('#stats')
  }));

  expect.soft(got.box, 'the box holds the word from the address').toBe('Running');
  expect.soft(got.mode, 'the select stays on auto').toBe('auto');
  expect.soft(got.resultsHidden, 'no query ran').toBe(true);
  expect.soft(got.hits, 'the lines holding it are marked').toBeGreaterThan(0);
  expect.soft(got.stats, 'and the count says how many').toBe(got.hits + ' matches');
});
