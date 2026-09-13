/* The page --simple builds. page.js ships in it and query.js does not, so
   everything that reads the box as a query has to be absent without leaving a
   hole where it was. */

import { test, expect, settle, type } from '../fixtures.js';

test.use({ variant: 'simple' });

test('the query half of the page is absent', async ({ page }) => {
  const got = await page.evaluate(() => ({
    /* The engine and the suggestion builder are not in the page. query.js
       has no global of its own, so the mode select below is what says it is
       absent. */
    engine: typeof window.jqjs,
    suggest: typeof window.jqsuggest,
    core: typeof window.jqweb,
    theme: typeof window.jqtheme,
    /* The shell ships the mode select hidden and jqui() is what turns it on,
       so without jqui it stays hidden rather than offering readings nothing
       can act on. */
    modeHidden: __t.$('#mode').hidden,
    modeVisible: __t.visible(__t.$('#mode')),
    placeholder: __t.$('#q').placeholder,
    mentionsJq: __t.$('#q').placeholder.includes('jq'),
    /* The filter button opens a list of queries, so there is nothing for it to
       do here and it is not drawn. The copy button is on every line either
       way. */
    filters: __t.$$('#tree .fq').length,
    nodes: __t.$$('#tree .node').length,
    copies: __t.$$('#tree .node > .line > .cp').length
  }));

  expect.soft(got.engine, 'the engine is not here').toBe('undefined');
  expect.soft(got.suggest, 'nor the suggestion builder').toBe('undefined');
  expect.soft(got.core, 'but the parser and renderer are').toBe('object');
  expect.soft(got.theme, 'and so is the theme').toBe('object');
  expect.soft(got.modeHidden, 'the mode select stays hidden').toBe(true);
  expect.soft(got.modeVisible, 'and is not on screen').toBe(false);
  expect.soft(got.placeholder, 'the box offers a path, not a query').toContain('paste a path');
  expect.soft(got.mentionsJq, 'and does not mention jq').toBe(false);
  expect.soft(got.filters, 'no line offers to filter on itself').toBe(0);
  expect.soft(got.copies, 'every line still offers to copy its path').toBe(got.nodes);
});

test('what is left still works', async ({ page }) => {
  const rendered = await page.evaluate(() => ({
    nodes: __t.$$('#tree .node').length,
    ratio: __t.text(__t.$('.v', __t.at('.counts.ratio')))
  }));

  expect.soft(rendered.nodes, 'the document rendered').toBeGreaterThanOrEqual(100);
  expect.soft(rendered.ratio, 'numbers are still shown as written').toBe('1.50');

  await type(page, 'cron');
  const text = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    hits: __t.$$('#tree .node.hit').length
  }));
  expect.soft(text.stats, 'text is found').toBe('6 matches');
  expect.soft(text.hits, 'and marked').toBe(6);

  await type(page, '.counts.pods');
  const path = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    marked: __t.$('#tree .node.hit') === __t.at('.counts.pods')
  }));
  expect.soft(path.stats, 'a path resolves').toBe('.counts.pods');
  expect.soft(path.marked, 'and is marked').toBe(true);

  await type(page, '.counts.nope');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'a path that runs out says where').toBe('no path past .counts');

  /* A query is not read as one here: it is text like anything else, and falling
     back to a text search is better than saying nothing. */
  await type(page, '.items[] | select(.kind == "Pod")');
  const query = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    bad: __t.$('#q').classList.contains('bad')
  }));
  expect.soft(query.stats, 'a query is searched for as text').toBe('0 matches');
  expect.soft(query.bad, 'and nothing is reported as broken').toBe(false);

  /* Text that looks like a path but is not one falls back to a text search,
     which is how a version number or a decimal is found. */
  await type(page, '1.50');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'text with a dot in it is still text').toBe('1 match');

  /* Nothing ever replaces the document, so the results view stays empty. */
  const views = await page.evaluate(() => ({
    resultsHidden: __t.$('#results').hidden,
    resultsHTML: __t.$('#results').innerHTML,
    treeHidden: __t.$('#tree').hidden
  }));
  expect.soft(views.resultsHidden, 'the results view is never used').toBe(true);
  expect.soft(views.resultsHTML, 'and holds nothing').toBe('');
  expect.soft(views.treeHidden, 'the document is never put away').toBe(false);
});

test('the rest of the toolbar still works', async ({ page }) => {
  await type(page, '');

  await page.locator('#fold').click();
  await settle(page);
  const collapsed = await page.evaluate(() => ({
    label: __t.text('#fold'),
    open: __t.$$('#tree .node.branch').filter((n) => !n.classList.contains('collapsed')).length
  }));
  expect.soft(collapsed.label, 'collapse all still collapses').toBe('Expand all');
  expect.soft(collapsed.open, 'leaving the root open').toBe(1);

  await page.locator('#fold').click();
  await settle(page);
  expect.soft(await page.evaluate(() => __t.$$('#tree .node.collapsed').length),
    'and expand all expands').toBe(0);

  await page.locator('#theme').click();
  await settle(page);
  const theme = await page.evaluate(() => ({
    current: window.jqtheme.current(),
    attr: document.documentElement.getAttribute('data-theme')
  }));
  expect.soft(theme.current, 'the theme button still cycles').toBe('light');
  expect.soft(theme.attr, 'and the page follows').toBe('light');

  await page.locator('#fold').focus();
  await page.keyboard.press('/');
  await settle(page);
  expect.soft(await page.evaluate(() => document.activeElement === __t.$('#q')),
    '/ still focuses the box').toBe(true);

  await type(page, 'cron');
  await page.locator('#q').press('Escape');
  await settle(page);
  expect.soft(await page.locator('#q').inputValue(), 'and Escape still clears it').toBe('');
});
