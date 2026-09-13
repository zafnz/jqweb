/* Playwright drives the browser half of the page: the tree, the search box,
   queries and their errors, the suggestion list, folding, scrolling, the
   toolbar and the two palettes.

       npm --prefix web run test:browser
       npm --prefix web run test:browser -- suggest theme
       npm --prefix web run test:browser -- --headed

   global-setup.js builds jqweb and renders the pages first. Everything either
   of them writes goes under .out, which is not committed. */

import { defineConfig } from '@playwright/test';
import path from 'node:path';

const out = path.join(import.meta.dirname, '.out');

export default defineConfig({
  testDir: path.join(import.meta.dirname, 'specs'),
  globalSetup: path.join(import.meta.dirname, 'global-setup.js'),
  outputDir: path.join(out, 'results'),

  /* The pages are rendered once and only read, so nothing here shares state
     with anything else running beside it. */
  fullyParallel: true,
  workers: 4,

  /* A page this size takes a second or two to build its tree, and the docs
     page is 700KB of it. */
  timeout: 60000,

  /* No retries. A test that only passes sometimes is a finding, and hiding it
     behind a second attempt is how a browser suite stops meaning anything. */
  retries: 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: path.join(out, 'report'), open: 'never' }]]
    : [['list']],

  use: {
    /* The Chrome already on the machine rather than a downloaded one: the
       runner image ships it, and it is the browser people read the page in. */
    channel: 'chrome',
    headless: true,

    /* The toolbar is measured, so the space it is measured in has to be the
       same everywhere. A scrollbar is a different width on every platform and
       comes out of that space. */
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 1,
    launchOptions: { args: ['--hide-scrollbars', '--force-color-profile=srgb'] },

    /* A failure leaves behind the trace and a screenshot, which is the whole
       run rather than the page it ended on: every action, the DOM at each one,
       and the console. */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
