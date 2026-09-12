/* page: default, address: ?q=keys

   A query in a ?q= on the page's address, which a link to a served page can
   carry. It is a jq query however it reads, so a bare word such as keys is
   run rather than searched for. */
T.run(async (t) => {
  t.eq('the box holds the query from the address', t.$('#q').value, 'keys');
  t.eq('the select is on jq, where auto would search for the word', t.$('#mode').value, 'jq');
  t.eq('its result is on screen', t.$('#results').hidden, false);
  t.eq('and the count says what it is', t.text('#stats'), '1 result, 8 items');
});
