/* page: default

   A query that will not compile or will not run. The message goes under the
   box rather than beside it: as a flex item in the toolbar it competed with
   the box for room, so a long message made the box narrow while someone was
   still typing in it. */
T.run(async (t) => {
  const q = t.$('#q');
  const fault = t.$('#fault');
  const stats = t.$('#stats');

  t.eq('nothing is wrong to begin with', fault.hidden, true);

  /* ---- a query that will not compile ---- */

  await t.type('.items[');
  t.eq('the message is shown', fault.hidden, false);
  t.eq('the box is marked', q.classList.contains('bad'), true);
  t.eq('nothing is counted', t.text(stats), '');
  t.eq('the document is left alone', t.$('#tree').hidden, false);
  t.eq('and nothing is shown as a result', t.$$('#results .result').length, 0);

  /* A compile error knows where it is, and the position is written as a
     column a person can count to rather than an offset from zero. */
  t.has('the message says where', t.text(fault), '(at ');
  t.eq('the position is one-based', /\(at (\d+)\)$/.exec(t.text(fault))[1], '8');

  /* The box keeps its full width, which is the whole reason the message is
     not in the toolbar. */
  const box = q.getBoundingClientRect();
  const msg = fault.getBoundingClientRect();
  t.atLeast('the box is no narrower for the message', box.width, 220);
  t.atLeast('the message sits below the box', Math.round(msg.top), Math.round(box.bottom));
  t.near('and spans it', msg.width, t.$('.qwrap').getBoundingClientRect().width, 1);

  /* ---- a query that compiles and then fails ---- */

  await t.type('.notes + 1');
  t.eq('a runtime error is shown too', fault.hidden, false);
  t.has('and says what went wrong', t.text(fault), 'cannot be added');
  t.eq('a runtime error has no position to give', /\(at \d+\)/.test(t.text(fault)), false);

  /* ---- clearing it ---- */

  await t.type('.items | length');
  t.eq('a query that works takes the message away', fault.hidden, true);
  t.eq('and unmarks the box', q.classList.contains('bad'), false);
  t.eq('and says what it found', t.text(stats), '1 result');

  await t.type('.items[');
  t.eq('the message is back', fault.hidden, false);
  await t.type('');
  t.eq('emptying the box clears it', fault.hidden, true);
  t.eq('and unmarks the box', q.classList.contains('bad'), false);

  /* ---- errors and the suggestion list ---- */

  /* Both hang off the box in the same place, so only one of them can be on
     screen: a list of readings under an error about something else is a menu
     answering a question nobody asked. */
  await t.click(t.$(':scope > .line > .fq', t.at('.items[0].status.phase')));
  t.eq('the suggestion list is open', t.$('#suggest').hidden, false);
  await t.type('.items[');
  t.eq('typing a broken query shows the message', fault.hidden, false);
  t.eq('and takes the list away', t.$('#suggest').hidden, true);
  q.focus();
  await t.sleep(200);
  t.eq('focusing the box does not bring it back over the message',
    t.$('#suggest').hidden, true);
});
