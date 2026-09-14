/* Back and Forward over what the search box has held. Each history entry keeps
   the box and the mode select, and going to one runs the box again. */

import { test, expect, settle, type } from '../fixtures.js';

const view = (page) => page.evaluate(() => ({
  box: __t.$('#q').value,
  mode: __t.$('#mode').value,
  results: !__t.$('#results').hidden,
  suggest: !__t.$('#suggest').hidden,
  stats: __t.text('#stats')
}));

/* The ?q= in the page's address, or null for none. */
const addressQ = (page) => page.evaluate(() => new URLSearchParams(location.search).get('q'));

/* Writes within a second of each other rewrite one entry, so a step that is
   meant to make an entry of its own waits past that. */
async function typeAlone(page, text) {
  await type(page, text);
  await settle(page, 2000);
}

test.describe('the default page', () => {
  test.use({ variant: 'default' });

  test('back and forward step through queries', async ({ page }) => {
    await typeAlone(page, '.items | length');
    await typeAlone(page, '.items[0]');

    await page.goBack();
    let got = await view(page);
    expect.soft(got.box, 'back puts the first query in the box').toBe('.items | length');
    expect.soft(got.results, 'and shows its result').toBe(true);
    expect.soft(got.stats, 'with its count').toBe('1 result');

    await page.goBack();
    got = await view(page);
    expect.soft(got.box, 'back again empties the box').toBe('');
    expect.soft(got.results, 'and puts the document back').toBe(false);
    expect.soft(got.stats, 'with no count').toBe('');

    await page.goForward();
    await page.goForward();
    got = await view(page);
    expect.soft(got.box, 'forward twice reaches the last query').toBe('.items[0]');
    expect.soft(got.results, 'a path shows in place').toBe(false);
    expect.soft(got.stats, 'and says where it led').toBe('.items[0]');
  });

  test('the address follows the box', async ({ page }) => {
    expect.soft(await addressQ(page), 'the page opens with no ?q=').toBe(null);

    await page.locator('#q').fill('blah');
    await settle(page, 300);
    expect.soft(await addressQ(page), 'typing puts the box in the address').toBe('blah');

    await page.locator('#q').fill('blahblah');
    await settle(page, 300);
    expect.soft(await addressQ(page), 'and typing on rewrites it').toBe('blahblah');

    await page.goBack();
    expect.soft(await addressQ(page), 'back takes it out again').toBe(null);

    await page.goForward();
    await type(page, '');
    expect.soft(await addressQ(page), 'as does emptying the box').toBe(null);
  });

  test('an address the page wrote opens on the same view', async ({ page }) => {
    await typeAlone(page, 'Running');
    const written = await page.evaluate(() => ({ url: location.href, stats: __t.text('#stats') }));

    await page.goto(written.url);
    await settle(page);
    const got = await view(page);
    expect.soft(got.box, 'the box holds the word').toBe('Running');
    expect.soft(got.mode, 'read on auto').toBe('auto');
    expect.soft(got.results, 'as text').toBe(false);
    expect.soft(got.stats, 'with the same count').toBe(written.stats);
  });

  test('typing without a pause makes one entry', async ({ page }) => {
    for (const q of ['.items', '.items[0]', '.items[0].metadata']) {
      await page.locator('#q').fill(q);
      await settle(page, 300);
    }
    await page.goBack();
    expect.soft((await view(page)).box, 'one back returns to before the typing').toBe('');
  });

  test('typing after going back starts a new entry', async ({ page }) => {
    await typeAlone(page, '.items | length');
    await page.goBack();
    await type(page, '.items[1]');
    await page.goBack();
    expect.soft((await view(page)).box,
      'the entry gone back to is still there').toBe('');
  });

  test('the filter button makes an entry', async ({ page }) => {
    await typeAlone(page, '.items[0]');
    await page.locator('at=.items[0].kind').locator('> .line > .fq').click();
    await settle(page);
    expect.soft((await view(page)).suggest, 'the list is open').toBe(true);

    await page.goBack();
    const got = await view(page);
    expect.soft(got.box, 'back returns to the query before it').toBe('.items[0]');
    expect.soft(got.stats, 'showing where it led').toBe('.items[0]');
    expect.soft(got.suggest, 'with the list put away').toBe(false);
  });

  /* The browser restores the scroll position of the entry itself. The text
     search shortens the document, so the page cannot be left where it was. */
  test('back returns to where the page was scrolled', async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 400));
    await settle(page, 2000);
    await typeAlone(page, 'Running');
    expect.soft(await page.evaluate(() => window.scrollY),
      'the search moved the page').not.toBe(400);
    await page.goBack();
    await settle(page);
    expect.soft(await page.evaluate(() => window.scrollY),
      'back scrolls to where it was before the search').toBe(400);
  });

  test('the mode select comes back with the box', async ({ page }) => {
    await typeAlone(page, 'keys');
    await page.locator('#mode').selectOption('jq');
    await settle(page, 2000);
    expect.soft((await view(page)).results, 'keys runs as a query on jq').toBe(true);

    await page.goBack();
    const got = await view(page);
    expect.soft(got.mode, 'back puts the select on auto').toBe('auto');
    expect.soft(got.box, 'with the word still in the box').toBe('keys');
    expect.soft(got.results, 'searched for as text').toBe(false);
  });

  test('a reload keeps the box', async ({ page }) => {
    await typeAlone(page, 'keys');
    await page.reload();
    await settle(page);
    const got = await view(page);
    expect.soft(got.box, 'the box holds what it held').toBe('keys');
    expect.soft(got.mode, 'on the mode it was read in').toBe('auto');
    expect.soft(got.results, 'so the word is searched for, not run').toBe(false);
  });
});

test.describe('the simple page', () => {
  test.use({ variant: 'simple' });

  test('back undoes a text search', async ({ page }) => {
    await typeAlone(page, 'metadata');
    expect.soft((await view(page)).stats, 'the search ran').toMatch(/match/);
    await page.goBack();
    const got = await view(page);
    expect.soft(got.box, 'back empties the box').toBe('');
    expect.soft(got.stats, 'and clears the count').toBe('');
  });
});
