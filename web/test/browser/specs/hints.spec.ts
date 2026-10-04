import { test, expect, settle, type } from '../fixtures.ts';
import type { Page } from '@playwright/test';

async function watch(page: Page) {
  return page.evaluateHandle(() => {
    const menu = __t.get('#suggest', HTMLElement);
    const changes: string[] = [];
    const observer = new MutationObserver((records) => {
      changes.push(...records.map((r) => r.type));
    });
    observer.observe(menu, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    return { menu, first: menu.firstElementChild, second: menu.children[1], changes, observer };
  });
}

test('continuing a field name keeps its hint before and after the debounce', async ({ page }) => {
  await type(page, '.items[].metad');
  const view = await watch(page);
  await page.locator('#q').pressSequentially('a');
  expect.soft(await view.evaluate((v) => !v.menu.hidden), 'the hint stays visible during the debounce').toBe(true);
  await settle(page);
  const got = await view.evaluate((v) => ({
    same: v.menu.firstElementChild === v.first,
    changes: v.changes
  }));
  expect.soft(got.same, 'the same hint element remains').toBe(true);
  expect.soft(got.changes, 'an unchanged hint needs no DOM writes').toEqual([]);
});

test('continuing select keeps the function hint in place', async ({ page }) => {
  await type(page, '.items[] | sel');
  const view = await watch(page);
  for (const letter of 'ect') {
    await page.locator('#q').pressSequentially(letter);
    expect.soft(await view.evaluate((v) => !v.menu.hidden), 'the function hint stays visible').toBe(true);
    await settle(page);
  }
  expect.soft(await view.evaluate((v) => v.menu.firstElementChild === v.first)).toBe(true);
  expect.soft(await view.evaluate((v) => v.changes), 'select keeps its original hint').toEqual([]);
  expect.soft(await page.locator('#suggest .sgt').textContent()).toBe('select(f)');
});

test('narrowing the list retains the matching hint element', async ({ page }) => {
  await type(page, '.items[].metadata.na');
  const view = await watch(page);
  await page.locator('#q').pressSequentially('mes');
  await settle(page);
  expect.soft(await page.locator('#suggest .sg').count()).toBe(1);
  expect.soft(await view.evaluate((v) => v.menu.firstElementChild === v.second), 'namespace is retained while name goes away').toBe(true);
  expect.soft(await page.locator('#suggest .sgt').textContent()).toBe('.items[].metadata.namespace');
});

test('the retained hint can be picked before the debounce', async ({ page }) => {
  await type(page, '.items[].metad');
  await page.locator('#q').pressSequentially('a');
  await page.locator('#q').press('ArrowDown');
  await settle(page);
  expect.soft(await page.locator('#q').inputValue()).toBe('.items[].metadata');
  expect.soft(await page.locator('#stats').textContent()).toBe('10 results');
});

test('an unrelated edit drops the previous hint immediately', async ({ page }) => {
  await type(page, '.items[].metad');
  await page.locator('#q').pressSequentially('X');
  expect.soft(await page.locator('#suggest').isVisible(), 'a name with no matching hint hides the list').toBe(false);
  await settle(page);
  expect.soft(await page.locator('#results .v').allTextContents()).toEqual(Array(10).fill('null'));

  await type(page, '.items[].metad');
  await page.locator('#q').fill('.counts.ra');
  expect.soft(await page.locator('#suggest').isVisible(), 'a different context drops the old list').toBe(false);
  await settle(page);
  expect.soft(await page.locator('#suggest .sgt').textContent()).toBe('.counts.ratio');
});

test('a filter button replaces completions with its readings', async ({ page }) => {
  await type(page, '.items[].metad');
  await page.locator('at=.items[0].kind').locator('> .line > .fq').click();
  await settle(page);
  expect.soft(await page.locator('#suggest .sg').count()).toBeGreaterThan(1);
  expect.soft(await page.locator('#suggest .sg.on').count()).toBe(1);
});
