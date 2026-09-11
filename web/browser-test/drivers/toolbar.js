/* page: default

   The toolbar with room to lay itself out. It is a flex row holding a title,
   a select, a search box that takes what is left, a count and two buttons,
   and the failure it is prone to is one of them taking room from another. */
T.run(async (t) => {
  const header = t.$('header');
  const box = (el) => el.getBoundingClientRect();
  const bar = box(header);

  const items = [t.$('header .name'), t.$('#mode'), t.$('.qwrap'),
    t.$('#stats'), t.$('#fold'), t.$('#theme')];

  t.eq('the toolbar has room for one row', t.rows(items), 1);

  /* Nothing hangs off either end of it. */
  for (const el of items) {
    t.atLeast(el.id || el.className + ' starts inside the toolbar',
      Math.round(box(el).left), Math.round(bar.left));
    t.atMost((el.id || el.className) + ' ends inside the toolbar',
      Math.round(box(el).right), Math.round(bar.right));
  }
  t.eq('and the page has nothing to scroll sideways to',
    document.documentElement.scrollWidth <= window.innerWidth, true);

  /* The box takes what the fixed-width items leave, which is most of it. */
  t.atLeast('the search box is wider than its floor', box(t.$('#q')).width, 220);
  t.atLeast('and takes the room the rest do not want',
    box(t.$('#q')).width, bar.width / 3);

  /* The two buttons are pushed to the far end, so the box grows into the gap
     rather than the gap sitting between the buttons and the edge. */
  t.atLeast('the fold button is past the count',
    Math.round(box(t.$('#fold')).left), Math.round(box(t.$('#stats')).right));
  t.near('the theme button is at the end',
    box(t.$('#theme')).right, bar.right - 14, 2);

  /* The count sits between the box and the buttons and grows leftwards into
     nothing: a long path put there must not push the buttons off the end. */
  await t.type('.items[9].metadata.labels.namespace-that-is-long-enough-to-crowd');
  t.atMost('a long count leaves the theme button where it was',
    Math.round(box(t.$('#theme')).right), Math.round(bar.right));
  t.atLeast('and does not squeeze the search box', box(t.$('#q')).width, 220);
  await t.type('');

  /* The toolbar stays put while the document moves under it, which is what
     makes the box reachable from the bottom of a long file. */
  t.eq('the toolbar is stuck to the top', getComputedStyle(header).position, 'sticky');
  window.scrollTo(0, 1200);
  await t.sleep(100);
  t.atLeast('the page really scrolled', window.scrollY, 1000);
  t.eq('and the toolbar is still at the top', Math.round(box(header).top), 0);
  t.atLeast('over the document rather than under it',
    +getComputedStyle(header).zIndex, 1);

  /* Whatever is under the header is behind it, so the first line of the
     document has to start below it rather than beneath it. */
  window.scrollTo(0, 0);
  await t.sleep(100);
  t.atLeast('the document starts below the toolbar',
    Math.round(box(t.$('#tree')).top), Math.round(box(header).bottom));
});
