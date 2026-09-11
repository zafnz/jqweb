/* page: default

   What a reader can actually make out, in both palettes. The ratios are
   measured rather than eyeballed because eyeballing one screen has been wrong
   before: dimming the line buttons with opacity gave 1.6:1 in light, which is
   no button at all, and looked fine on the machine it was written on.

   Words are held to 4.5:1 and the things that are shapes rather than words --
   the buttons on a line, the result gutter -- to 3:1, which is what WCAG asks
   of each. */
T.run(async (t) => {
  const TEXT = 4.5;
  const SHAPE = 3;

  /* Six places do not reach that today. They are held to what they do reach,
     so that a change making any of them dimmer still fails, and raising them
     is tracked in zafnz/jqweb#23 rather than here. */
  const BELOW = {
    'the result count in light': 4.25,
    'the gutter number on a result in light': 2.73,
    'the summary on a collapsed branch in light': 3.14,
    'a value on a marked line in light': 4.14,
    'the copy button on a row in dark': 2.28,
    'the copy button on a row in light': 2.60
  };

  const ratio = (name, el, want, pseudo) =>
    t.atLeast(name, t.contrast(el, pseudo), BELOW[name] === undefined ? want : BELOW[name]);

  /* Every colour in the page is a custom property, so a palette that forgets
     one leaves an element with no colour at all rather than a wrong one. */
  const names = new Set();
  for (const style of t.$$('style')) {
    for (const m of style.textContent.matchAll(/(--[a-z-]+)\s*:/g)) names.add(m[1]);
  }
  t.atLeast('the stylesheet defines colours as custom properties', names.size, 20);

  await t.type('.items[] | .kind');
  const gutter = t.$('#results .result');
  t.check('a result is on screen to measure', !!gutter);

  for (const theme of ['dark', 'light']) {
    await t.paint(theme);
    const say = (what) => what + ' in ' + theme;

    for (const name of names) {
      t.ne(say(name + ' is defined'),
        getComputedStyle(document.documentElement).getPropertyValue(name).trim(), '');
    }

    ratio(say('a value against the page'), t.$('#results .v'), TEXT);
    ratio(say('the toolbar title'), t.$('header .name a'), TEXT);
    ratio(say('a toolbar button'), t.$('#fold'), TEXT);
    ratio(say('the mode select'), t.$('#mode'), TEXT);
    ratio(say('the result count'), t.$('#stats'), TEXT);
    ratio(say('the gutter number on a result'), gutter, SHAPE, '::before');
  }

  /* The document, its keys and its strings. */
  await t.type('');
  for (const theme of ['dark', 'light']) {
    await t.paint(theme);
    const say = (what) => what + ' in ' + theme;

    ratio(say('a key'), t.$('#tree .key'), TEXT);
    ratio(say('a string'), t.$('#tree .str'), TEXT);
    ratio(say('a number'), t.$('#tree .num'), TEXT);
    ratio(say('a bracket'), t.$('#tree .p'), TEXT);
    ratio(say('null'), t.$('#tree .null'), TEXT);
    ratio(say('a separating comma'), t.$('#tree .c'), TEXT);
    ratio(say('the toggle on a branch'), t.$('#tree .toggle'), SHAPE);
    ratio(say('the copy button at rest'), t.$('#tree .cp'), SHAPE);
    ratio(say('the filter button at rest'), t.$('#tree .fq'), SHAPE);

    /* A collapsed branch's summary is the only thing left on that line, so it
       is read rather than glanced at. */
    const items = t.at('.items');
    items.classList.add('collapsed');
    ratio(say('the summary on a collapsed branch'), t.$(':scope > .line > .fold', items), TEXT);
    items.classList.remove('collapsed');

    /* A marked line is a translucent wash over the page, so what matters is
       the value read through it rather than either colour on its own. */
    await t.type('cron');
    ratio(say('a value on a marked line'), t.$('#tree .node.hit > .line .v'), TEXT);
    await t.type('');
  }

  /* The error message and the suggestion list, each on its own background. */
  await t.type('.items[');
  for (const theme of ['dark', 'light']) {
    await t.paint(theme);
    ratio('the error message in ' + theme, t.$('#fault'), TEXT);
  }

  await t.type('');
  await t.click(t.$(':scope > .line > .fq', t.at('.items[0].metadata.labels.app')));
  for (const theme of ['dark', 'light']) {
    await t.paint(theme);
    const say = (what) => what + ' in ' + theme;
    ratio(say('a query on the suggestion list'), t.$('#suggest .sgt'), TEXT);
    ratio(say('the count beside it'), t.$('#suggest .sg:not(.on) .sgn'), TEXT);
    ratio(say('the count on the picked row'), t.$('#suggest .sg.on .sgn'), TEXT);
    ratio(say('the copy button on a row'), t.$('#suggest .sgc'), SHAPE);
  }
});
