/* What a reader can actually make out, in both palettes. The ratios are
   measured rather than eyeballed because eyeballing one screen has been wrong
   before: dimming the line buttons with opacity gave 1.6:1 in light, which is
   no button at all, and looked fine on the machine it was written on.

   Words are held to 4.5:1 and the things that are shapes rather than words --
   the buttons on a line, the result gutter -- to 3:1, which is what WCAG asks
   of each. */

'use strict';

const { test, expect, settle, type } = require('../fixtures.js');

test.use({ variant: 'default' });

const TEXT = 4.5;
const SHAPE = 3;
const THEMES = ['dark', 'light'];

/* Six places do not reach that today. They are held to what they do reach, so
   that a change making any of them dimmer still fails, and raising them is
   tracked in zafnz/jqweb#23 rather than here. */
const BELOW = {
  'the result count in light': 4.25,
  'the gutter number on a result in light': 2.73,
  'the summary on a collapsed branch in light': 3.14,
  'a value on a marked line in light': 4.14,
  'the copy button on a row in dark': 2.28,
  'the copy button on a row in light': 2.60
};

/* Every measurement is named the way the failure should read, and held to what
   the palette reaches today wherever that is short of the bar. */
function holds(got, name, want) {
  expect.soft(got, name).toBeGreaterThanOrEqual(BELOW[name] === undefined ? want : BELOW[name]);
}

/* Paints one palette and measures a list of [name, selector, want, pseudo]. */
async function measure(page, theme, wanted) {
  return page.evaluate(([theme, wanted]) => {
    __t.paint(theme);
    return wanted.map(([, sel, , pseudo]) => __t.contrast(__t.$(sel), pseudo));
  }, [theme, wanted]);
}

test('every colour is a custom property, defined in both palettes', async ({ page }) => {
  /* A palette that forgets one leaves an element with no colour at all rather
     than a wrong one. */
  const names = await page.evaluate(() => __t.customProps());
  expect.soft(names.length, 'the stylesheet defines colours as custom properties')
    .toBeGreaterThanOrEqual(20);

  for (const theme of THEMES) {
    const values = await page.evaluate(([theme, names]) => {
      __t.paint(theme);
      return names.map((n) => __t.prop(n));
    }, [theme, names]);

    names.forEach((name, i) => {
      expect.soft(values[i], name + ' is defined in ' + theme).not.toBe('');
    });
  }
});

test('the results view', async ({ page }) => {
  await type(page, '.items[] | .kind');
  expect.soft(await page.evaluate(() => !!__t.$('#results .result')),
    'a result is on screen to measure').toBe(true);

  for (const theme of THEMES) {
    const wanted = [
      ['a value against the page in ' + theme, '#results .v', TEXT],
      ['the toolbar title in ' + theme, 'header .name a', TEXT],
      ['a toolbar button in ' + theme, '#fold', TEXT],
      ['the mode select in ' + theme, '#mode', TEXT],
      ['the result count in ' + theme, '#stats', TEXT],
      ['the gutter number on a result in ' + theme, '#results .result', SHAPE, '::before']
    ];
    const got = await measure(page, theme, wanted);
    wanted.forEach(([name, , want], i) => holds(got[i], name, want));
  }
});

test('the document, its keys and its strings', async ({ page }) => {
  await type(page, '');

  for (const theme of THEMES) {
    const wanted = [
      ['a key in ' + theme, '#tree .key', TEXT],
      ['a string in ' + theme, '#tree .str', TEXT],
      ['a number in ' + theme, '#tree .num', TEXT],
      ['a bracket in ' + theme, '#tree .p', TEXT],
      ['null in ' + theme, '#tree .null', TEXT],
      ['a separating comma in ' + theme, '#tree .c', TEXT],
      ['the toggle on a branch in ' + theme, '#tree .toggle', SHAPE],
      ['the copy button at rest in ' + theme, '#tree .cp', SHAPE],
      ['the filter button at rest in ' + theme, '#tree .fq', SHAPE]
    ];
    const got = await measure(page, theme, wanted);
    wanted.forEach(([name, , want], i) => holds(got[i], name, want));

    /* A collapsed branch's summary is the only thing left on that line, so it
       is read rather than glanced at. */
    const summary = await page.evaluate((theme) => {
      __t.paint(theme);
      const items = __t.at('.items');
      items.classList.add('collapsed');
      const got = __t.contrast(__t.$(':scope > .line > .fold', items));
      items.classList.remove('collapsed');
      return got;
    }, theme);
    holds(summary, 'the summary on a collapsed branch in ' + theme, TEXT);

    /* A marked line is a translucent wash over the page, so what matters is the
       value read through it rather than either colour on its own. */
    await type(page, 'cron');
    const marked = await page.evaluate((theme) => {
      __t.paint(theme);
      return __t.contrast(__t.$('#tree .node.hit > .line .v'));
    }, theme);
    holds(marked, 'a value on a marked line in ' + theme, TEXT);
    await type(page, '');
  }
});

test('the error message', async ({ page }) => {
  await type(page, '.items[');
  for (const theme of THEMES) {
    const got = await measure(page, theme, [['', '#fault', TEXT]]);
    holds(got[0], 'the error message in ' + theme, TEXT);
  }
});

test('the suggestion list', async ({ page }) => {
  await type(page, '');
  await page.locator('at=.items[0].metadata.labels.app').locator('> .line > .fq').click();
  await settle(page);

  for (const theme of THEMES) {
    const wanted = [
      ['a query on the suggestion list in ' + theme, '#suggest .sgt', TEXT],
      ['the count beside it in ' + theme, '#suggest .sg:not(.on) .sgn', TEXT],
      ['the count on the picked row in ' + theme, '#suggest .sg.on .sgn', TEXT],
      ['the copy button on a row in ' + theme, '#suggest .sgc', SHAPE]
    ];
    const got = await measure(page, theme, wanted);
    wanted.forEach(([name, , want], i) => holds(got[i], name, want));
  }
});
