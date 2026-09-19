/* A page jqweb serves holds /alive open for as long as it is open, which is
   how -C knows when the last tab has closed. Every other spec drives a page
   from a file; the ones here that need a server start the jqweb binary
   global-setup.ts built. */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { test, expect, settle } from '../fixtures.ts';
import { built, pageURL } from '../pages.ts';

const binary = path.join(built, 'jqweb');
const doc = path.join(import.meta.dirname, '..', 'testdata', 'doc.json');

/* Starts jqweb with args and resolves with the process, the address in its
   "serving on" line, and everything it wrote to stderr, once the line has
   arrived and, with -C, once the parent has exited. */
function start(args: string[], background: boolean) {
  return new Promise<{ proc: ChildProcess; addr: string; pid: number | null; stderr: string }>((resolve, reject) => {
    const env = { ...process.env, JQWEB_NO_UPDATE_CHECK: '1' };
    const proc = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = () => {
      const addr = /serving on http:\/\/(\S+)\//.exec(stderr);
      const pid = /running in the background, pid (\d+)/.exec(stderr);
      if (!addr || (background && !pid)) return false;
      settled = true;
      resolve({ proc, addr: addr[1], pid: pid && Number(pid[1]), stderr });
      return true;
    };
    proc.stderr.on('data', (b) => {
      stderr += b;
      if (!background && !settled) finish();
    });
    proc.on('exit', () => {
      if (!settled && !finish()) reject(new Error('jqweb exited: ' + stderr));
    });
  });
}

/* Whether anything accepts a connection at addr. */
function answers(addr: string) {
  const [host, port] = addr.split(':');
  return new Promise<boolean>((resolve) => {
    const sock = net.connect(Number(port), host);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

test('a page written to a file makes no request for /alive', async ({ page }) => {
  await page.addInitScript(() => {
    window.__sources = [];
    const Source = window.EventSource;
    window.EventSource = class extends Source {
      constructor(url: string | URL, init?: EventSourceInit) { super(url, init); window.__sources.push(String(url)); }
    };
  });
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(pageURL('default'));
  await settle(page);

  expect.soft(await page.evaluate(() => __t.$$('#tree .node').length),
    'the tree was built').toBeGreaterThan(0);
  expect.soft(await page.evaluate(() => window.__sources), 'no EventSource was opened').toEqual([]);
  expect.soft(requests.filter((u) => u.endsWith('/alive')), 'nothing asked for /alive').toEqual([]);
});

test('a served page opens /alive', async ({ context }) => {
  const server = await start(['-p', '0', doc], false);
  try {
    const page = await context.newPage();
    const alive = page.waitForRequest((r) => new URL(r.url()).pathname === '/alive');
    await page.goto('http://' + server.addr + '/');
    const request = await alive;
    expect.soft(request.resourceType(), 'it is an EventSource').toBe('eventsource');
    expect.soft(await page.evaluate(() => document.querySelectorAll('#tree .node').length),
      'and the tree was still built').toBeGreaterThan(0);
  } finally {
    server.proc.kill();
  }
});

test('with -C the server outlives its tab by the close delay and no more', async ({ context }) => {
  const server = await start(['-C', '--close-delay', '300ms', doc], true);
  try {
    expect.soft(server.proc.exitCode, 'the parent returned').toBe(0);
    const page = await context.newPage();
    const alive = page.waitForRequest((r) => new URL(r.url()).pathname === '/alive');
    await page.goto('http://' + server.addr + '/');
    await alive;

    await new Promise((r) => setTimeout(r, 1500));
    expect.soft(await answers(server.addr), 'serving while the tab is open').toBe(true);

    await page.reload();
    await new Promise((r) => setTimeout(r, 1500));
    expect.soft(await answers(server.addr), 'serving after a reload').toBe(true);

    await page.close();
    const closed = Date.now();
    while (await answers(server.addr) && Date.now() - closed < 10000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect.soft(await answers(server.addr), 'stopped once the tab closed').toBe(false);
    expect.soft(Date.now() - closed, 'no sooner than the delay').toBeGreaterThanOrEqual(250);
  } finally {
    if (server.pid !== null) {
      try { process.kill(server.pid); } catch {}
    }
  }
});
