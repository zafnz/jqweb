/* page: default

   Where the page goes when a search reveals something. Three of these are
   settled bugs rather than guesses: centring a node taller than the window
   put the middle of the document in the middle of the screen, so typing "."
   threw the reader halfway down the file; and a path typed one character at a
   time dragged the page around on every keystroke. */
T.run(async (t) => {
  const header = t.$('header');
  const below = () => header.getBoundingClientRect().bottom;
  const top = (node) => node.getBoundingClientRect().top;

  const height = document.documentElement.scrollHeight;
  t.atLeast('the document is taller than the window', height, window.innerHeight * 3);

  /* ---- the root ---- */

  window.scrollTo(0, height);
  await t.sleep(100);
  t.atLeast('the page is scrolled to the bottom', window.scrollY, window.innerHeight);

  await t.type('.');
  t.atMost('. goes to the top of the document, not the middle of it', window.scrollY, 50);
  t.near('which puts the first line under the toolbar',
    top(t.$('#tree > .node')), below(), 12);

  /* ---- something further down than the window ---- */

  await t.type('');
  window.scrollTo(0, 0);
  await t.sleep(100);

  await t.type('.items[9].status');
  const target = t.$('#tree .node.hit');
  t.eq('the path landed', t.text('#stats'), '.items[9].status');
  t.atLeast('what it landed on is not behind the toolbar', Math.round(top(target)), Math.round(below()) - 1);
  t.atMost('and is on screen', top(target), window.innerHeight);

  /* ---- what is already on screen stays where it is ---- */

  /* Typing a path a character at a time walks down through nodes that are
     already visible, and re-centring on each of them drags the page under the
     reader while they are still typing. */
  const settled = window.scrollY;
  await t.type('.items[9].status.phase');
  t.eq('a target already on screen does not move the page', window.scrollY, settled);
  await t.type('.items[9].status.restarts');
  t.eq('nor does its neighbour', window.scrollY, settled);

  /* ---- the toolbar never covers what was revealed ---- */

  for (const path of ['.items[0].kind', '.items[5].metadata.name', '.mixed[3]', '.counts.scale']) {
    await t.type('');
    window.scrollTo(0, height);
    await t.sleep(100);
    await t.type(path);
    const node = t.$('#tree .node.hit');
    t.atLeast(path + ' comes out from under the toolbar',
      Math.round(top(node)), Math.round(below()) - 1);
    t.atMost(path + ' is brought on screen', Math.round(top(node)), window.innerHeight);
  }

  /* A text search leaves the page where it is: it marks every match, and
     there is no one line to scroll to. Hiding what did not match shortens the
     document, so the browser may have nowhere near 600 left to be scrolled
     to -- what it must not do is scroll somewhere of its own choosing. */
  await t.type('');
  window.scrollTo(0, 600);
  await t.sleep(100);
  await t.type('cron');
  const most = document.documentElement.scrollHeight - window.innerHeight;
  t.eq('a text search does not scroll anywhere', window.scrollY, Math.min(600, Math.max(0, most)));
});
