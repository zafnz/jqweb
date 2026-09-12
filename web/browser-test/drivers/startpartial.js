/* page: default, address: ?q=.items[].ki

   A half-typed name in the query a page opens with. Typing one holds the run
   back and offers the keys that could finish it, but a query given on the
   command line or in the address is the whole query, so it runs as written --
   nulls and all -- rather than opening on a list of completions. */
T.run(async (t) => {
  t.eq('the box holds the query', t.$('#q').value, '.items[].ki');
  t.eq('no completions are offered', t.$('#suggest').hidden, true);
  t.eq('the query ran', t.$('#results').hidden, false);
  t.eq('one result per item', t.$$('#results .result').length, 10);
  t.eq('and the count says so', t.text('#stats'), '10 results');

  /* Typing the same text is a person still typing it, which completes. */
  await t.type('.items[].ki');
  t.eq('typing it offers the key that finishes it', t.$('#suggest').hidden, false);
  t.eq('and the completion is kind', t.text('#suggest .sgt'), '.items[].kind');
});
