/* A query that will not compile or will not run. The message goes under the box
   rather than beside it: as a flex item in the toolbar it competed with the box
   for room, so a long message made the box narrow while someone was still
   typing in it. */

import { test, expect, settle, type, near } from '../fixtures.js';

test.use({ variant: 'default' });

test('a query that will not compile', async ({ page }) => {
  expect.soft(await page.evaluate(() => __t.$('#fault').hidden),
    'nothing is wrong to begin with').toBe(true);

  await type(page, '.items[');
  const got = await page.evaluate(() => ({
    faultHidden: __t.$('#fault').hidden,
    bad: __t.$('#q').classList.contains('bad'),
    stats: __t.text('#stats'),
    treeHidden: __t.$('#tree').hidden,
    results: __t.$$('#results .result').length,
    fault: __t.text('#fault'),
    /* The box keeps its full width, which is the whole reason the message is
       not in the toolbar. */
    box: __t.box(__t.$('#q')),
    msg: __t.box(__t.$('#fault')),
    wrap: __t.box(__t.$('.qwrap'))
  }));

  expect.soft(got.faultHidden, 'the message is shown').toBe(false);
  expect.soft(got.bad, 'the box is marked').toBe(true);
  expect.soft(got.stats, 'nothing is counted').toBe('');
  expect.soft(got.treeHidden, 'the document is left alone').toBe(false);
  expect.soft(got.results, 'and nothing is shown as a result').toBe(0);

  /* A compile error knows where it is, and the position is written as a column
     a person can count to rather than an offset from zero. */
  expect.soft(got.fault, 'the message says where').toContain('(at ');
  expect.soft(/\(at (\d+)\)$/.exec(got.fault)[1], 'the position is one-based').toBe('8');

  expect.soft(got.box.width, 'the box is no narrower for the message')
    .toBeGreaterThanOrEqual(220);
  expect.soft(Math.round(got.msg.top), 'the message sits below the box')
    .toBeGreaterThanOrEqual(Math.round(got.box.bottom));
  near(got.msg.width, got.wrap.width, 1, 'and spans it');
});

test('a query that compiles and then fails', async ({ page }) => {
  await type(page, '.notes + 1');
  const got = await page.evaluate(() => ({
    faultHidden: __t.$('#fault').hidden,
    fault: __t.text('#fault')
  }));

  expect.soft(got.faultHidden, 'a runtime error is shown too').toBe(false);
  expect.soft(got.fault, 'and says what went wrong').toContain('cannot be added');
  expect.soft(/\(at \d+\)/.test(got.fault), 'a runtime error has no position to give').toBe(false);
});

test('a message is cleared by what replaces it', async ({ page }) => {
  await type(page, '.items | length');
  const worked = await page.evaluate(() => ({
    faultHidden: __t.$('#fault').hidden,
    bad: __t.$('#q').classList.contains('bad'),
    stats: __t.text('#stats')
  }));
  expect.soft(worked.faultHidden, 'a query that works takes the message away').toBe(true);
  expect.soft(worked.bad, 'and unmarks the box').toBe(false);
  expect.soft(worked.stats, 'and says what it found').toBe('1 result');

  await type(page, '.items[');
  expect.soft(await page.evaluate(() => __t.$('#fault').hidden), 'the message is back').toBe(false);

  await type(page, '');
  const emptied = await page.evaluate(() => ({
    faultHidden: __t.$('#fault').hidden,
    bad: __t.$('#q').classList.contains('bad')
  }));
  expect.soft(emptied.faultHidden, 'emptying the box clears it').toBe(true);
  expect.soft(emptied.bad, 'and unmarks the box').toBe(false);
});

test('a message and the suggestion list never share the space', async ({ page }) => {
  /* Both hang off the box in the same place, so only one of them can be on
     screen: a list of readings under an error about something else is a menu
     answering a question nobody asked. */
  await page.locator('at=.items[0].status.phase').locator('> .line > .fq').click();
  await settle(page);
  expect.soft(await page.evaluate(() => __t.$('#suggest').hidden),
    'the suggestion list is open').toBe(false);

  await type(page, '.items[');
  const broken = await page.evaluate(() => ({
    faultHidden: __t.$('#fault').hidden,
    suggestHidden: __t.$('#suggest').hidden
  }));
  expect.soft(broken.faultHidden, 'typing a broken query shows the message').toBe(false);
  expect.soft(broken.suggestHidden, 'and takes the list away').toBe(true);

  await page.locator('#q').focus();
  await settle(page, 250);
  expect.soft(await page.evaluate(() => __t.$('#suggest').hidden),
    'focusing the box does not bring it back over the message').toBe(true);
});
