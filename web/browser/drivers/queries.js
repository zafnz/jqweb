/* page: default

   The search box read as a query, and the results view that replaces the
   document when one produces values that are not in it. */
T.run(async (t) => {
  const mode = t.$('#mode');
  const results = t.$('#results');
  const tree = t.$('#tree');
  const stats = t.$('#stats');

  /* The shell ships the select hidden; jqui() is what turns it on, so a page
     with the engine in it is the only page that shows one. */
  t.eq('the mode select is on screen', t.visible(mode), true);
  t.eq('it offers three readings',
    t.$$('option', mode).map((o) => o.value).join(','), 'auto,filter,jq');
  t.eq('it starts on auto', mode.value, 'auto');
  t.has('the box says a query is allowed', t.$('#q').placeholder, 'jq query');

  /* ---- what auto reads as a query ---- */

  await t.type('cron');
  t.eq('a bare word is still text to find', results.hidden, true);
  t.has('and is counted as text', t.text(stats), 'matches');

  await t.type('.items[] | select(.kind == "Pod")');
  t.eq('a leading dot is a query', results.hidden, false);
  t.eq('the document makes way for the results', tree.hidden, true);
  t.eq('one result per match', t.$$('.result', results).length, 6);
  t.eq('and the count says so', t.text(stats), '6 results');

  /* The gutter number is the position in the output, which is the only thing
     that distinguishes one result from another. */
  t.eq('results are numbered from zero',
    t.$$('.result', results).map((r) => r.dataset.n).join(','), '0,1,2,3,4,5');
  t.eq('the numbers are shown',
    getComputedStyle(t.$('.result', results), '::before').content, '"0"');

  /* A name with an argument list is a call whatever it starts with: nobody
     types select(...) meaning to search the document for that text. */
  await t.type('select(.kind == "List")');
  t.eq('a call is a query without a leading dot', results.hidden, false);
  t.eq('it returned the document', t.text(stats), '1 result, 8 keys');

  /* ---- what one result means ---- */

  await t.type('.counts | with_entries(select(.value != null))');
  t.eq('a single object is one result', t.$$('.result', results).length, 1);
  t.eq('and is described by what is in it', t.text(stats), '1 result, 5 keys');
  t.eq('a single result is not numbered', results.classList.contains('one'), true);
  t.eq('nothing is put in the gutter',
    getComputedStyle(t.$('.result', results), '::before').content, 'none');

  await t.type('[.items[].kind]');
  t.eq('a single array is one result too', t.$$('.result', results).length, 1);
  t.eq('and is described by its length', t.text(stats), '1 result, 10 items');

  await t.type('.items | length');
  t.eq('a single scalar has nothing to describe', t.text(stats), '1 result');

  await t.type('.items[] | select(.kind == "Nothing")');
  t.eq('a query that matches nothing says so', t.text(stats), '0 results');
  t.eq('and shows nothing', t.$$('.result', results).length, 0);
  t.eq('but still replaces the document', tree.hidden, true);

  /* ---- more results than are worth drawing ---- */

  await t.type('range(600)');
  t.eq('the output is capped', t.$$('.result', results).length, 500);
  t.eq('and the count says how many there really were',
    t.text(stats), 'first 500 of 600 results');

  /* ---- a query that only walks down the document ---- */

  /* A path is shown where it sits rather than lifted out of the document,
     because the value is in there and its surroundings are the answer. */
  await t.type('.items[0].metadata.name');
  t.eq('a path stays in the document', results.hidden, true);
  t.eq('the document is back', tree.hidden, false);
  t.eq('and the line is marked', t.text(stats), '.items[0].metadata.name');

  /* ---- the document is put aside, not thrown away ---- */

  await t.type('');
  await t.click(t.$(':scope > .line > .toggle', t.at('.items')));
  t.eq('a branch was collapsed by hand', t.at('.items').classList.contains('collapsed'), true);
  await t.type('.items[] | .kind');
  t.eq('the results are showing', results.hidden, false);
  await t.type('');
  t.eq('the document comes back', tree.hidden, false);
  t.eq('with the collapsing left as it was',
    t.at('.items').classList.contains('collapsed'), true);
  t.eq('and nothing left in the results view', results.innerHTML, '');

  /* ---- the mode select ---- */

  await t.click(t.$(':scope > .line > .toggle', t.at('.items')));
  await t.type('.items');
  t.eq('auto reads a path as a path', t.text(stats), '.items');

  /* Text mode takes the same characters literally, and no line of the
     document contains ".items" -- the key is spelled without the dot. */
  await t.mode('filter');
  t.eq('text mode does not resolve a path', t.text(stats), '0 matches');
  await t.type('cron');
  t.eq('text mode finds text', t.text(stats), '6 matches');

  await t.mode('jq');
  t.eq('jq mode compiles what text mode searched for', t.$('#q').classList.contains('bad'), true);
  t.has('a bare word is a filter that does not exist',
    t.text('#fault'), 'cron is not a supported filter');

  await t.type('.items');
  t.eq('jq mode reads a path as a path again', t.text(stats), '.items');
});
