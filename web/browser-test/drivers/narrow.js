/* page: default, window: 460x800

   The toolbar in a window too small to hold it in one row. It is allowed to
   wrap; what it may not do is push the page sideways, leave the search box
   below its floor, or put anything out of reach. */
T.run(async (t) => {
  const header = t.$('header');
  const box = (el) => el.getBoundingClientRect();
  const bar = box(header);

  t.atMost('the window really is a narrow one', window.innerWidth, 500);

  const items = [t.$('header .name'), t.$('#mode'), t.$('.qwrap'),
    t.$('#stats'), t.$('#fold'), t.$('#theme')];

  t.atLeast('the toolbar wraps rather than staying in one row', t.rows(items), 2);
  t.atLeast('and is taller for it', bar.height, 40);

  /* Wrapping is what keeps everything on screen; overflowing would not. */
  for (const el of items) {
    t.atMost((el.id || el.className) + ' stays on screen',
      Math.round(box(el).right), Math.round(bar.right));
    t.eq((el.id || el.className) + ' is still reachable', t.visible(el), true);
  }
  t.eq('the page has nothing to scroll sideways to',
    document.documentElement.scrollWidth <= window.innerWidth, true);

  /* The box keeps its floor: below it there is not enough of a query visible
     to edit one. */
  t.atLeast('the search box holds its minimum width', box(t.$('#q')).width, 220);

  /* Everything that hangs off the box hangs off the box, wherever it wrapped
     to, rather than off the toolbar. */
  await t.type('.items[');
  const fault = box(t.$('#fault'));
  t.atLeast('the error message follows the box down',
    Math.round(fault.top), Math.round(box(t.$('#q')).bottom));
  t.near('and is as wide as it', fault.width, box(t.$('.qwrap')).width, 1);
  t.atMost('and stays on screen', Math.round(fault.right), Math.round(window.innerWidth));

  await t.type('');
  await t.click(t.$(':scope > .line > .fq', t.at('.items[0].kind')));
  const menu = box(t.$('#suggest'));
  t.atLeast('the suggestion list follows it too',
    Math.round(menu.top), Math.round(box(t.$('#q')).bottom));
  t.atMost('and stays on screen', Math.round(menu.right), Math.round(window.innerWidth));

  /* A query too long to show is broken across lines rather than widening the
     list until the page scrolls sideways. */
  t.eq('a long query wraps inside the list',
    getComputedStyle(t.$('#suggest .sgt')).wordBreak, 'break-all');
  t.eq('and the page still has nothing to scroll sideways to',
    document.documentElement.scrollWidth <= window.innerWidth, true);

  /* Long values in the document get the same treatment: a line wraps rather
     than running off the side. */
  await t.clickAway();
  await t.type('');
  t.eq('a line of the document wraps', getComputedStyle(t.$('#tree .line')).whiteSpace, 'pre-wrap');
  t.eq('the document does not widen the page',
    document.documentElement.scrollWidth <= window.innerWidth, true);
});
