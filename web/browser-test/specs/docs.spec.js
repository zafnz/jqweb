/* docs/index.html, the copy committed for GitHub Pages. It is generated and
   does not regenerate itself, so it is the one page here that nothing else
   would ever load: a change to web/ that breaks it goes unnoticed until someone
   follows the link in the README.

   It is also the only page driven at the size of a real document -- 700KB of
   kubectl output -- which is where anything that costs per line shows up. */

'use strict';

const { test, expect, settle, type, clickAway } = require('../fixtures.js');

test.use({ variant: 'docs' });

test('the committed example page is the page people are pointed at', async ({ page }) => {
  const got = await page.evaluate(() => ({
    title: document.title,
    name: __t.text('header .name'),
    /* Built the default way, so the engine is in it: the page people are
       pointed at is the one they would get. */
    engine: typeof window.jqjs,
    ui: typeof window.jqui,
    modeVisible: __t.visible(__t.$('#mode')),
    nodes: __t.$$('#tree .node').length,
    copies: __t.$$('#tree .node > .line > .cp').length,
    /* Offline, always: a rendered page is one file, and a request going out
       would be a request that fails for anyone reading it on a plane. */
    fetched: __t.$$('link[href], img[src], iframe').length,
    externalScripts: __t.$$('script[src]').length,
    styles: __t.$$('style').length > 0,
    marks: __t.$$('header svg').length,
    markPaths: __t.$$('path', __t.$('header svg')).length
  }));

  expect.soft(got.title, 'the page is built from the example document').toContain('k8s.json');
  expect.soft(got.name, 'and says so in the toolbar').toContain('k8s.json');
  expect.soft(got.engine, 'the engine is in it').toBe('object');
  expect.soft(got.ui, 'the search box is wired to it').toBe('function');
  expect.soft(got.modeVisible, 'and the mode select is on screen').toBe(true);
  expect.soft(got.nodes, 'a document of real size rendered').toBeGreaterThanOrEqual(5000);
  expect.soft(got.copies, 'every line has its buttons').toBe(got.nodes);
  expect.soft(got.fetched, 'nothing is fetched from anywhere').toBe(0);
  expect.soft(got.externalScripts, 'every script is inline').toBe(0);
  expect.soft(got.styles, 'and every stylesheet is').toBe(true);
  expect.soft(got.marks, 'the GitHub mark is drawn into the page').toBe(1);
  expect.soft(got.markPaths, 'as a path rather than a picture').toBeGreaterThanOrEqual(1);
});

test('the example page still works at that size', async ({ page }) => {
  await type(page, '.items | length');
  const one = await page.evaluate(() => ({
    resultsHidden: __t.$('#results').hidden,
    stats: __t.text('#stats'),
    count: +__t.text(__t.$('#results .v'))
  }));
  expect.soft(one.resultsHidden, 'a query runs against it').toBe(false);
  expect.soft(one.stats, 'and returns something').toBe('1 result');
  expect.soft(one.count, 'the document holds a list of resources').toBeGreaterThanOrEqual(1);

  await type(page, '.items[] | .kind');
  const many = await page.evaluate((count) => {
    const stats = __t.text('#stats');
    return stats === count + ' results' || stats.startsWith('first 500 of');
  }, one.count);
  expect.soft(many, 'a query with many outputs is capped, or counted').toBe(true);

  await type(page, '.items[0].kind');
  const path = await page.evaluate(() => ({
    treeHidden: __t.$('#tree').hidden,
    stats: __t.text('#stats')
  }));
  expect.soft(path.treeHidden, 'a path is shown where it sits').toBe(false);
  expect.soft(path.stats, 'and reports where it landed').toBe('.items[0].kind');

  await type(page, '');
  await page.locator('at=.items[0].kind').locator('> .line > .fq').click();
  await settle(page);
  const list = await page.evaluate(() => ({
    hidden: __t.$('#suggest').hidden,
    rows: __t.$$('#suggest .sg').length,
    /* Counting every reading against a document this size is what the budget
       in query.js exists for: a row it ran out of time on is offered without a
       count rather than not offered. */
    counted: __t.$$('#suggest .sgn').map((n) => __t.text(n))
      .every((l) => l === '' || /^\d+ (result|key)s?$/.test(l))
  }));
  expect.soft(list.hidden, 'the suggestion list opens on it').toBe(false);
  expect.soft(list.rows, 'with readings on it').toBeGreaterThanOrEqual(1);
  expect.soft(list.counted, 'every row is either counted or plainly not').toBe(true);

  await clickAway(page);
  await type(page, '');
  await page.locator('#fold').click();
  await settle(page);
  const folded = await page.evaluate(() => ({
    label: __t.text('#fold'),
    rootCollapsed: __t.$('#tree > .node').classList.contains('collapsed')
  }));
  expect.soft(folded.label, 'collapsing the lot works at this size').toBe('Expand all');
  expect.soft(folded.rootCollapsed, 'and leaves the root open').toBe(false);
});
