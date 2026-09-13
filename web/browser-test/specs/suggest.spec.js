/* The list of readings the filter button on a line opens. suggest.test.js
   already checks that every query it builds compiles and runs; what only a
   browser can say is whether the list is right about what they return, and
   whether picking one leaves you able to try the next. */

import { test, expect, settle, type, clickAway, refocus, near } from '../fixtures.js';

test.use({ variant: 'default' });

/* A label deep enough to have a ladder of pivots above it: the app label on one
   pod could mean that pod, the pods of that app, or every label. */
const DEEP = '.items[0].metadata.labels.app';

/* Every row as the spec talks about it: the query it offers and the count it
   promises. */
const readings = (page) => page.evaluate(() => __t.$$('#suggest .sg').map((row) => ({
  query: __t.text(__t.$('.sgt', row)),
  label: __t.text(__t.$('.sgn', row)),
  on: row.classList.contains('on')
})));

async function openOn(page, path) {
  await page.locator('at=' + path).locator('> .line > .fq').click();
  await settle(page);
}

test('the list opens on the line it was asked about', async ({ page }) => {
  expect.soft(await page.evaluate(() => __t.$('#suggest').hidden),
    'nothing is open to begin with').toBe(true);

  await openOn(page, DEEP);
  const rows = await readings(page);
  const got = await page.evaluate(() => ({
    hidden: __t.$('#suggest').hidden,
    box: __t.$('#q').value,
    marked: __t.$$('#suggest .sg.on').length,
    ran: __t.text('#stats') !== ''
  }));

  expect.soft(got.hidden, 'the list opens').toBe(false);
  expect.soft(rows.length, 'with more than one reading on it').toBeGreaterThanOrEqual(2);
  expect.soft(got.box, 'the box holds the first reading').toBe(rows[0].query);
  expect.soft(rows[0].on, 'the first row is marked as the one in the box').toBe(true);
  expect.soft(got.marked, 'only one row is marked').toBe(1);
  expect.soft(got.ran, 'and it ran').toBe(true);
});

test('every label is what its query really returns', async ({ page }) => {
  await openOn(page, DEEP);
  const rows = await readings(page);

  /* The label on a row is what its query returns. This is the whole point of
     the list -- picking by outcome rather than by reasoning about jq -- so it
     is checked against the engine rather than taken on trust. */
  const measured = await page.evaluate((queries) => {
    const doc = window.jqweb.parseJSON(__t.text('#data'));
    return queries.map(({ query, label }) => {
      const out = window.jqjs.compile(query).run(doc);
      return label.endsWith('key') || label.endsWith('keys')
        ? (out.length && out[0].t === 'o' ? out[0].k.length : 0)
        : out.length;
    });
  }, rows.map(({ query, label }) => ({ query, label })));

  rows.forEach((row, i) => {
    if (!row.label) return;
    const want = +row.label.split(' ')[0];
    expect.soft(measured[i], '"' + row.query + '" really returns ' + row.label).toBe(want);
    expect.soft(want, 'no reading is offered that finds nothing').not.toBe(0);
  });

  /* Most results first: "the others like this one" is the widest reading, and
     an uncounted row keeps its place at the end. */
  const counts = rows.map((r) => (r.label ? +r.label.split(' ')[0] : -1));
  const counted = counts.slice(0, counts.indexOf(-1) < 0 ? counts.length : counts.indexOf(-1));
  expect.soft(counted.every((n, i, a) => i === 0 || a[i - 1] >= n),
    'the widest reading is offered first').toBe(true);
});

test('the arrows step through the readings', async ({ page }) => {
  await openOn(page, DEEP);
  const rows = await readings(page);
  const q = page.locator('#q');

  await q.press('ArrowDown');
  await settle(page);
  const down = await page.evaluate(() => ({
    box: __t.$('#q').value,
    on: __t.$$('#suggest .sg')[1].classList.contains('on'),
    hidden: __t.$('#suggest').hidden,
    stats: __t.text('#stats')
  }));

  expect.soft(down.box, 'down moves to the next reading').toBe(rows[1].query);
  expect.soft(down.on, 'and marks it').toBe(true);
  expect.soft(down.hidden, 'and leaves the list up').toBe(false);
  expect.soft(down.stats !== '', 'and ran it').toBe(true);

  /* Every row was counted against the document, so what the page says after
     picking one has to agree with what the row promised. */
  if (rows[1].label && +rows[1].label.split(' ')[0] !== 1) {
    expect.soft(down.stats, 'what it says it found is what the row promised')
      .toBe(rows[1].label);
  }

  await q.press('ArrowUp');
  await settle(page);
  expect.soft(await q.inputValue(), 'up goes back').toBe(rows[0].query);
  await q.press('ArrowUp');
  await settle(page);
  expect.soft(await q.inputValue(), 'up stops at the top').toBe(rows[0].query);

  for (let i = 0; i < rows.length + 2; i++) {
    await q.press('ArrowDown');
    await settle(page);
  }
  expect.soft(await q.inputValue(), 'down stops at the bottom')
    .toBe(rows[rows.length - 1].query);
});

