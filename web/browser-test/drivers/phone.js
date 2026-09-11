/* page: default, window: 500x800

   The page on a phone. A screen this size has no room to write a jq query
   in, and the browser's own find covers text search, so at 600px and below
   the page is the tree and the fold button: no search box, no mode select,
   no count, and no copy or filter button on any line.

   500px is as narrow as headless Chrome makes a window; asking for 390
   gets 500. Phones in portrait are 430px and under, so this is wider than
   any of them but inside the same rule. */
T.run(async (t) => {
  const box = (el) => el.getBoundingClientRect();

  t.atMost('the window is phone-sized', window.innerWidth, 600);

  t.eq('the search box is gone', t.visible(t.$('#q')), false);
  t.eq('the mode select is gone', t.visible(t.$('#mode')), false);
  t.eq('the match count is gone', t.visible(t.$('#stats')), false);

  const lines = t.$$('#tree .node > .line');
  t.eq('no line shows a copy button',
    t.$$('#tree .cp').filter(t.visible).length, 0);
  t.eq('no line shows a filter button',
    t.$$('#tree .fq').filter(t.visible).length, 0);
  t.atLeast('and the lines themselves are all there', lines.length, 10);

  /* What is left fits on one row and on screen. */
  const kept = [t.$('header .name'), t.$('#fold'), t.$('#theme')];
  for (const el of kept) {
    t.eq((el.id || el.className) + ' is still there', t.visible(el), true);
    t.atMost((el.id || el.className) + ' stays on screen',
      Math.round(box(el).right), window.innerWidth);
  }
  t.eq('the toolbar is one row', t.rows(kept), 1);
  t.eq('the page has nothing to scroll sideways to',
    document.documentElement.scrollWidth <= window.innerWidth, true);

  /* Folding is what the page is for here, so both ways of doing it work. */
  const items = t.at('.items');
  await t.click(t.$(':scope > .line > .toggle', items));
  t.eq('the toggle collapses a branch', items.classList.contains('collapsed'), true);
  await t.click(t.$(':scope > .line > .fold', items));
  t.eq('the summary expands it again', items.classList.contains('collapsed'), false);

  const fold = t.$('#fold');
  await t.click(fold);
  t.eq('collapse all collapses', t.$$('#tree .node.branch.collapsed').length,
    t.$$('#tree .node.branch').length - 1);
  await t.click(fold);
  t.eq('expand all expands', t.$$('#tree .node.collapsed').length, 0);

  /* "/" would focus a box nobody can see. */
  await t.press('/');
  t.ne('"/" does not put focus in the hidden box', document.activeElement, t.$('#q'));
});
