/* Completing a function name as it is typed. A half-typed name drops down the
   builtins that start with it, each with what it takes and does beside it,
   and the run is held while it does; suggest.test.ts checks what gets
   offered. What only a browser can say is that no error shows while the name
   is on its way, that Enter still runs the text as written, that picking a
   name that needs an argument fills the box without running it, and that the
   two columns of a hint lay out as columns. */

import { test, expect, settle, type } from '../fixtures.js';

test.use({ variant: 'default' });

/* What the list is offering, top row first: the signature in the query
   column, and what it does beside it. */
const offered = (page) => page.evaluate(() =>
  __t.$$('#suggest .sg').map((row) => ({
    sig: __t.text(__t.$('.sgt', row)),
    doc: __t.text(__t.$('.sgn', row))
  })));

/* The box, the message under it, the list and the count. fault is null while
   no message shows. */
const view = (page) => page.evaluate(() => ({
  box: __t.$('#q').value,
  fault: __t.$('#fault').hidden ? null : __t.text('#fault'),
  listHidden: __t.$('#suggest').hidden,
  treeHidden: __t.$('#tree').hidden,
  stats: __t.text('#stats')
}));

test('a half-typed name offers the builtins it starts', async ({ page }) => {
  /* On auto a bare word is text to find; jq is where "len" is a name. */
  await page.locator('#mode').selectOption('jq');
  await settle(page);
  await type(page, 'len');
  const got = await view(page);
  const rows = await offered(page);
  expect.soft(got.listHidden, 'a half-typed name opens the list').toBe(false);
  expect.soft(rows.map((r) => r.sig), 'offering the name it starts').toEqual(['length']);
  expect.soft(rows[0] && rows[0].doc, 'with what it does beside it').toMatch(/\S/);
  expect.soft(got.fault, 'no error while the name is on its way').toBe(null);
  expect.soft(got.treeHidden, 'the document stays in view').toBe(false);
  expect.soft(got.stats, 'nothing ran').toBe('');

  await type(page, 'ma');
  expect.soft((await offered(page)).map((r) => r.sig), 'every name that continues it, by signature')
    .toEqual(['map(f)', 'map_values(f)', 'match(re; flags)', 'max', 'max_by(f)']);
});

test('a hint lays out as two columns', async ({ page }) => {
  /* A description is longer than a count, and the query column used to give
     way to it a character at a time. The signature stays on one line, the
     descriptions start at the same place down the list, and nothing pokes out
     of the list sideways. */
  await type(page, '.items[] | .metadata.labels | ma');
  const laid = await page.evaluate(() => ({
    sigHeights: __t.$$('#suggest .sg .sgt').map((el) => __t.box(el).height),
    docLefts: __t.$$('#suggest .sg .sgn').map((el) => __t.box(el).left),
    scrollWidth: __t.$('#suggest').scrollWidth,
    clientWidth: __t.$('#suggest').clientWidth
  }));
  expect.soft(laid.sigHeights.length, 'five names continue "ma"').toBe(5);
  expect.soft(new Set(laid.sigHeights).size, 'every signature is on one line').toBe(1);
  expect.soft(new Set(laid.docLefts).size, 'the descriptions line up').toBe(1);
  expect.soft(laid.scrollWidth, 'nothing pokes out sideways').toBeLessThanOrEqual(laid.clientWidth);
});

test('the error waits for Enter', async ({ page }) => {
  /* zafnz/jqweb#111: this used to say "joi is not a supported filter" on the
     way to join. */
  await type(page, '.items[] | joi');
  const held = await view(page);
  const rows = await offered(page);
  expect.soft(held.fault, 'no error while the name is on its way').toBe(null);
  expect.soft(rows.map((r) => r.sig), 'the name it starts is offered').toEqual(['join(sep)']);
  expect.soft(rows[0] && rows[0].doc, 'with what it does beside it').toMatch(/\S/);

  await page.locator('#q').press('Enter');
  await settle(page);
  const entered = await view(page);
  expect.soft(entered.fault, 'Enter runs it as written').toBe('joi is not a supported filter (at 12)');
  expect.soft(entered.listHidden, 'and puts the list away').toBe(true);

  /* A name nothing starts with runs, and says so. */
  await type(page, '.items[] | joix');
  const nothing = await view(page);
  expect.soft(nothing.fault, 'a name nothing starts with shows the error')
    .toBe('joix is not a supported filter (at 12)');
  expect.soft(nothing.listHidden, 'with nothing to offer').toBe(true);
});

test('a whole name that needs an argument stays on the list', async ({ page }) => {
  await type(page, '.items[]');
  expect.soft((await view(page)).stats, 'a finished query runs').toBe('10 results');

  await type(page, '.items[] | join');
  const whole = await view(page);
  expect.soft(whole.fault, 'a whole name that cannot run alone shows no error').toBe(null);
  expect.soft((await offered(page)).map((r) => r.sig), 'it stays on the list').toEqual(['join(sep)']);
  expect.soft(whole.stats, 'and the view stays').toBe('10 results');

  /* One that runs without an argument runs, even where a longer name
     continues it. */
  await type(page, '.items[] | keys');
  const ran = await view(page);
  expect.soft(ran.stats, 'a name that runs alone runs').toBe('10 results');
  expect.soft(ran.listHidden, 'with no list over it').toBe(true);
});

test('picking a name that needs an argument fills the box without running it', async ({ page }) => {
  await type(page, '.items[]');
  await type(page, '.items[] | sel');
  await page.locator('#suggest .sg').first().locator('.sgq').click();
  await settle(page);
  const picked = await view(page);
  expect.soft(picked.box, 'clicking one puts the name in the box').toBe('.items[] | select(');
  expect.soft(picked.fault, 'without an error for the missing argument').toBe(null);
  expect.soft(picked.stats, 'and the view stays').toBe('10 results');

  /* Typing the argument runs as usual. */
  await type(page, '.items[] | select(.kind == "Pod")');
  const typed = await view(page);
  expect.soft(typed.fault, 'the finished query runs').toBe(null);
  expect.soft(typed.stats, 'and narrows the ten').toMatch(/^[1-9] results?$/);

  /* The arrows reach the list, and a name that runs alone runs when picked. */
  await type(page, '.items | fl');
  await page.locator('#q').press('ArrowDown');
  await settle(page);
  const arrowed = await view(page);
  expect.soft(arrowed.box, 'down picks the first name').toBe('.items | flatten');
  expect.soft(arrowed.stats, 'and runs it').toBe('1 result, 10 items');
});

test('a format completes too', async ({ page }) => {
  await type(page, '.items[0].kind | @b');
  expect.soft((await offered(page)).map((r) => r.sig), 'the formats it starts')
    .toEqual(['@base64', '@base64d']);
  await page.locator('#suggest .sg').first().locator('.sgq').click();
  await settle(page);
  expect.soft((await view(page)).stats, 'picking one runs it').toBe('1 result');
});

test('on auto a bare word is still text to find', async ({ page }) => {
  await type(page, 'len');
  const got = await view(page);
  expect.soft(got.listHidden, 'no list opens').toBe(true);
  expect.soft(got.stats, 'the document was searched').toMatch(/match(es)?$/);
});
