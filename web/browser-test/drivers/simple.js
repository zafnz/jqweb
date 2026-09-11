/* page: simple

   The page --simple builds. page.js ships in it and query.js does not, so
   everything that reads the box as a query has to be absent without leaving a
   hole where it was. */
T.run(async (t) => {
  const stats = t.$('#stats');

  /* None of the four files --simple leaves out is in the page. */
  t.eq('the engine is not here', typeof jqjs, 'undefined');
  t.eq('nor the search box wiring', typeof jqui, 'undefined');
  t.eq('nor the suggestion builder', typeof jqsuggest, 'undefined');
  t.eq('but the parser and renderer are', typeof jqweb, 'object');
  t.eq('and so is the theme', typeof jqtheme, 'object');

  /* The shell ships the mode select hidden and jqui() is what turns it on, so
     without jqui it stays hidden rather than offering readings nothing can
     act on. */
  t.eq('the mode select stays hidden', t.$('#mode').hidden, true);
  t.eq('and is not on screen', t.visible(t.$('#mode')), false);
  t.has('the box offers a path, not a query', t.$('#q').placeholder, 'paste a path');
  t.eq('and does not mention jq', t.$('#q').placeholder.includes('jq'), false);

  /* The filter button opens a list of queries, so there is nothing for it to
     do here and it is not drawn. The copy button is on every line either way. */
  t.eq('no line offers to filter on itself', t.$$('#tree .fq').length, 0);
  t.eq('every line still offers to copy its path',
    t.$$('#tree .node').length, t.$$('#tree .node > .line > .cp').length);

  /* ---- what is left still works ---- */

  t.atLeast('the document rendered', t.$$('#tree .node').length, 100);
  t.eq('numbers are still shown as written',
    t.text(t.$('.v', t.at('.counts.ratio'))), '1.50');

  await t.type('cron');
  t.eq('text is found', t.text(stats), '6 matches');
  t.eq('and marked', t.$$('#tree .node.hit').length, 6);

  await t.type('.counts.pods');
  t.eq('a path resolves', t.text(stats), '.counts.pods');
  t.eq('and is marked', t.$('#tree .node.hit'), t.at('.counts.pods'));

  await t.type('.counts.nope');
  t.eq('a path that runs out says where', t.text(stats), 'no path past .counts');

  /* A query is not read as one here: it is text like anything else, and
     falling back to a text search is better than saying nothing. */
  await t.type('.items[] | select(.kind == "Pod")');
  t.eq('a query is searched for as text', t.text(stats), '0 matches');
  t.eq('and nothing is reported as broken', t.$('#q').classList.contains('bad'), false);

  /* Text that looks like a path but is not one falls back to a text search,
     which is how a version number or a decimal is found. */
  await t.type('1.50');
  t.eq('text with a dot in it is still text', t.text(stats), '1 match');

  /* Nothing ever replaces the document, so the results view stays empty. */
  t.eq('the results view is never used', t.$('#results').hidden, true);
  t.eq('and holds nothing', t.$('#results').innerHTML, '');
  t.eq('the document is never put away', t.$('#tree').hidden, false);

  /* ---- and the rest of the toolbar ---- */

  await t.type('');
  await t.click(t.$('#fold'));
  t.eq('collapse all still collapses', t.text('#fold'), 'Expand all');
  t.eq('leaving the root open',
    t.$$('#tree .node.branch').filter((n) => !n.classList.contains('collapsed')).length, 1);
  await t.click(t.$('#fold'));
  t.eq('and expand all expands', t.$$('#tree .node.collapsed').length, 0);

  await t.click(t.$('#theme'));
  t.eq('the theme button still cycles', jqtheme.current(), 'light');
  t.eq('and the page follows', document.documentElement.getAttribute('data-theme'), 'light');

  t.$('#fold').focus();
  await t.press('/', t.$('#fold'));
  t.eq('/ still focuses the box', document.activeElement, t.$('#q'));
  await t.type('cron');
  await t.press('Escape', t.$('#q'));
  t.eq('and Escape still clears it', t.$('#q').value, '');
});
