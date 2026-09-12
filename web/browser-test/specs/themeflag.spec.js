/* --theme sets what a page starts with. This is the same page as theme.spec.js
   drives, rendered with --theme light, so the only thing it can say is whether
   the flag reaches the browser. */

'use strict';

const { test, expect, settle } = require('../fixtures.js');

test.use({ variant: 'light' });

test('--theme light reaches the browser', async ({ page }) => {
  const got = await page.evaluate(() => ({
    pref: document.documentElement.getAttribute('data-pref'),
    current: window.jqtheme.current(),
    theme: document.documentElement.getAttribute('data-theme'),
    button: __t.text('#theme'),
    /* Painting light means the light palette, not merely the attribute. */
    background: __t.ratio(__t.rgba(getComputedStyle(document.body).backgroundColor), [0, 0, 0, 1]),
    text: __t.contrast(__t.$('#tree .num'))
  }));

  expect.soft(got.pref, 'the flag is written into the page').toBe('light');
  expect.soft(got.current, 'and is what jqtheme starts from').toBe('light');
  expect.soft(got.theme, 'so the page paints light').toBe('light');
  expect.soft(got.button, 'and the button says which').toBe('☀');
  expect.soft(got.background, 'the background is a light one').toBeGreaterThanOrEqual(15);
  expect.soft(got.text, 'with dark text on it').toBeGreaterThanOrEqual(4.5);

  /* The flag says where to start, not where to stay. */
  await page.locator('#theme').click();
  await settle(page);
  const moved = await page.evaluate(() => ({
    current: window.jqtheme.current(),
    theme: document.documentElement.getAttribute('data-theme')
  }));

  expect.soft(moved.current, 'the button still moves off it').toBe('dark');
  expect.soft(moved.theme, 'and the page follows').toBe('dark');
});
