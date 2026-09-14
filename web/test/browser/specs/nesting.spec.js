import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, settle, type } from '../fixtures.js';
import { built } from '../pages.js';

function nested(depth, shape) {
  let json = '"deep marker"', at = '';
  for (let i = 0; i < depth; i++) {
    const object = shape === 'object' || (shape === 'mixed' && i % 2);
    json = object ? '{"a":' + json + '}' : '[' + json + ']';
    at = (object ? '.a' : '[0]') + at;
  }
  return { json, at: at.startsWith('.') ? at : '.' + at };
}

for (const simple of [false, true]) {
  for (const shape of ['array', 'object', 'mixed']) {
    test(`${shape} at the nesting limit, ${simple ? 'simple' : 'full'} page`, async ({ page }, info) => {
      const { json, at } = nested(128, shape);
      const file = info.outputPath('deep.html');
      execFileSync(path.join(built, 'jqweb'), [...(simple ? ['--simple'] : []), '-o', file], { input: json });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(pathToFileURL(file).href);
      expect.soft(await page.locator('#tree .node').count()).toBe(129);

      await type(page, 'deep marker');
      expect.soft(await page.locator('#stats').textContent()).toBe('1 match');
      expect.soft(await page.locator('#tree .hidden').count()).toBe(0);

      await type(page, at);
      expect.soft(await page.locator('#stats').textContent()).toBe(at);
      expect.soft(await page.locator('#tree .hit > .line > .v').textContent()).toBe('"deep marker"');

      await type(page, '');
      await page.locator('#fold').click();
      await settle(page);
      expect.soft(await page.locator('#tree .collapsed').count()).toBe(127);
      await page.locator('#fold').click();
      await settle(page);
      expect.soft(await page.locator('#tree .collapsed').count()).toBe(0);
      if (!simple) {
        await type(page, '. | walk(.)');
        expect.soft(await page.locator('#results .node').count()).toBe(129);
        expect.soft(await page.locator('#results .leaf').evaluate((leaf) => {
          let parents = 0;
          for (let n = leaf.parentElement.closest('.node'); n; n = n.parentElement.closest('.node')) parents++;
          return parents;
        })).toBe(128);
        expect.soft(await page.locator('#fault').evaluate((e) => e.hidden)).toBe(true);
      }
      expect.soft(errors).toEqual([]);
    });
  }
}

for (const depth of [129, 4000, 9000]) {
  test(`fromjson rejects ${depth} levels and the page recovers`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await type(page, '(' + JSON.stringify('['.repeat(depth) + '0' + ']'.repeat(depth)) + ' | fromjson)');
    await expect.soft(page.locator('#fault')).toBeVisible();
    expect.soft(await page.locator('#fault').textContent()).toContain('JSON nesting exceeds the supported limit of 128');
    expect.soft(await page.locator('#tree').evaluate((e) => e.hidden)).toBe(false);
    expect.soft(await page.locator('#results').evaluate((e) => e.hidden)).toBe(true);
    await type(page, '.items | length');
    expect.soft(await page.locator('#fault').evaluate((e) => e.hidden)).toBe(true);
    expect.soft(await page.locator('#results .v').textContent()).toBe('10');
    expect.soft(errors).toEqual([]);
  });
}

test('queries cannot wrap a value past the limit, even before flattening', async ({ page }) => {
  const json = nested(128, 'mixed').json;
  await type(page, '[(' + JSON.stringify(json) + ' | fromjson)] | flatten');
  expect.soft(await page.locator('#fault').textContent()).toContain('JSON nesting exceeds the supported limit of 128');
  expect.soft(await page.locator('#tree').evaluate((e) => e.hidden)).toBe(false);
});
