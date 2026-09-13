/* Completing a key name as it is typed. jq reads a missing key as null, so
   ".items[].ki" run as written is ten nulls until the "nd" of "kind" arrives;
   the page holds the run back while the name is a prefix of real keys and
   offers those instead. suggest.test.js checks what gets offered; what only a
   browser can say is that the view survives the typing and that the run really
   is held back. */

import { test, expect, settle, type } from '../fixtures.js';

test.use({ variant: 'default' });

/* What the list is offering, top row first. */
const offered = (page) => page.evaluate(() =>
  __t.$$('#suggest .sg').map((row) => __t.text(__t.$('.sgt', row))));

test('a half-typed name offers the keys it starts', async ({ page }) => {
  /* A name typed at the root offers the key it starts, where it used to say
     "no such path". */
  await type(page, '.ite');
  const got = await page.evaluate(() => ({
    hidden: __t.$('#suggest').hidden,
    rows: __t.$$('#suggest .sg').length,
    first: __t.text(__t.$('#suggest .sg .sgt')),
    treeHidden: __t.$('#tree').hidden,
    stats: __t.text('#stats')
  }));

  expect.soft(got.hidden, 'a half-typed name opens the list').toBe(false);
  expect.soft(got.first, 'offering the key it starts').toBe('.items');
  expect.soft(got.rows, 'and only that').toBe(1);
  expect.soft(got.treeHidden, 'the document stays in view').toBe(false);
  expect.soft(got.stats, 'nothing ran').toBe('');
});

test('the run is held back while a name is unfinished', async ({ page }) => {
  /* A finished query runs as it always did. */
  await type(page, '.items[]');
  const whole = await page.evaluate(() => ({
    resultsHidden: __t.$('#results').hidden,
    stats: __t.text('#stats')
  }));
  expect.soft(whole.resultsHidden, 'a finished query runs').toBe(false);
  expect.soft(whole.stats, 'all ten items').toBe('10 results');

  /* The moment the next name starts, the run is held: this used to replace the
     ten items with ten nulls. */
  await type(page, '.items[].ki');
  const held = await page.evaluate(() => ({
    resultsHidden: __t.$('#results').hidden,
    stats: __t.text('#stats'),
    first: __t.text(__t.$('#results .result .v')),
    offered: __t.text(__t.$('#suggest .sg .sgt'))
  }));
  expect.soft(held.resultsHidden, 'the results in view stay').toBe(false);
  expect.soft(held.stats, 'and stay whole').toBe('10 results');
  expect.soft(held.first, 'no null took their place').not.toBe('null');
  expect.soft(held.offered, 'while the list offers the finish').toBe('.items[].kind');

  /* A name no key starts with runs as written: those nulls are the answer to
     what was actually asked. */
  await type(page, '.items[].kinX');
  const ran = await page.evaluate(() => ({
    first: __t.text(__t.$('#results .result .v')),
    stats: __t.text('#stats'),
    hidden: __t.$('#suggest').hidden
  }));
  expect.soft(ran.first, 'a name nothing starts with runs').toBe('null');
  expect.soft(ran.stats, 'one null per item').toBe('10 results');
  expect.soft(ran.hidden, 'with nothing to offer').toBe(true);
});

test('which keys are offered', async ({ page }) => {
  /* Two keys continue ".na"; equally common, so alphabetical. */
  await type(page, '.items[].metadata.na');
  const two = await offered(page);
  expect.soft(two.length, 'every key that continues it is offered').toBe(2);
  expect.soft(two[0], 'name first').toBe('.items[].metadata.name');
  expect.soft(two[1], 'namespace second').toBe('.items[].metadata.namespace');

  /* A name that is a whole key runs even though a longer key continues it. */
  await type(page, '.items[].metadata.name');
  const exact = await page.evaluate(() => ({
    stats: __t.text('#stats'),
    hidden: __t.$('#suggest').hidden
  }));
  expect.soft(exact.stats, 'an exact key runs').toBe('10 results');
  expect.soft(exact.hidden, 'with no list over it').toBe(true);

  /* A trailing dot is a name of length zero. jq calls it a syntax error; here
     it is the widest question, so every key is the answer and no error shows
     while the next character is on its way. */
  await type(page, '.items[0].');
  const bare = await page.evaluate(() => ({
    rows: __t.$$('#suggest .sg').length,
    stats: __t.text('#stats'),
    faultHidden: __t.$('#fault').hidden
  }));
  expect.soft(bare.rows, 'a bare dot offers every key').toBe(4);
  expect.soft(bare.stats, 'the view stays').toBe('10 results');
  expect.soft(bare.faultHidden, 'and no error shows').toBe(true);

  /* After a pipe, the keys come from what flows into it. */
  await type(page, '.items[] | .sp');
  expect.soft((await offered(page))[0], 'a name after a pipe completes')
    .toBe('.items[] | .spec');
});

test('a completion can be picked', async ({ page }) => {
  await type(page, '.items[] | .sp');

  /* Picking a completion runs it, like picking any other row. */
  await page.locator('#suggest .sg').first().locator('.sgq').click();
  await settle(page);
  const clicked = await page.evaluate(() => ({
    box: __t.$('#q').value,
    stats: __t.text('#stats')
  }));
  expect.soft(clicked.box, 'clicking one puts it in the box').toBe('.items[] | .spec');
  expect.soft(clicked.stats, 'and runs it').toBe('10 results');

  /* The arrows reach the list from the box, as they do for filter readings. */
  await type(page, '.items[].m');
  await page.locator('#q').press('ArrowDown');
  await settle(page);
  const arrowed = await page.evaluate(() => ({
    box: __t.$('#q').value,
    stats: __t.text('#stats')
  }));
  expect.soft(arrowed.box, 'down picks the first completion').toBe('.items[].metadata');
  expect.soft(arrowed.stats, 'and runs it').toBe('10 results');

  /* Enter runs the half-typed text as written, nulls and all. */
  await type(page, '.items[].ki');
  expect.soft((await offered(page))[0], 'the run is held again').toBe('.items[].kind');

  await page.locator('#q').press('Enter');
  await settle(page);
  const entered = await page.evaluate(() => ({
    first: __t.text(__t.$('#results .result .v')),
    hidden: __t.$('#suggest').hidden
  }));
  expect.soft(entered.first, 'Enter runs it as written').toBe('null');
  expect.soft(entered.hidden, 'and puts the list away').toBe(true);
});
