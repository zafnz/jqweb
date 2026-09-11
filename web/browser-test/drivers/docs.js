/* page: docs

   docs/index.html, the copy committed for GitHub Pages. It is generated and
   does not regenerate itself, so it is the one page here that nothing else
   would ever load: a change to web/ that breaks it goes unnoticed until
   someone follows the link in the README.

   It is also the only page driven at the size of a real document -- 700KB of
   kubectl output -- which is where anything that costs per line shows up. */
T.run(async (t) => {
  const stats = t.$('#stats');

  t.has('the page is built from the example document', document.title, 'k8s.json');
  t.has('and says so in the toolbar', t.text('header .name'), 'k8s.json');

  /* Built the default way, so the engine is in it: the page people are
     pointed at is the one they would get. */
  t.eq('the engine is in it', typeof jqjs, 'object');
  t.eq('the search box is wired to it', typeof jqui, 'function');
  t.eq('and the mode select is on screen', t.visible(t.$('#mode')), true);

  t.atLeast('a document of real size rendered', t.$$('#tree .node').length, 5000);
  t.eq('every line has its buttons',
    t.$$('#tree .node').length, t.$$('#tree .node > .line > .cp').length);

  /* Offline, always: a rendered page is one file, and a request going out
     would be a request that fails for anyone reading it on a plane. */
  t.eq('nothing is fetched from anywhere', t.$$('link[href], img[src], iframe').length, 0);
  t.eq('every script is inline', t.$$('script[src]').length, 0);
  t.eq('and every stylesheet is', t.$$('style').length > 0, true);
  const marks = t.$$('header svg');
  t.eq('the GitHub mark is drawn into the page', marks.length, 1);
  t.atLeast('as a path rather than a picture', t.$$('path', marks[0]).length, 1);

  /* ---- it still works ---- */

  await t.type('.items | length');
  t.eq('a query runs against it', t.$('#results').hidden, false);
  t.eq('and returns something', t.text(stats), '1 result');
  const count = +t.text(t.$('#results .v'));
  t.atLeast('the document holds a list of resources', count, 1);

  await t.type('.items[] | .kind');
  t.eq('a query with many outputs is capped, or counted',
    t.text(stats) === count + ' results' || t.text(stats).startsWith('first 500 of'), true);

  await t.type('.items[0].kind');
  t.eq('a path is shown where it sits', t.$('#tree').hidden, false);
  t.eq('and reports where it landed', t.text(stats), '.items[0].kind');

  await t.type('');
  await t.click(t.$(':scope > .line > .fq', t.at('.items[0].kind')));
  t.eq('the suggestion list opens on it', t.$('#suggest').hidden, false);
  t.atLeast('with readings on it', t.$$('#suggest .sg').length, 1);

  /* Counting every reading against a document this size is what the budget in
     query.js exists for: a row it ran out of time on is offered without a
     count rather than not offered. */
  const labels = t.$$('#suggest .sgn').map((n) => t.text(n));
  t.eq('every row is either counted or plainly not',
    labels.every((l) => l === '' || /^\d+ (result|key)s?$/.test(l)), true);

  await t.clickAway();
  await t.type('');
  await t.click(t.$('#fold'));
  t.eq('collapsing the lot works at this size', t.text('#fold'), 'Expand all');
  t.eq('and leaves the root open',
    t.$('#tree > .node').classList.contains('collapsed'), false);
});
