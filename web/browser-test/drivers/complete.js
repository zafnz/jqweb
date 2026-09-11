/* page: default

   Completing a key name as it is typed. jq reads a missing key as null, so
   ".items[].ki" run as written is ten nulls until the "nd" of "kind" arrives;
   the page holds the run back while the name is a prefix of real keys and
   offers those instead. suggest.test.js checks what gets offered; what only a
   browser can say is that the view survives the typing and that the run
   really is held back. */
T.run(async (t) => {
  const list = t.$('#suggest');
  const q = t.$('#q');
  const stats = t.$('#stats');
  const results = t.$('#results');
  const tree = t.$('#tree');
  const fault = t.$('#fault');
  const rows = () => t.$$('.sg', list);
  const queryOf = (row) => t.text(t.$('.sgt', row));

  /* A name typed at the root offers the key it starts, where it used to say
     "no such path". */
  await t.type('.ite');
  t.eq('a half-typed name opens the list', list.hidden, false);
  t.eq('offering the key it starts', queryOf(rows()[0]), '.items');
  t.eq('and only that', rows().length, 1);
  t.eq('the document stays in view', tree.hidden, false);
  t.eq('nothing ran', t.text(stats), '');

  /* A finished query runs as it always did. */
  await t.type('.items[]');
  t.eq('a finished query runs', results.hidden, false);
  t.eq('all ten items', t.text(stats), '10 results');

  /* The moment the next name starts, the run is held: this used to replace
     the ten items with ten nulls. */
  await t.type('.items[].ki');
  t.eq('the results in view stay', results.hidden, false);
  t.eq('and stay whole', t.text(stats), '10 results');
  t.ne('no null took their place', t.text(t.$('.result .v')), 'null');
  t.eq('while the list offers the finish', queryOf(rows()[0]), '.items[].kind');

  /* A name no key starts with runs as written: those nulls are the answer to
     what was actually asked. */
  await t.type('.items[].kinX');
  t.eq('a name nothing starts with runs', t.text(t.$('.result .v')), 'null');
  t.eq('one null per item', t.text(stats), '10 results');
  t.eq('with nothing to offer', list.hidden, true);

  /* Two keys continue ".na"; equally common, so alphabetical. */
  await t.type('.items[].metadata.na');
  t.eq('every key that continues it is offered', rows().length, 2);
  t.eq('name first', queryOf(rows()[0]), '.items[].metadata.name');
  t.eq('namespace second', queryOf(rows()[1]), '.items[].metadata.namespace');

  /* A name that is a whole key runs even though a longer key continues it. */
  await t.type('.items[].metadata.name');
  t.eq('an exact key runs', t.text(stats), '10 results');
  t.eq('with no list over it', list.hidden, true);

  /* A trailing dot is a name of length zero. jq calls it a syntax error;
     here it is the widest question, so every key is the answer and no error
     shows while the next character is on its way. */
  await t.type('.items[0].');
  t.eq('a bare dot offers every key', rows().length, 4);
  t.eq('the view stays', t.text(stats), '10 results');
  t.eq('and no error shows', fault.hidden, true);

  /* After a pipe, the keys come from what flows into it. */
  await t.type('.items[] | .sp');
  t.eq('a name after a pipe completes', queryOf(rows()[0]), '.items[] | .spec');

  /* Picking a completion runs it, like picking any other row. */
  await t.click(t.$('.sgq', rows()[0]));
  t.eq('clicking one puts it in the box', q.value, '.items[] | .spec');
  t.eq('and runs it', t.text(stats), '10 results');

  /* The arrows reach the list from the box, as they do for filter readings. */
  await t.type('.items[].m');
  await t.press('ArrowDown', q);
  t.eq('down picks the first completion', q.value, '.items[].metadata');
  t.eq('and runs it', t.text(stats), '10 results');

  /* Enter runs the half-typed text as written, nulls and all. */
  await t.type('.items[].ki');
  t.eq('the run is held again', queryOf(rows()[0]), '.items[].kind');
  await t.press('Enter', q);
  t.eq('Enter runs it as written', t.text(t.$('.result .v')), 'null');
  t.eq('and puts the list away', list.hidden, true);
});
