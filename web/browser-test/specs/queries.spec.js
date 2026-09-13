/* The search box read as a query, and the results view that replaces the
   document when one produces values that are not in it. */

import { test, expect, settle, type } from '../fixtures.js';

test.use({ variant: 'default' });

/* Picking a value out of the mode select the way a person does: query.js
   listens for the change event, and assigning value fires nothing. */
async function mode(page, value) {
  await page.locator('#mode').selectOption(value);
  await settle(page);
}

test('the mode select is there and starts on auto', async ({ page }) => {
  /* The shell ships the select hidden; jqui() is what turns it on, so a page
     with the engine in it is the only page that shows one. */
  const got = await page.evaluate(() => ({
    visible: __t.visible(__t.$('#mode')),
    options: __t.$$('option', __t.$('#mode')).map((o) => o.value).join(','),
    value: __t.$('#mode').value,
    placeholder: __t.$('#q').placeholder
  }));

  expect.soft(got.visible, 'the mode select is on screen').toBe(true);
  expect.soft(got.options, 'it offers three readings').toBe('auto,filter,jq');
  expect.soft(got.value, 'it starts on auto').toBe('auto');
  expect.soft(got.placeholder, 'the box says a query is allowed').toContain('jq query');
});

test('what auto reads as a query', async ({ page }) => {
  await type(page, 'cron');
  const word = await page.evaluate(() => ({
    resultsHidden: __t.$('#results').hidden,
    stats: __t.text('#stats')
  }));
  expect.soft(word.resultsHidden, 'a bare word is still text to find').toBe(true);
  expect.soft(word.stats, 'and is counted as text').toContain('matches');

  await type(page, '.items[] | select(.kind == "Pod")');
  const query = await page.evaluate(() => ({
    resultsHidden: __t.$('#results').hidden,
    treeHidden: __t.$('#tree').hidden,
    results: __t.$$('#results .result').length,
    stats: __t.text('#stats'),
    /* The gutter number is the position in the output, which is the only thing
       that distinguishes one result from another. */
    numbers: __t.$$('#results .result').map((r) => r.dataset.n).join(','),
    gutter: getComputedStyle(__t.$('#results .result'), '::before').content
  }));

  expect.soft(query.resultsHidden, 'a leading dot is a query').toBe(false);
  expect.soft(query.treeHidden, 'the document makes way for the results').toBe(true);
  expect.soft(query.results, 'one result per match').toBe(6);
  expect.soft(query.stats, 'and the count says so').toBe('6 results');
  expect.soft(query.numbers, 'results are numbered from zero').toBe('0,1,2,3,4,5');
  expect.soft(query.gutter, 'the numbers are shown').toBe('"0"');

  /* A name with an argument list is a call whatever it starts with: nobody
     types select(...) meaning to search the document for that text. */
  await type(page, 'select(.kind == "List")');
  const call = await page.evaluate(() => ({
    resultsHidden: __t.$('#results').hidden,
    stats: __t.text('#stats')
  }));
  expect.soft(call.resultsHidden, 'a call is a query without a leading dot').toBe(false);
  expect.soft(call.stats, 'it returned the document').toBe('1 result, 8 keys');
});

test('what one result means', async ({ page }) => {
  await type(page, '.counts | with_entries(select(.value != null))');
  const object = await page.evaluate(() => ({
    results: __t.$$('#results .result').length,
    stats: __t.text('#stats'),
    one: __t.$('#results').classList.contains('one'),
    gutter: getComputedStyle(__t.$('#results .result'), '::before').content
  }));
  expect.soft(object.results, 'a single object is one result').toBe(1);
  expect.soft(object.stats, 'and is described by what is in it').toBe('1 result, 5 keys');
  expect.soft(object.one, 'a single result is not numbered').toBe(true);
  expect.soft(object.gutter, 'nothing is put in the gutter').toBe('none');

  await type(page, '[.items[].kind]');
  const array = await page.evaluate(() => ({
    results: __t.$$('#results .result').length,
    stats: __t.text('#stats')
  }));
  expect.soft(array.results, 'a single array is one result too').toBe(1);
  expect.soft(array.stats, 'and is described by its length').toBe('1 result, 10 items');

  await type(page, '.items | length');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'a single scalar has nothing to describe').toBe('1 result');

  await type(page, '.items[] | select(.kind == "Nothing")');
  const none = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    results: __t.$$('#results .result').length,
    treeHidden: __t.$('#tree').hidden
  }));
  expect.soft(none.stats, 'a query that matches nothing says so').toBe('0 results');
  expect.soft(none.results, 'and shows nothing').toBe(0);
  expect.soft(none.treeHidden, 'but still replaces the document').toBe(true);

  /* ---- more results than are worth drawing ---- */

  await type(page, 'range(600)');
  const capped = await page.evaluate(() => ({
    results: __t.$$('#results .result').length,
    stats: __t.text('#stats')
  }));
  expect.soft(capped.results, 'the output is capped').toBe(500);
  expect.soft(capped.stats, 'and the count says how many there really were')
    .toBe('first 500 of 600 results');

  /* A path is shown where it sits rather than lifted out of the document,
     because the value is in there and its surroundings are the answer. */
  await type(page, '.items[0].metadata.name');
  const path = await page.evaluate(() => ({
    resultsHidden: __t.$('#results').hidden,
    treeHidden: __t.$('#tree').hidden,
    stats: __t.text('#stats')
  }));
  expect.soft(path.resultsHidden, 'a path stays in the document').toBe(true);
  expect.soft(path.treeHidden, 'the document is back').toBe(false);
  expect.soft(path.stats, 'and the line is marked').toBe('.items[0].metadata.name');
});

test('the document is put aside, not thrown away', async ({ page }) => {
  await type(page, '');
  await page.locator('at=.items').locator('> .line > .toggle').click();
  await settle(page);
  expect.soft(await page.evaluate(() => __t.at('.items').classList.contains('collapsed')),
    'a branch was collapsed by hand').toBe(true);

  await type(page, '.items[] | .kind');
  expect.soft(await page.evaluate(() => __t.$('#results').hidden),
    'the results are showing').toBe(false);

  await type(page, '');
  const back = await page.evaluate(() => ({
    treeHidden: __t.$('#tree').hidden,
    collapsed: __t.at('.items').classList.contains('collapsed'),
    resultsHTML: __t.$('#results').innerHTML
  }));
  expect.soft(back.treeHidden, 'the document comes back').toBe(false);
  expect.soft(back.collapsed, 'with the collapsing left as it was').toBe(true);
  expect.soft(back.resultsHTML, 'and nothing left in the results view').toBe('');
});

test('the mode select overrides what auto would read', async ({ page }) => {
  await type(page, '.items');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'auto reads a path as a path').toBe('.items');

  /* Text mode takes the same characters literally, and no line of the document
     contains ".items" -- the key is spelled without the dot. */
  await mode(page, 'filter');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'text mode does not resolve a path').toBe('0 matches');

  await type(page, 'cron');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'text mode finds text').toBe('6 matches');

  await mode(page, 'jq');
  const compiled = await page.evaluate(() => ({
    bad: __t.$('#q').classList.contains('bad'),
    fault: __t.text('#fault')
  }));
  expect.soft(compiled.bad, 'jq mode compiles what text mode searched for').toBe(true);
  expect.soft(compiled.fault, 'a bare word is a filter that does not exist')
    .toContain('cron is not a supported filter');

  await type(page, '.items');
  expect.soft(await page.evaluate(() => __t.text('#stats')),
    'jq mode reads a path as a path again').toBe('.items');
});
