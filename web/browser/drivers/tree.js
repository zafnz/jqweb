/* page: default

   The document as it comes out on screen, and the two ways of folding it up
   again. What renderTree writes is markup rather than DOM calls, so nothing
   in core.test.js can say whether the browser makes a tree out of it. */
T.run(async (t) => {
  const root = t.$('#tree > .node');
  t.check('the root node is there', !!root);
  t.eq('the root is a branch', root.classList.contains('branch'), true);

  /* Keys in document order, which is the reason core.js parses JSON by hand:
     JSON.parse hands back an object, and an object has no order to keep. */
  const keys = t.$$(':scope > .kids > .node', root).map((n) => n.dataset.key);
  t.eq('the root keeps its keys in document order',
    keys.join(','), 'kind,apiVersion,items,counts,notes,empty,emptyList,mixed');

  /* Numbers exactly as written, for the same reason: JSON.parse turns 1.50
     into 1.5 and 1e3 into 1000, and the tree is meant to show the file. */
  t.eq('1.50 stays 1.50', t.text(t.$('.v', t.at('.counts.ratio'))), '1.50');
  t.eq('1e3 stays 1e3', t.text(t.$('.v', t.at('.counts.scale'))), '1e3');
  t.eq('-0.0 stays -0.0', t.text(t.$('.v', t.at('.counts.zero'))), '-0.0');

  /* A value with markup in it is text, not elements. */
  const notes = t.at('.notes');
  t.eq('< and > in a string are shown, not parsed',
    t.text(t.$('.v', notes)), '"a < b && c > d"');
  t.eq('a string value emits no elements of its own',
    t.$('.v', notes).children.length, 0);

  /* An empty container has nothing to expand, so it is one line with both
     brackets rather than a branch with no children. */
  t.eq('{} renders as a leaf', t.at('.empty').className, 'node leaf');
  t.eq('{} shows both brackets', t.text(t.$('.p', t.at('.empty'))), '{}');
  t.eq('[] renders as a leaf', t.at('.emptyList').className, 'node leaf');
  t.eq('[] shows both brackets', t.text(t.$('.p', t.at('.emptyList'))), '[]');

  /* Every line can be copied; only a page with the engine can be filtered on,
     and this is one. */
  t.eq('every node has a copy button',
    t.$$('#tree .node').length, t.$$('#tree .node > .line > .cp').length);
  t.eq('every node has a filter button',
    t.$$('#tree .node').length, t.$$('#tree .node > .line > .fq').length);

  /* ---- folding one branch ---- */

  const items = t.at('.items');
  const summary = t.$(':scope > .line > .fold', items);
  t.eq('an expanded branch hides its summary', t.visible(summary), false);
  t.eq('an expanded branch shows its children', t.visible(t.$(':scope > .kids', items)), true);
  t.has('the summary counts what is inside', t.text(summary), '10 items');

  await t.click(t.$(':scope > .line > .toggle', items));
  t.eq('the toggle collapses the branch', items.classList.contains('collapsed'), true);
  t.eq('a collapsed branch hides its children', t.visible(t.$(':scope > .kids', items)), false);
  t.eq('a collapsed branch hides its closing bracket',
    t.visible(t.$(':scope > .closer', items)), false);
  t.eq('a collapsed branch shows its summary', t.visible(summary), true);

  /* Clicking the summary is the other way back: it is the only thing visible
     on a collapsed line apart from the toggle. */
  await t.click(summary);
  t.eq('clicking the summary expands the branch', items.classList.contains('collapsed'), false);

  /* ---- folding the lot ---- */

  const fold = t.$('#fold');
  t.eq('the fold button starts as Collapse all', t.text(fold), 'Collapse all');

  await t.click(fold);
  t.eq('the button now offers to expand', t.text(fold), 'Expand all');
  t.eq('collapsing leaves the root open', t.$('#tree > .node').classList.contains('collapsed'), false);
  const open = t.$$('#tree .node.branch').filter((n) => !n.classList.contains('collapsed'));
  t.eq('every branch below the root is collapsed', open.length, 1);
  t.eq('the one left open is the root', open[0], t.$('#tree > .node'));

  await t.click(fold);
  t.eq('the button offers to collapse again', t.text(fold), 'Collapse all');
  t.eq('nothing is left collapsed', t.$$('#tree .node.collapsed').length, 0);

  /* Folding a branch by hand does not change what the button says: it reports
     the last thing it did rather than the state of the tree. */
  await t.click(t.$(':scope > .line > .toggle', items));
  t.eq('a hand-folded branch does not relabel the button', t.text(fold), 'Collapse all');
  await t.click(fold);
  t.eq('and collapse all still collapses', t.text(fold), 'Expand all');
});
