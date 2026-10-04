import { setTimeout as delay } from 'node:timers/promises';
import { test, expect, settle } from '../fixtures.ts';
import type { Page } from '@playwright/test';

const time = (page: Page) => page.evaluate(() => ({
  date: Date.now(), ticks: performance.now()
}));

test('real elapsed time cannot advance the test clock', async ({ page }) => {
  const before = await time(page);
  /* Deliberately spend real time between browser calls. This must not fire
     page timers, however slow the browser or its driver is. */
  await delay(100);
  expect.soft(await time(page), 'only explicit clock advances change page time').toEqual(before);
  await settle(page, 123);
  expect.soft(await time(page)).toEqual({ date: before.date + 123, ticks: before.ticks + 123 });
});
