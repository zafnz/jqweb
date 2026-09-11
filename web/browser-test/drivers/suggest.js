/* page: default

   The list of readings the filter button on a line opens. suggest.test.js
   already checks that every query it builds compiles and runs; what only a
   browser can say is whether the list is right about what they return, and
   whether picking one leaves you able to try the next. */
T.run(async (t) => {
  const list = t.$('#suggest');
  const q = t.$('#q');
  const stats = t.$('#stats');
  const doc = jqweb.parseJSON(t.text('#data'));

  const rows = () => t.$$('.sg', list);
  const queryOf = (row) => t.text(t.$('.sgt', row));
  const labelOf = (row) => t.text(t.$('.sgn', row));

  t.eq('nothing is open to begin with', list.hidden, true);

  /* A label deep enough to have a ladder of pivots above it: the app label on
     one pod could mean that pod, the pods of that app, or every label. */
  await t.click(t.$(':scope > .line > .fq', t.at('.items[0].metadata.labels.app')));

  t.eq('the list opens', list.hidden, false);
  t.atLeast('with more than one reading on it', rows().length, 2);
  t.eq('the box holds the first reading', q.value, queryOf(rows()[0]));
  t.eq('the first row is marked as the one in the box', rows()[0].classList.contains('on'), true);
  t.eq('only one row is marked', t.$$('.sg.on', list).length, 1);
  t.eq('and it ran', t.text(stats) !== '', true);

  /* The label on a row is what its query returns. This is the whole point of
     the list -- picking by outcome rather than by reasoning about jq -- so it
     is checked against the engine rather than taken on trust. */
  for (const row of rows()) {
    const label = labelOf(row);
    if (!label) continue;
    const want = +label.split(' ')[0];
    const out = jqjs.compile(queryOf(row)).run(doc);
    const got = label.endsWith('key') || label.endsWith('keys')
      ? (out.length && out[0].t === 'o' ? out[0].k.length : 0)
      : out.length;
    t.eq('"' + queryOf(row) + '" really returns ' + label, got, want);
    t.ne('no reading is offered that finds nothing', want, 0);
  }

  /* Most results first: "the others like this one" is the widest reading, and
     an uncounted row keeps its place at the end. */
  const counts = rows().map((r) => (labelOf(r) ? +labelOf(r).split(' ')[0] : -1));
  t.eq('the widest reading is offered first',
    counts.slice(0, counts.indexOf(-1) < 0 ? counts.length : counts.indexOf(-1))
      .every((n, i, a) => i === 0 || a[i - 1] >= n), true);

  /* ---- stepping through the readings ---- */

  const second = queryOf(rows()[1]);
  await t.press('ArrowDown', q);
  t.eq('down moves to the next reading', q.value, second);
  t.eq('and marks it', rows()[1].classList.contains('on'), true);
  t.eq('and leaves the list up', list.hidden, false);
  t.eq('and ran it', t.text(stats) !== '', true);

  /* Every row was counted against the document, so what the page says after
     picking one has to agree with what the row promised. */
  const label = labelOf(rows()[1]);
  if (label && +label.split(' ')[0] !== 1) {
    t.eq('what it says it found is what the row promised', t.text(stats), label);
  }

  await t.press('ArrowUp', q);
  t.eq('up goes back', q.value, queryOf(rows()[0]));
  await t.press('ArrowUp', q);
  t.eq('up stops at the top', q.value, queryOf(rows()[0]));

  const last = rows().length - 1;
  for (let i = 0; i < rows().length + 2; i++) await t.press('ArrowDown', q);
  t.eq('down stops at the bottom', q.value, queryOf(rows()[last]));

  /* ---- picking one by clicking it ---- */

  await t.click(t.$('.sgq', rows()[0]));
  t.eq('clicking a row puts it in the box', q.value, queryOf(rows()[0]));
  t.eq('and leaves the list open to try another', list.hidden, false);
  t.eq('and puts the focus back in the box', document.activeElement, q);

  /* The copy button on a row copies that row; it does not pick it. */
  const before = q.value;
  await t.click(t.$('.sgc', rows()[last]));
  t.eq('the copy button does not pick the row', q.value, before);
  t.eq('and the list stays open', list.hidden, false);

  /* ---- putting it away ---- */

  await t.press('Escape', q);
  t.eq('Escape hides the list', list.hidden, true);
  t.eq('and leaves the box as it was', q.value, before);
  await t.refocus(q);
  t.eq('focusing the box brings it back', list.hidden, false);

  await t.clickAway();
  t.eq('clicking elsewhere hides it', list.hidden, true);
  await t.refocus(q);
  t.eq('and focus brings that back too', list.hidden, false);

  /* Typing is different: the list answered a question about one line of the
     document, and the moment the text is not one of its readings it is
     answering a question that is no longer being asked. */
  await t.type('cron');
  t.eq('typing takes the list away', list.hidden, true);
  t.eq('and drops what was on it', rows().length, 0);
  await t.refocus(q);
  t.eq('focus does not bring back what was dropped', list.hidden, true);

  /* ---- where the list sits ---- */

  await t.click(t.$(':scope > .line > .fq', t.at('.items[0].kind')));
  const box = q.getBoundingClientRect();
  const menu = list.getBoundingClientRect();
  t.atLeast('the list hangs below the box', Math.round(menu.top), Math.round(box.bottom));
  t.near('and is as wide as it', menu.width, t.$('.qwrap').getBoundingClientRect().width, 1);
  t.atMost('and is never taller than the window it drops into',
    menu.height, window.innerHeight * 0.6 + 1);
  t.atLeast('and is drawn over the document',
    +getComputedStyle(list).zIndex, +getComputedStyle(t.$('header')).zIndex);
});
