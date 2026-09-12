/* The document as it comes out on screen, and the two ways of folding it up
   again. What renderTree writes is markup rather than DOM calls, so nothing in
   core.test.js can say whether the browser makes a tree out of it. */

'use strict';

const { test, expect, settle } = require('../fixtures.js');

test.use({ variant: 'default' });

test('the document renders as a tree', async ({ page }) => {
  const got = await page.evaluate(() => {
    const root = __t.$('#tree > .node');
    const notes = __t.at('.notes');
    return {
      root: !!root,
      branch: root.classList.contains('branch'),
      /* Keys in document order, which is the reason core.js parses JSON by
         hand: JSON.parse hands back an object, and an object has no order. */
      keys: __t.$$(':scope > .kids > .node', root).map((n) => n.dataset.key).join(','),
      /* Numbers exactly as written, for the same reason: JSON.parse turns 1.50
         into 1.5 and 1e3 into 1000, and the tree is meant to show the file. */
      ratio: __t.text(__t.$('.v', __t.at('.counts.ratio'))),
      scale: __t.text(__t.$('.v', __t.at('.counts.scale'))),
      zero: __t.text(__t.$('.v', __t.at('.counts.zero'))),
      /* A value with markup in it is text, not elements. */
      notesText: __t.text(__t.$('.v', notes)),
      notesChildren: __t.$('.v', notes).children.length,
      /* An empty container has nothing to expand, so it is one line with both
         brackets rather than a branch with no children. */
      emptyClass: __t.at('.empty').className,
      emptyText: __t.text(__t.$('.p', __t.at('.empty'))),
      emptyListClass: __t.at('.emptyList').className,
      emptyListText: __t.text(__t.$('.p', __t.at('.emptyList'))),
      nodes: __t.$$('#tree .node').length,
      copies: __t.$$('#tree .node > .line > .cp').length,
      filters: __t.$$('#tree .node > .line > .fq').length
    };
  });

  expect.soft(got.root, 'the root node is there').toBe(true);
  expect.soft(got.branch, 'the root is a branch').toBe(true);
  expect.soft(got.keys, 'the root keeps its keys in document order')
    .toBe('kind,apiVersion,items,counts,notes,empty,emptyList,mixed');
  expect.soft(got.ratio, '1.50 stays 1.50').toBe('1.50');
  expect.soft(got.scale, '1e3 stays 1e3').toBe('1e3');
  expect.soft(got.zero, '-0.0 stays -0.0').toBe('-0.0');
  expect.soft(got.notesText, '< and > in a string are shown, not parsed').toBe('"a < b && c > d"');
  expect.soft(got.notesChildren, 'a string value emits no elements of its own').toBe(0);
  expect.soft(got.emptyClass, '{} renders as a leaf').toBe('node leaf');
  expect.soft(got.emptyText, '{} shows both brackets').toBe('{}');
  expect.soft(got.emptyListClass, '[] renders as a leaf').toBe('node leaf');
  expect.soft(got.emptyListText, '[] shows both brackets').toBe('[]');
  expect.soft(got.copies, 'every node has a copy button').toBe(got.nodes);
  expect.soft(got.filters, 'every node has a filter button').toBe(got.nodes);
});

test('one branch folds and unfolds', async ({ page }) => {
  const items = page.locator('at=.items');
  const summary = items.locator('> .line > .fold');

  const open = await page.evaluate(() => {
    const items = __t.at('.items');
    return {
      summaryVisible: __t.visible(__t.$(':scope > .line > .fold', items)),
      kidsVisible: __t.visible(__t.$(':scope > .kids', items)),
      summaryText: __t.text(__t.$(':scope > .line > .fold', items))
    };
  });

  expect.soft(open.summaryVisible, 'an expanded branch hides its summary').toBe(false);
  expect.soft(open.kidsVisible, 'an expanded branch shows its children').toBe(true);
  expect.soft(open.summaryText, 'the summary counts what is inside').toContain('10 items');

  await items.locator('> .line > .toggle').click();
  await settle(page);
  const closed = await page.evaluate(() => {
    const items = __t.at('.items');
    return {
      collapsed: items.classList.contains('collapsed'),
      kidsVisible: __t.visible(__t.$(':scope > .kids', items)),
      closerVisible: __t.visible(__t.$(':scope > .closer', items)),
      summaryVisible: __t.visible(__t.$(':scope > .line > .fold', items))
    };
  });

  expect.soft(closed.collapsed, 'the toggle collapses the branch').toBe(true);
  expect.soft(closed.kidsVisible, 'a collapsed branch hides its children').toBe(false);
  expect.soft(closed.closerVisible, 'a collapsed branch hides its closing bracket').toBe(false);
  expect.soft(closed.summaryVisible, 'a collapsed branch shows its summary').toBe(true);

  /* Clicking the summary is the other way back: it is the only thing visible on
     a collapsed line apart from the toggle. */
  await summary.click();
  await settle(page);
  const reopened = await page.evaluate(() => __t.at('.items').classList.contains('collapsed'));
  expect.soft(reopened, 'clicking the summary expands the branch').toBe(false);
});

test('the fold button folds the lot', async ({ page }) => {
  const fold = page.locator('#fold');

  expect.soft(await fold.textContent(), 'the fold button starts as Collapse all').toBe('Collapse all');

  await fold.click();
  await settle(page);
  const collapsed = await page.evaluate(() => {
    const open = __t.$$('#tree .node.branch').filter((n) => !n.classList.contains('collapsed'));
    return {
      label: __t.text('#fold'),
      rootOpen: __t.$('#tree > .node').classList.contains('collapsed'),
      open: open.length,
      openIsRoot: open[0] === __t.$('#tree > .node')
    };
  });

  expect.soft(collapsed.label, 'the button now offers to expand').toBe('Expand all');
  expect.soft(collapsed.rootOpen, 'collapsing leaves the root open').toBe(false);
  expect.soft(collapsed.open, 'every branch below the root is collapsed').toBe(1);
  expect.soft(collapsed.openIsRoot, 'the one left open is the root').toBe(true);

  await fold.click();
  await settle(page);
  const expanded = await page.evaluate(() => ({
    label: __t.text('#fold'),
    collapsed: __t.$$('#tree .node.collapsed').length
  }));

  expect.soft(expanded.label, 'the button offers to collapse again').toBe('Collapse all');
  expect.soft(expanded.collapsed, 'nothing is left collapsed').toBe(0);

  /* Folding a branch by hand does not change what the button says: it reports
     the last thing it did rather than the state of the tree. */
  await page.locator('at=.items').locator('> .line > .toggle').click();
  await settle(page);
  expect.soft(await fold.textContent(), 'a hand-folded branch does not relabel the button')
    .toBe('Collapse all');

  await fold.click();
  await settle(page);
  expect.soft(await fold.textContent(), 'and collapse all still collapses').toBe('Expand all');
});
