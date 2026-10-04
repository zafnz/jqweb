import { test, expect, settle, type } from '../fixtures.ts';
import type { Page } from '@playwright/test';

const pods = '.items[] | select(.kind == "Pod")';

/* Observe writes rather than timing them: rebuilding a large view stalls
   typing, even when the replacement looks exactly like what was there. */
async function watch(page: Page) {
  return page.evaluateHandle(() => {
    const results = __t.get('#results', HTMLElement);
    const tree = __t.get('#tree', HTMLElement);
    const changes: { target: string; type: string; added: number; removed: number }[] = [];
    const observer = new MutationObserver((records) => {
      changes.push(...records.map((r) => ({
        target: (r.target as HTMLElement).id,
        type: r.type,
        added: r.addedNodes.length,
        removed: r.removedNodes.length
      })));
    });
    observer.observe(results, { childList: true, attributes: true, attributeFilter: ['hidden'] });
    observer.observe(tree, { attributes: true, attributeFilter: ['hidden'] });
    return { first: results.firstElementChild, changes, observer };
  });
}

test('editing an unchanged result preserves its DOM and folds', async ({ page }) => {
  await type(page, pods);
  await page.locator('#results .result').first().locator('> .node > .line > .toggle').click();
  const view = await watch(page);

  await page.locator('#q').press('End');
  await page.locator('#q').pressSequentially(' ');
  await settle(page);
  await type(page, '.items[] | select(.kind == "Pod" )');
  const got = await view.evaluate((v) => ({
    same: v.first === __t.get('#results', HTMLElement).firstElementChild,
    folded: v.first?.firstElementChild?.classList.contains('collapsed'),
    changes: v.changes,
    stats: __t.text('#stats')
  }));
  expect.soft(got.same, 'unchanged results keep their elements').toBe(true);
  expect.soft(got.folded, 'and keep their folds').toBe(true);
  expect.soft(got.changes, 'neither view is cleared or toggled').toEqual([]);
  expect.soft(got.stats, 'the count still describes the result').toBe('6 results');
});

test('equal newly computed values do not rebuild results', async ({ page }) => {
  await type(page, '.items | map({name: (.metadata.name + "")})');
  const view = await watch(page);
  await type(page, '[.items[] | {name: (.metadata.name + "")}]');
  expect.soft(await view.evaluate((v) => v.changes), 'equivalent computed trees keep the view').toEqual([]);
});

test('continuing an unknown key keeps the same null results', async ({ page }) => {
  await type(page, pods + ' | .bla');
  const view = await watch(page);
  for (const letter of 'blalba') {
    await page.locator('#q').pressSequentially(letter);
    await settle(page);
  }
  expect.soft(await view.evaluate((v) => v.changes), 'the same nulls are not rendered again').toEqual([]);
  expect.soft(await page.locator('#results .v').allTextContents()).toEqual(Array(6).fill('null'));
});

test('incomplete and failing queries leave the last successful view intact', async ({ page }) => {
  await type(page, pods);
  const view = await watch(page);
  for (const suffix of [' |', ' | select(', ' | error("oops")']) {
    await type(page, pods + suffix);
    expect.soft(await page.locator('#fault').isVisible(), 'the error is still reported').toBe(true);
    expect.soft(await page.locator('#results').isVisible(), 'the previous result stays visible').toBe(true);
  }
  await type(page, pods + ' | .');
  expect.soft(await page.locator('#suggest').isVisible(), 'a partial field offers completions').toBe(true);
  await type(page, pods);
  const got = await view.evaluate((v) => ({ changes: v.changes, stats: __t.text('#stats') }));
  expect.soft(got.changes, 'errors and recovery do not discard the view').toEqual([]);
  expect.soft(got.stats, 'recovery restores its count').toBe('6 results');
  expect.soft(await page.locator('#fault').isVisible(), 'recovery clears the error').toBe(false);
});

test('changed results replace the view without revealing the document', async ({ page }) => {
  await type(page, pods);
  const view = await watch(page);
  await type(page, pods + ' | .metadata.name');
  expect.soft(await view.evaluate((v) => v.changes), 'there is one direct replacement').toEqual([
    { target: 'results', type: 'childList', added: 6, removed: 6 }
  ]);
  expect.soft(await page.locator('#results .v').allTextContents()).toEqual([
    '"web-0"', '"web-1"', '"api-0"', '"api-1"', '"cron-0"', '"cron-1"'
  ]);
});

test('an unchanged displayed prefix still updates the total result count', async ({ page }) => {
  await type(page, 'range(0; 501)');
  const view = await watch(page);
  await type(page, 'range(0; 502)');
  expect.soft(await view.evaluate((v) => v.changes), 'the displayed values are unchanged').toEqual([]);
  expect.soft(await page.locator('#stats').textContent()).toBe('first 500 of 502 results');
});

test('object order and number spelling are changes to the view', async ({ page }) => {
  await type(page, '({a: 1, b: 2})');
  await type(page, '({b: 2, a: 1})');
  expect.soft(await page.locator('#results .key').allTextContents()).toEqual(['"b"', '"a"']);
  await type(page, '.counts.ratio | .');
  expect.soft(await page.locator('#results .v').textContent()).toBe('1.50');
  await type(page, '(1.5)');
  expect.soft(await page.locator('#results .v').textContent()).toBe('1.5');
});

test('rerunning a time-dependent query still evaluates it', async ({ page }) => {
  await type(page, '(now)');
  const before = await page.locator('#results .v').textContent();
  await settle(page, 2000);
  await type(page, '(now)');
  expect.soft(await page.locator('#results .v').textContent()).not.toBe(before);
});

for (const next of ['.items[0]', 'Running', '']) {
  test('returning to the document with ' + JSON.stringify(next), async ({ page }) => {
    await type(page, pods);
    await type(page, next);
    expect.soft(await page.locator('#tree').isVisible(), 'the document returns').toBe(true);
    expect.soft(await page.locator('#results').isVisible(), 'the result view goes away').toBe(false);
    expect.soft(await page.locator('#results .result').count(), 'old results are released').toBe(0);
  });
}
