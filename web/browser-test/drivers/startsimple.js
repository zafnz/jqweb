/* page: simplequery

   A page built with --simple and a query. There is no engine to run it, so
   the page reads it the way it reads anything typed, and .items[3] is a path
   to look up. */
T.run(async (t) => {
  t.eq('the box holds the query', t.$('#q').value, '.items[3]');
  t.eq('the path resolves', t.text('#stats'), '.items[3]');
  t.eq('and its line is marked', t.$('#tree .node.hit'), t.at('.items[3]'));
  t.eq('the lines outside it are hidden', t.at('.items[0]').classList.contains('hidden'), true);
});
