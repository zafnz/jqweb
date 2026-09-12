/* page: query, address: ?q=.kind

   A page built with one query and opened with another in its address. The
   one in the address runs, since whoever opened the page chose it after the
   page was built. */
T.run(async (t) => {
  t.eq('the box holds the query from the address', t.$('#q').value, '.kind');
  t.eq('which is a path, so it is shown in the document', t.$('#results').hidden, true);
  t.eq('the line it names is marked', t.$('#tree .node.hit'), t.at('.kind'));
  t.eq('and the count names it', t.text('#stats'), '.kind');
});