test('a reading can be picked, and copied without picking', async ({ page }) => {
  await openOn(page, DEEP);
  const rows = await readings(page);

  await page.locator('#suggest .sg').first().locator('.sgq').click();
  await settle(page);
  const clicked = await page.evaluate(() => ({
    box: __t.$('#q').value,
    hidden: __t.$('#suggest').hidden,
    focused: document.activeElement === __t.$('#q')
  }));

  expect.soft(clicked.box, 'clicking a row puts it in the box').toBe(rows[0].query);
  expect.soft(clicked.hidden, 'and leaves the list open to try another').toBe(false);
  expect.soft(clicked.focused, 'and puts the focus back in the box').toBe(true);

  /* The copy button on a row copies that row; it does not pick it. */
  const before = clicked.box;
  await page.locator('#suggest .sg').last().locator('.sgc').click();
  await settle(page);
  const copied = await page.evaluate(() => ({
    box: __t.$('#q').value,
    hidden: __t.$('#suggest').hidden
  }));
  expect.soft(copied.box, 'the copy button does not pick the row').toBe(before);
  expect.soft(copied.hidden, 'and the list stays open').toBe(false);
});

test('what puts the list away, and what brings it back', async ({ page }) => {
  await openOn(page, DEEP);

  await clickAway(page);
  expect.soft(await page.evaluate(() => __t.$('#suggest').hidden),
    'clicking elsewhere hides it').toBe(true);

  await refocus(page);
  expect.soft(await page.evaluate(() => __t.$('#suggest').hidden),
    'focusing the box brings it back').toBe(false);

  /* Typing is different: the list answered a question about one line of the
     document, and the moment the text is not one of its readings it is
     answering a question that is no longer being asked. */
  await type(page, 'cron');
  const typed = await page.evaluate(() => ({
    hidden: __t.$('#suggest').hidden,
    rows: __t.$$('#suggest .sg').length
  }));
  expect.soft(typed.hidden, 'typing takes the list away').toBe(true);
  expect.soft(typed.rows, 'and drops what was on it').toBe(0);

  await refocus(page);
  expect.soft(await page.evaluate(() => __t.$('#suggest').hidden),
    'focus does not bring back what was dropped').toBe(true);
});

test('Escape puts the list away', async ({ page }) => {
  await openOn(page, DEEP);

  await page.locator('#q').press('Escape');
  await settle(page);
  expect.soft(await page.evaluate(() => __t.$('#suggest').hidden),
    'Escape hides the list').toBe(true);
});

test('Escape leaves the box as it was', async ({ page }) => {
  await openOn(page, DEEP);
  const before = await page.locator('#q').inputValue();

  await page.locator('#q').press('Escape');
  await settle(page);
  expect(await page.locator('#q').inputValue(), 'and leaves the box as it was').toBe(before);

  await refocus(page);
  expect(await page.evaluate(() => __t.$('#suggest').hidden),
    'and focus brings that back too').toBe(false);
});

test('where the list sits', async ({ page }) => {
  await openOn(page, '.items[0].kind');
  const got = await page.evaluate(() => ({
    box: __t.box(__t.$('#q')),
    menu: __t.box(__t.$('#suggest')),
    wrap: __t.box(__t.$('.qwrap')),
    inner: window.innerHeight,
    listZ: +getComputedStyle(__t.$('#suggest')).zIndex,
    headerZ: +getComputedStyle(__t.$('header')).zIndex
  }));

  expect.soft(Math.round(got.menu.top), 'the list hangs below the box')
    .toBeGreaterThanOrEqual(Math.round(got.box.bottom));
  near(got.menu.width, got.wrap.width, 1, 'and is as wide as it');
  expect.soft(got.menu.height, 'and is never taller than the window it drops into')
    .toBeLessThanOrEqual(got.inner * 0.6 + 1);
  expect.soft(got.listZ, 'and is drawn over the document')
    .toBeGreaterThanOrEqual(got.headerZ);
});
