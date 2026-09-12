/* The search box as text to find and as a path: what a page did before the
   engine existed and still does for anything that is not a query. */

'use strict';

const { test, expect, settle, type } = require('../fixtures.js');

test.use({ variant: 'default' });

test('text is counted and marked', async ({ page }) => {
  const start = await page.evaluate(() => ({
    box: __t.$('#q').value,
    stats: __t.text('#stats')
  }));
  expect.soft(start.box, 'the box starts empty').toBe('');
  expect.soft(start.stats, 'nothing is said before anything is typed').toBe('');

  await type(page, 'cron');
  const got = await page.evaluate(() => {
    const hit = __t.$('#tree .node.hit');
    const ancestors = [];
    for (let n = hit.parentElement.closest('.node'); n; n = n.parentElement.closest('.node')) {
      ancestors.push({
        hidden: n.classList.contains('hidden'),
        collapsed: n.classList.contains('collapsed')
      });
    }
    const marked = __t.$$('#tree .node.hit');
    return {
      stats: __t.text('#stats'),
      anyMarked: marked.length > 0,
      hitHidden: hit.classList.contains('hidden'),
      ancestors,
      marked: marked.length,
      /* Every counted match really holds the text, and nothing holding it was
         hidden. Counting the marks rather than trusting the number is the
         point: the count comes from the same walk that does the hiding. */
      allHold: marked.every((n) => {
        const key = n.dataset.key === undefined ? '' : n.dataset.key;
        const v = __t.$(':scope > .line > .v', n);
        return (key + '\n' + (v ? v.textContent : '')).toLowerCase().includes('cron');
      })
    };
  });

  expect.soft(got.stats, 'a word is counted, not run').toContain('matches');
  expect.soft(got.anyMarked, 'the lines holding it are marked').toBe(true);

  /* A match keeps its ancestors on screen, or there would be no way to reach
     it, and it keeps its own subtree, or there would be no context for it. */
  expect.soft(got.hitHidden, 'a match is not hidden').toBe(false);
  for (const a of got.ancestors) {
    expect.soft(a.hidden, 'an ancestor of a match stays on screen').toBe(false);
    expect.soft(a.collapsed, 'an ancestor of a match is not left collapsed').toBe(false);
  }

  expect.soft(got.stats, 'the count is the number of marked lines')
    .toBe(got.marked + (got.marked === 1 ? ' match' : ' matches'));
  expect.soft(got.allHold, 'every marked line holds the text').toBe(true);

  /* Matching is on the key as well as the value, and it ignores case. */
  await type(page, 'CRON');
  expect.soft(await page.evaluate(() => __t.text('#stats')), 'case does not matter')
    .toBe(got.marked + ' matches');

  await type(page, 'namespace');
  expect.soft(await page.evaluate(() => __t.$$('#tree .node.hit').length),
    'a key matches as well as a value').toBe(10);

  await type(page, 'nothinghere');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'text nothing holds finds nothing').toBe('0 matches');

  /* Clearing puts the document back. What the reader collapsed by hand is
     theirs, so nothing here reopens it. */
  await type(page, '');
  const cleared = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    hidden: __t.$$('#tree .node.hidden').length,
    hits: __t.$$('#tree .node.hit').length
  }));
  expect.soft(cleared.stats, 'clearing says nothing').toBe('');
  expect.soft(cleared.hidden, 'clearing hides nothing').toBe(0);
  expect.soft(cleared.hits, 'clearing marks nothing').toBe(0);
});

test('a path says where it landed', async ({ page }) => {
  await type(page, '.counts.pods');
  const pods = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    marked: __t.$('#tree .node.hit') === __t.at('.counts.pods')
  }));
  expect.soft(pods.stats, 'a path says where it landed').toBe('.counts.pods');
  expect.soft(pods.marked, 'the node it names is the one marked').toBe(true);

  await type(page, '.items[2].metadata.name');
  const indexed = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    value: __t.text(__t.$(':scope > .line > .v', __t.$('#tree .node.hit')))
  }));
  expect.soft(indexed.stats, 'an index in a path resolves').toBe('.items[2].metadata.name');
  expect.soft(indexed.value, 'and lands on that element').toBe('"api-0"');

  await type(page, '.items[-1].kind');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'a negative index counts from the end').toBe('.items[9].kind');

  await type(page, '.["notes"]');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'a quoted segment resolves').toBe('.notes');

  /* A path that stops short says where it stopped, which is the useful half of
     the answer. */
  await type(page, '.counts.nope');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'a path that runs out says where').toBe('no path past .counts');

  await type(page, '.nope.nope');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'a path that never starts says so').toBe('no such path');

  /* The root is a path like any other. */
  await type(page, '.');
  const root = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    hidden: __t.$$('#tree .node.hidden').length
  }));
  expect.soft(root.stats, '. is the whole document').toBe('.');
  expect.soft(root.hidden, '. hides nothing').toBe(0);
});

test('the keys the box answers to', async ({ page }) => {
  await type(page, '');
  await page.locator('#fold').focus();
  expect.soft(await page.evaluate(() => document.activeElement === __t.$('#q')),
    'something else has the focus').toBe(false);

  await page.keyboard.press('/');
  await settle(page);
  expect.soft(await page.evaluate(() => document.activeElement === __t.$('#q')),
    '/ focuses the box').toBe(true);

  await type(page, 'cron');
  await page.locator('#q').press('Escape');
  await settle(page);
  const escaped = await page.evaluate(() => ({
    box: __t.$('#q').value,
    stats: __t.text('#stats'),
    hidden: __t.$$('#tree .node.hidden').length
  }));
  expect.soft(escaped.box, 'Escape empties the box').toBe('');
  expect.soft(escaped.stats, 'Escape puts the document back').toBe('');
  expect.soft(escaped.hidden, 'and hides nothing').toBe(0);

  /* "/" typed into the box is text to find, not a shortcut, or the box could
     never be used to search for one. The keystroke is a real one here, so what
     says it was not swallowed is the character arriving in the box. */
  await page.locator('#q').focus();
  await page.locator('#q').press('/');
  await settle(page);
  expect.soft(await page.locator('#q').inputValue(), '/ in the box is not swallowed').toBe('/');
});
