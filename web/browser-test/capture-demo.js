/* Builds a deterministic README screenshot from the committed example.

     node web/browser-test/capture-demo.js
     node web/browser-test/capture-demo.js /tmp/demo.png

   The browser chrome is part of the page being captured. Headless browsers do
   not include their own window chrome, and drawing this small frame keeps its
   layout independent of local browser configuration. */

'use strict';

const { chromium } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repo = path.resolve(__dirname, '..', '..');
const output = path.resolve(process.argv[2] || path.join(repo, 'demo.png'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jqweb-demo-'));

const frame = `
<div class="demo-browser-bar" aria-hidden="true">
  <div class="demo-browser-left">
    <span class="demo-lights"><i></i><i></i><i></i></span>
    <span class="demo-control demo-sidebar"><i></i><b>⌄</b></span>
    <span class="demo-control demo-nav"><b>‹</b><b class="off">›</b></span>
  </div>
  <div class="demo-address">
    <span class="demo-page"><i></i><i></i></span>
    <strong>127.0.0.1</strong>
    <b class="demo-reload">↻</b>
  </div>
  <div class="demo-browser-right">
    <span class="demo-round">↓</span>
    <span class="demo-share">⇧</span>
    <span class="demo-plus">＋</span>
    <span class="demo-tabs">▢</span>
  </div>
</div>`;

const frameStyle = `
<style>
.demo-browser-bar {
  --demo-bar-bg: #191a1e; --demo-bar-field: #1a1b1f; --demo-bar-rule: #292b31;
  --demo-bar-control: #2b2d33; --demo-bar-address: #303239; --demo-bar-fg: #d8d9dc;
  --demo-bar-strong: #f0f0f2; --demo-bar-off: #686a70;
  --demo-bar-light: #c5c7cc; --demo-stop: #ff5f57; --demo-wait: #febc2e;
  --demo-go: #28c840; --demo-shadow: rgba(0,0,0,.35);
  height: 46px; display: grid; grid-template-columns: 248px minmax(300px, 1fr) 248px;
  align-items: center; gap: 20px; padding: 0 10px 0 15px; overflow: hidden;
  color: var(--demo-bar-fg); background: var(--demo-bar-bg); border-bottom: 1px solid var(--demo-bar-rule);
  font: 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.demo-browser-left, .demo-browser-right { display: flex; align-items: center; gap: 9px; }
.demo-browser-right { justify-content: flex-end; font-size: 22px; }
.demo-lights { display: flex; gap: 9px; margin-right: 5px; }
.demo-lights i { width: 13px; height: 13px; border-radius: 50%; background: var(--demo-stop); box-shadow: inset 0 0 0 .5px var(--demo-shadow); }
.demo-lights i:nth-child(2) { background: var(--demo-wait); }
.demo-lights i:nth-child(3) { background: var(--demo-go); }
.demo-control { height: 35px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--demo-bar-control); border-radius: 18px; background: var(--demo-bar-field); }
.demo-sidebar { width: 67px; gap: 11px; }
.demo-sidebar i { width: 18px; height: 15px; border: 1.7px solid currentColor; border-radius: 3px; position: relative; }
.demo-sidebar i::before { content: ""; position: absolute; top: 0; bottom: 0; left: 5px; border-left: 1.5px solid currentColor; }
.demo-sidebar b { font-size: 18px; font-weight: 500; transform: translateY(-2px); }
.demo-nav { width: 72px; gap: 16px; }
.demo-nav b { font: 35px/.5 Georgia, serif; font-weight: 400; }
.demo-nav .off { color: var(--demo-bar-off); }
.demo-address { height: 35px; min-width: 0; display: grid; grid-template-columns: 28px 1fr 28px; align-items: center; border: 1px solid var(--demo-bar-address); border-radius: 18px; background: var(--demo-bar-field); text-align: center; }
.demo-address strong { font-weight: 600; font-size: 14px; color: var(--demo-bar-strong); }
.demo-page { width: 16px; height: 15px; margin-left: 12px; border: 1.5px solid var(--demo-bar-light); border-radius: 2px; position: relative; }
.demo-page i { position: absolute; left: 3px; right: 3px; border-top: 1.3px solid var(--demo-bar-light); }
.demo-page i:first-child { top: 4px; }
.demo-page i:last-child { top: 8px; }
.demo-reload { font-size: 22px; font-weight: 400; text-align: center; }
.demo-round { width: 26px; height: 26px; border: 1.5px solid currentColor; border-radius: 50%; display: grid; place-items: center; font-size: 18px; font-weight: 600; }
.demo-share { width: 23px; height: 22px; border: 1.5px solid currentColor; border-radius: 4px; display: grid; place-items: start center; font-size: 22px; line-height: 12px; margin: 0 2px; }
.demo-plus, .demo-tabs { font-weight: 300; }
header { top: 0; }
</style>`;

const query = '[.items[] | select(.status.phase == "Running")]';

async function main() {
  try {
    const binary = path.join(work, 'jqweb');
    const page = path.join(work, 'demo.html');
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: repo, stdio: 'inherit' });
    execFileSync(binary, ['--theme', 'dark', '-o', page, path.join(repo, 'docs', 'k8s.json')],
      { cwd: repo, stdio: 'inherit' });

    let html = fs.readFileSync(page, 'utf8');
    html = html.replace('</head>', frameStyle + '\n</head>');
    html = html.replace('<body>', '<body>' + frame);
    fs.writeFileSync(page, html);

    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.rmSync(output, { force: true });

    const browser = await chromium.launch({
      channel: 'chrome',
      args: ['--force-color-profile=srgb'],
      /* Playwright hides the scrollbar in headless, and the picture is of a
         browser showing a long document: without one the page looks like it
         ends where the screenshot does. */
      ignoreDefaultArgs: ['--hide-scrollbars']
    });
    try {
      /* Twice the size, so the picture is legible on the display the README is
         read on. */
      const context = await browser.newContext({
        viewport: { width: 1015, height: 658 },
        deviceScaleFactor: 2
      });
      const tab = await context.newPage();

      /* The query is run rather than pasted in: what the picture is of is the
         result, and the box waits for a pause in the typing before it runs
         anything. Winding the clock is that pause. */
      await tab.clock.install();
      await tab.goto(pathToFileURL(page).href);
      await tab.clock.runFor(1000);
      await tab.locator('#q').fill(query);
      await tab.clock.runFor(1000);

      /* Focused, so the box reads as the one the query was typed into. The
         caret is left out of the picture: it blinks, so a capture that included
         it would come out differently depending on when it was taken. */
      await tab.locator('#q').focus();

      await tab.screenshot({ path: output, animations: 'disabled', caret: 'hide' });
    } finally {
      await browser.close();
    }

    console.log(output);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
