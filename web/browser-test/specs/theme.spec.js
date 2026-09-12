/* The palette in force, and the button that changes it. */

'use strict';

const { test, expect, settle } = require('../fixtures.js');

test.use({ variant: 'default' });

const GLYPH = { auto: '◐', light: '☀', dark: '☾' };

test('the palette is settled before the body is parsed', async ({ page }) => {
  const got = await page.evaluate(() => ({
    headScripts: __t.$$('head script').length,
    themeInHead: __t.$$('head script').map((s) => s.textContent)
      .some((s) => s.includes('jqtheme')),
    theme: document.documentElement.getAttribute('data-theme'),
    pref: document.documentElement.getAttribute('data-pref'),
    /* Whether the choice can outlast the tab depends on where the page was
       opened from; a page loaded from a file has no storage to write to. */
    storage: (() => {
      try {
        localStorage.setItem('jqweb-probe', '1');
        localStorage.removeItem('jqweb-probe');
        return 'available';
      } catch (e) { return 'blocked'; }
    })()
  }));

  test.info().annotations.push({
    type: 'note', description: 'local storage is ' + got.storage + ' on this page'
  });

  expect.soft(got.themeInHead, 'the theme runs from the head').toBe(true);
  expect.soft(got.headScripts, 'and nothing else does').toBe(1);
  expect.soft(got.theme, 'the palette is chosen').not.toBe(null);
  expect.soft(got.pref, 'and what was asked for is recorded').not.toBe(null);
});

test('the button reports and changes the preference', async ({ page }) => {
  const at = await page.evaluate(() => ({
    current: window.jqtheme.current(),
    button: __t.text('#theme'),
    title: __t.$('#theme').title
  }));

  expect.soft(at.button, 'the button reports the preference').toBe(GLYPH[at.current]);
  expect.soft(at.title, 'and names it').toContain(at.current);

  const seen = [];
  for (let i = 0; i < 3; i++) {
    await page.locator('#theme').click();
    await settle(page);
    const got = await page.evaluate(() => {
      const current = window.jqtheme.current();
      return {
        current,
        button: __t.text('#theme'),
        title: __t.$('#theme').title,
        pref: document.documentElement.getAttribute('data-pref'),
        theme: document.documentElement.getAttribute('data-theme'),
        /* auto follows the operating system and keeps following it; the other
           two are a choice, and the page paints what was chosen. */
        want: current === 'auto'
          ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
          : current
      };
    });
    seen.push(got.current);

    expect.soft(got.button, 'the button follows the preference to ' + got.current)
      .toBe(GLYPH[got.current]);
    expect.soft(got.title, 'and says so in its title').toBe('Theme: ' + got.current);
    expect.soft(got.pref, 'what was asked for is recorded as ' + got.current).toBe(got.current);
    expect.soft(got.theme, 'the palette painted is ' + got.want).toBe(got.want);
  }

  expect.soft(seen[2], 'three clicks come back where they started').toBe(at.current);
  expect.soft(new Set(seen).size, 'by way of the other two').toBe(3);
});

test('the two palettes really are different', async ({ page }) => {
  const got = await page.evaluate(() => {
    __t.paint('dark');
    const dark = getComputedStyle(document.body).backgroundColor;
    const darkText = getComputedStyle(document.body).color;
    const darkScheme = getComputedStyle(document.documentElement).colorScheme;
    __t.paint('light');
    const light = getComputedStyle(document.body).backgroundColor;
    return {
      dark, darkText, darkScheme, light,
      lightText: getComputedStyle(document.body).color,
      lightScheme: getComputedStyle(document.documentElement).colorScheme,
      darkOnBlack: __t.ratio(__t.rgba(dark), [0, 0, 0, 1]),
      lightOnBlack: __t.ratio(__t.rgba(light), [0, 0, 0, 1])
    };
  });

  expect.soft(got.light, 'light and dark paint different backgrounds').not.toBe(got.dark);
  expect.soft(got.lightText, 'and different text').not.toBe(got.darkText);
  expect.soft(got.lightOnBlack, 'light is the lighter of the two')
    .toBeGreaterThanOrEqual(got.darkOnBlack);

  /* color-scheme goes with the palette, which is what makes the form controls
     and the scrollbar match the rest of the page rather than the system. */
  expect.soft(got.lightScheme, 'the light palette declares itself light').toBe('light');
  expect.soft(got.darkScheme, 'the dark palette declares itself dark').toBe('dark');
});
