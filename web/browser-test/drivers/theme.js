/* page: default

   The palette in force, and the button that changes it. */
T.run(async (t) => {
  const root = document.documentElement;
  const button = t.$('#theme');
  const GLYPH = { auto: '◐', light: '☀', dark: '☾' };

  /* The palette is settled before the body is parsed, so a page never paints
     in one theme and swaps to the other while someone is looking at it. */
  const heads = t.$$('head script').map((s) => s.textContent);
  t.eq('the theme runs from the head', heads.some((s) => s.includes('jqtheme')), true);
  t.eq('and nothing else does', t.$$('head script').length, 1);
  t.ne('the palette is chosen', root.getAttribute('data-theme'), null);
  t.ne('and what was asked for is recorded', root.getAttribute('data-pref'), null);

  /* Whether the choice can outlast the tab depends on where the page was
     opened from; a page loaded from a file has no storage to write to. */
  let storage = 'available';
  try { localStorage.setItem('jqweb-probe', '1'); localStorage.removeItem('jqweb-probe'); }
  catch (e) { storage = 'blocked'; }
  t.note('local storage is ' + storage + ' on this page');

  /* ---- what the button says ---- */

  t.eq('the button reports the preference', t.text(button), GLYPH[jqtheme.current()]);
  t.has('and names it', button.title, jqtheme.current());

  /* ---- what it does ---- */

  const seen = [];
  const start = jqtheme.current();
  for (let i = 0; i < 3; i++) {
    await t.click(button);
    seen.push(jqtheme.current());
    t.eq('the button follows the preference to ' + jqtheme.current(),
      t.text(button), GLYPH[jqtheme.current()]);
    t.eq('and says so in its title', button.title, 'Theme: ' + jqtheme.current());
    t.eq('what was asked for is recorded as ' + jqtheme.current(),
      root.getAttribute('data-pref'), jqtheme.current());

    /* auto follows the operating system and keeps following it; the other two
       are a choice, and the page paints what was chosen. */
    const want = jqtheme.current() === 'auto'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : jqtheme.current();
    t.eq('the palette painted is ' + want, root.getAttribute('data-theme'), want);
  }

  t.eq('three clicks come back where they started', jqtheme.current(), start);
  t.eq('by way of the other two', new Set(seen).size, 3);

  /* The two palettes really are different, rather than two names for one. */
  await t.paint('dark');
  const dark = getComputedStyle(document.body).backgroundColor;
  const darkText = getComputedStyle(document.body).color;
  await t.paint('light');
  const light = getComputedStyle(document.body).backgroundColor;
  t.ne('light and dark paint different backgrounds', light, dark);
  t.ne('and different text', getComputedStyle(document.body).color, darkText);
  t.atLeast('light is the lighter of the two',
    t.ratio(t.rgba(light), [0, 0, 0, 1]), t.ratio(t.rgba(dark), [0, 0, 0, 1]));

  /* color-scheme goes with the palette, which is what makes the form controls
     and the scrollbar match the rest of the page rather than the system. */
  t.eq('the light palette declares itself light',
    getComputedStyle(document.documentElement).colorScheme, 'light');
  await t.paint('dark');
  t.eq('the dark palette declares itself dark',
    getComputedStyle(document.documentElement).colorScheme, 'dark');
});
