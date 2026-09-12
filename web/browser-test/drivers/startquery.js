/* page: query

   A page built with a query on the command line opens on that query, run as
   though it had been typed into the box. */
T.run(async (t) => {
  const results = t.$('#results');
  const tree = t.$('#tree');

  t.eq('the box holds the query', t.$('#q').value, '.items[] | .metadata.name');
  t.eq('auto reads it as a query, so the select stays on auto', t.$('#mode').value, 'auto');
  t.eq('the query ran without a fault', t.$('#q').classList.contains('bad'), false);
  t.eq('its results are on screen', results.hidden, false);
  t.eq('in place of the document', tree.hidden, true);
  t.eq('one result per item', t.$$('.result', results).length, 10);
  t.eq('and the count says so', t.text('#stats'), '10 results');
  t.has('the first is the first name', t.text(t.$('.result', results)), 'web-0');

  /* From there it is the search box it always was. */
  await t.type('');
  t.eq('clearing the box brings the document back', tree.hidden, false);
  t.eq('and puts the results away', results.hidden, true);
  t.eq('with nothing in it hidden', t.$$('#tree .node.hidden').length, 0);
});
