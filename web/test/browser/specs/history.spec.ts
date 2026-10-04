/* Back and Forward over what the search box has held. Each history entry keeps
   the box and the mode select, and going to one runs the box again. */

import { test, expect, settle, type } from '../fixtures.ts';
import type { Page } from '@playwright/test';

const view = (page: Page) => page.evaluate(() => ({
  box: __t.get('#q', HTMLInputElement).value,
  mode: __t.get('#mode', HTMLSelectElement).value,
  results: !__t.get('#results', HTMLElement).hidden,
  suggest: !__t.get('#suggest', HTMLElement).hidden,
  stats: __t.text('#stats')
}));

/* The ?q= in the page's address, or null for none. */
const addressQ = (page: Page) => page.evaluate(() => new URLSearchParams(location.search).get('q'));

/* Writes within a second of each other rewrite one entry, so a step that is
   meant to make an entry of its own waits past that. */
async function typeAlone(page: Page, text: string) {
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

  test('the address follows changes to the view', async ({ page }) => {
    expect.soft(await addressQ(page), 'the page opens with no ?q=').toBe(null);

    await page.locator('#q').fill('Running');
    await settle(page, 700);
    expect.soft(await addressQ(page), 'typing puts the box in the address').toBe('Running');

    await page.locator('#q').fill('Pending');
    await settle(page, 700);
    expect.soft(await addressQ(page), 'and typing on rewrites it').toBe('Pending');

    await page.goBack();
    expect.soft(await addressQ(page), 'back takes it out again').toBe(null);

    await page.goForward();
    await type(page, '');
    expect.soft(await addressQ(page), 'as does emptying the box').toBe(null);
  });

  test('only changed results update the address', async ({ page }) => {
    await type(page, '.');
    expect.soft(await addressQ(page), 'the whole document is already shown').toBe(null);
    await type(page, '.items[]');
    expect.soft(await addressQ(page)).toBe('.items[]');
    for (const q of ['.items[] |', '.items[] | select(', '.items[] | sel']) {
      await type(page, q);
      expect.soft(await addressQ(page), 'errors and hints retain the successful query').toBe('.items[]');
    }
    const pods = '.items[] | select(.kind == "Pod")';
    await type(page, pods);
    expect.soft(await addressQ(page)).toBe(pods);
    await type(page, '.items[] | select( .kind == "Pod" )');
    expect.soft(await addressQ(page), 'equivalent results leave the address alone').toBe(pods);
    await type(page, '.items[] | error("failed")');
    expect.soft(await addressQ(page), 'runtime errors leave the address alone').toBe(pods);
  });

  test('history debounces changed views for half a second', async ({ page }) => {
    await page.locator('#q').fill('.items[]');
    await settle(page, 400);
    expect.soft((await view(page)).results, 'results render before the URL changes').toBe(true);
    expect.soft(await addressQ(page)).toBe(null);
    await page.locator('#q').fill('.items[] | .kind');
    await settle(page, 600);
    expect.soft(await addressQ(page), 'another changed view restarts the debounce').toBe(null);
    await settle(page, 50);
    expect.soft(await addressQ(page)).toBe('.items[] | .kind');
    await page.goBack();
    expect.soft((await view(page)).box, 'coalesced changes make one entry').toBe('');
  });

  test('history writes stay at least half a second apart', async ({ page }) => {
    const writes = await page.evaluateHandle(() => {
      const writes: { method: string; at: number }[] = [];
      for (const method of ['pushState', 'replaceState'] as const) {
        const original = history[method].bind(history);
        history[method] = function (...args: Parameters<History[typeof method]>) {
          writes.push({ method, at: Date.now() });
          original(args[0], args[1], args[2]);
        };
      }
      return writes;
    });
    for (const q of ['.items[]', '.items[] | .kind']) {
      await page.locator('#q').fill(q);
      await settle(page, 650);
    }
    await page.locator('#q').press('Escape');
    await settle(page, 550);
    const got = await writes.jsonValue();
    expect.soft(got.map(w => w.method), 'typing groups edits; Escape starts an entry')
      .toEqual(['pushState', 'replaceState', 'pushState']);
    for (let i = 1; i < got.length; i++) {
      expect.soft(got[i].at - got[i - 1].at, 'all writes obey the interval').toBeGreaterThanOrEqual(500);
    }
  });

  test('a pending write remembers the successful query', async ({ page }) => {
    await page.locator('#q').fill('.items[]');
    await settle(page, 150);
    await type(page, '.items[] |');
    expect.soft(await addressQ(page)).toBe('.items[]');
    await page.reload();
    await settle(page);
    expect.soft((await view(page)).box, 'reload restores the rendered query').toBe('.items[]');
    expect.soft((await view(page)).results).toBe(true);
  });

  test('going back cancels a pending history write', async ({ page }) => {
    await typeAlone(page, '.items[]');
    await page.locator('#q').fill('.items[] | .kind');
    await settle(page, 150);
    await page.goBack();
    await settle(page);
    expect.soft((await view(page)).box).toBe('');
    expect.soft(await addressQ(page)).toBe(null);
    await page.goForward();
    expect.soft((await view(page)).box).toBe('.items[]');
  });

  test('unchanged paths and text matches leave the address alone', async ({ page }) => {
    await typeAlone(page, '.items[0]');
    await type(page, '.items[ 0 ]');
    expect.soft(await addressQ(page)).toBe('.items[0]');
    await typeAlone(page, 'blablabla');
    await type(page, 'blablablab');
    expect.soft(await addressQ(page)).toBe('blablabla');
  });

  test('forcing an invalid function hint does not record an error', async ({ page }) => {
    await typeAlone(page, '.items[]');
    await type(page, '.items[] | sel');
    await page.locator('#q').press('Enter');
    await settle(page);
    expect.soft(await addressQ(page)).toBe('.items[]');
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
    await settle(page, 500);
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
