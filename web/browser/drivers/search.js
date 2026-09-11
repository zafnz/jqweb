/* page: default

   The search box as text to find and as a path: what a page did before the
   engine existed and still does for anything that is not a query. */
T.run(async (t) => {
  const stats = t.$('#stats');
  t.eq('the box starts empty', t.$('#q').value, '');
  t.eq('nothing is said before anything is typed', t.text(stats), '');

  /* ---- text ---- */

  await t.type('cron');
  t.has('a word is counted, not run', t.text(stats), 'matches');
  t.eq('the lines holding it are marked', t.$$('#tree .node.hit').length > 0, true);

  /* A match keeps its ancestors on screen, or there would be no way to reach
     it, and it keeps its own subtree, or there would be no context for it. */
  const hit = t.$('#tree .node.hit');
  t.eq('a match is not hidden', hit.classList.contains('hidden'), false);
  for (let n = hit.parentElement.closest('.node'); n; n = n.parentElement.closest('.node')) {
    t.eq('an ancestor of a match stays on screen', n.classList.contains('hidden'), false);
    t.eq('an ancestor of a match is not left collapsed', n.classList.contains('collapsed'), false);
  }

  /* Every counted match really holds the text, and nothing holding it was
     hidden. Counting the marks rather than trusting the number is the point:
     the count comes from the same walk that does the hiding. */
  const marked = t.$$('#tree .node.hit');
  t.eq('the count is the number of marked lines',
    t.text(stats), marked.length + (marked.length === 1 ? ' match' : ' matches'));
  t.eq('every marked line holds the text', marked.every((n) => {
    const key = n.dataset.key === undefined ? '' : n.dataset.key;
    const v = t.$(':scope > .line > .v', n);
    return (key + '\n' + (v ? v.textContent : '')).toLowerCase().includes('cron');
  }), true);

  /* Matching is on the key as well as the value, and it ignores case. */
  await t.type('CRON');
  t.eq('case does not matter', t.text(stats), marked.length + ' matches');

  await t.type('namespace');
  t.eq('a key matches as well as a value', t.$$('#tree .node.hit').length, 10);

  await t.type('nothinghere');
  t.eq('text nothing holds finds nothing', t.text(stats), '0 matches');

  /* Clearing puts the document back. What the reader collapsed by hand is
     theirs, so nothing here reopens it. */
  await t.type('');
  t.eq('clearing says nothing', t.text(stats), '');
  t.eq('clearing hides nothing', t.$$('#tree .node.hidden').length, 0);
  t.eq('clearing marks nothing', t.$$('#tree .node.hit').length, 0);

  /* ---- paths ---- */

  await t.type('.counts.pods');
  t.eq('a path says where it landed', t.text(stats), '.counts.pods');
  t.eq('the node it names is the one marked', t.$('#tree .node.hit'), t.at('.counts.pods'));

  await t.type('.items[2].metadata.name');
  t.eq('an index in a path resolves', t.text(stats), '.items[2].metadata.name');
  t.eq('and lands on that element',
    t.text(t.$(':scope > .line > .v', t.$('#tree .node.hit'))), '"api-0"');

  await t.type('.items[-1].kind');
  t.eq('a negative index counts from the end', t.text(stats), '.items[9].kind');

  await t.type('.["notes"]');
  t.eq('a quoted segment resolves', t.text(stats), '.notes');

  /* A path that stops short says where it stopped, which is the useful half
     of the answer. */
  await t.type('.counts.nope');
  t.eq('a path that runs out says where', t.text(stats), 'no path past .counts');
  await t.type('.nope.nope');
  t.eq('a path that never starts says so', t.text(stats), 'no such path');

  /* The root is a path like any other. */
  await t.type('.');
  t.eq('. is the whole document', t.text(stats), '.');
  t.eq('. hides nothing', t.$$('#tree .node.hidden').length, 0);

  /* ---- the keys the box answers to ---- */

  await t.type('');
  t.$('#fold').focus();
  t.ne('something else has the focus', document.activeElement, t.$('#q'));
  await t.press('/', t.$('#fold'));
  t.eq('/ focuses the box', document.activeElement, t.$('#q'));

  await t.type('cron');
  await t.press('Escape', t.$('#q'));
  t.eq('Escape empties the box', t.$('#q').value, '');
  t.eq('Escape puts the document back', t.text(stats), '');
  t.eq('and hides nothing', t.$$('#tree .node.hidden').length, 0);

  /* "/" typed into the box is text to find, not a shortcut, or the box could
     never be used to search for one. */
  t.$('#q').focus();
  await t.press('/', t.$('#q'));
  t.eq('/ in the box is not swallowed', t.$('#q').value, '');
});
