/* Runs the browser drivers. There is no npm package behind this: it builds
   jqweb, renders the pages the drivers ask for, injects harness.js and one
   driver into each, loads it in headless Chrome with --dump-dom, and reads
   the findings back out of <pre id="report">.

       node web/browser-test/run.js                # every driver
       node web/browser-test/run.js suggest theme  # just those two
       node web/browser-test/run.js --keep         # leave the built pages behind
       node web/browser-test/run.js --keep=/tmp/p  # and put them somewhere named

   A kept page is the whole thing that ran -- the rendered document, the
   harness and one driver -- so opening it in a browser is how to watch a
   failing check happen.

   Chrome comes from $CHROME, or from the usual places on macOS and Linux.
   Anything it prints is kept and shown only for a driver that failed. */

'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const here = __dirname;
const repo = path.resolve(here, '..', '..');

/* How long one driver gets before it is killed. Virtual time makes the page's
   own waits free, so anything approaching this is a driver that hung rather
   than one with a lot to do: the slowest of them, against the 700KB page in
   docs, takes a few seconds. */
const TIMEOUT_MS = 45000;

/* Virtual time lets the page's timers -- the 120ms the search box waits for a
   pause in typing, the 900ms a copy button stays ticked -- fire as fast as
   the renderer can get to them. The budget is a ceiling, not a wait: Chrome
   dumps as soon as there is nothing left to run. */
const VIRTUAL_TIME_MS = 60000;

/* ---- what a driver can ask to be pointed at ---- */

/* Each page is rendered once and shared by every driver naming it. "docs" is
   not rendered: it is the copy committed for GitHub Pages, and driving the
   committed bytes is the only way anything here says whether the page people
   are pointed at works. */
const PAGES = {
  default: ['-o', '$out', '$doc'],
  simple: ['--simple', '-o', '$out', '$doc'],
  light: ['--theme', 'light', '-o', '$out', '$doc'],
  docs: null
};

/* ---- finding the pieces ---- */

function findChrome() {
  const named = process.env.CHROME || process.env.CHROME_PATH;
  if (named) return named;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
       '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return found;
  throw new Error('no Chrome found; set $CHROME to one\ntried:\n  ' + candidates.join('\n  '));
}

/* ---- assembling a page to load ---- */

/* The driver's own checks, after the harness, immediately before </body>, so
   everything the page builds on load is already there when it starts.

   The replacement is a function because a string one is scanned for "$&" and
   "$$", which is how "querySelectorAll" wrappers named $$ arrive in the page
   spelled $ and redeclaring something. */
function inject(pageHtml, harness, driver) {
  const scripts = '<script>\n' + harness + '\n</script>\n<script>\n' + driver + '\n</script>\n</body>';
  return pageHtml.replace('</body>', () => scripts);
}

/* Which page a driver runs against, from the "page:" line in its header. A
   driver that does not say gets the default build. */
function pageOf(src) {
  const m = src.match(/^\s*\/\*\s*page:\s*(\w+)/);
  const name = m ? m[1] : 'default';
  if (!(name in PAGES)) throw new Error('unknown page "' + name + '"');
  return name;
}

/* The window a driver is given, from a "window: 520x800" in the same header.
   The toolbar is the reason this is settable: what it does when there is not
   enough room for it cannot be driven in a window that has room. */
const WINDOW = '1200,800';

function windowOf(src) {
  const m = src.match(/\bwindow:\s*(\d+)\s*x\s*(\d+)/);
  return m ? m[1] + ',' + m[2] : WINDOW;
}

/* ---- running one ---- */

function chromeArgs(profile, size, url) {
  return [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--user-data-dir=' + profile,
    /* Virtual time stops while a network fetch is outstanding, and a profile
       Chrome has never seen before sends it looking for sign-in, extension
       updates and default apps the moment it starts. Left on, those requests
       hold the clock still until the run is killed, and the page dumps with
       no report in it. */
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-client-side-phishing-detection',
    '--metrics-recording-only',
    /* A scrollbar is a different width on every platform, and it comes out of
       the space the toolbar is being measured in. */
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    '--window-size=' + size,
    '--virtual-time-budget=' + VIRTUAL_TIME_MS,
    '--dump-dom',
    url
  ];
}

/* Whether the dump in fd is finished, which is the only thing that says the
   page is done: Chrome writes the whole document in one go and "</html>" is
   the last thing in it. Reading the tail rather than the file keeps this
   cheap enough to poll. */
function dumped(fd) {
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 16) return false;
    const tail = Buffer.alloc(32);
    fs.readSync(fd, tail, 0, 32, size - 32);
    return tail.toString('utf8').includes('</html>');
  } catch (e) {
    return false;
  }
}

/* Loads one page, with Chrome writing the DOM into domFile.

   It has to be a file and not a pipe. Chrome stops writing at exactly 128KiB
   into a pipe about one start in forty, leaving a dump cut off mid-element
   and a browser that then sits there until it is killed. It is a race in
   Chrome rather than anything about the page -- a page whose dump is under
   128KiB never hits it, the same page written to a file never hits it, and
   the cut is at the same byte every time. Reading the dump through a pipe
   failed one run of this suite in three.

   Chrome is killed once the dump is complete rather than waited on. It does
   not reliably exit by itself: a profile it has not seen before leaves it
   running afterwards, and on macOS it starts an updater that inherits the
   handles it was given. */
function loadPage(chrome, profile, size, file, domFile) {
  return new Promise((resolve) => {
    const fd = fs.openSync(domFile, 'w+');
    let errOut = '', done = false;

    const child = spawn(chrome, chromeArgs(profile, size, 'file://' + file),
      { stdio: ['ignore', fd, 'pipe'] });
    child.stderr.on('data', (b) => { errOut += b; });

    const finish = (err) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.kill('SIGKILL');
      const bytes = fs.fstatSync(fd).size;
      fs.closeSync(fd);
      resolve({ err: err, bytes: bytes, stderr: errOut });
    };

    const poll = setInterval(() => { if (dumped(fd)) finish(null); }, 50);
    const timer = setTimeout(() => finish(new Error('no dump within ' +
      (TIMEOUT_MS / 1000) + 's, after ' + fs.fstatSync(fd).size + ' bytes')), TIMEOUT_MS);

    child.on('error', (e) => finish(e));
    /* Chrome exiting on its own is not the signal, but it does mean nothing
       more is coming; the beat is for the last of the write to land. */
    child.on('exit', () => setTimeout(() =>
      finish(dumped(fd) ? null : new Error('Chrome exited without a dump')), 50));
  });
}

/* The report the harness left in the DOM. It travels as base64 because
   --dump-dom serialises the page as HTML, and a finding is free to contain
   the angle brackets and ampersands that would not survive the trip. */
function readReport(dom) {
  const m = dom.match(/<pre id="report">([A-Za-z0-9+/=]*)<\/pre>/);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/* ---- reporting ---- */

const RED = process.stdout.isTTY ? '[31m' : '';
const GREEN = process.stdout.isTTY ? '[32m' : '';
const DIM = process.stdout.isTTY ? '[2m' : '';
const OFF = process.stdout.isTTY ? '[0m' : '';

/* Names are padded to the longest of them, so the counts line up however many
   drivers there are and whatever they are called. */
function padTo(width) { return (s) => (s + ' '.repeat(width)).slice(0, width); }

function main() {
  const argv = process.argv.slice(2);
  const kept = argv.find((a) => a === '--keep' || a.startsWith('--keep='));
  const keepIn = kept && kept.startsWith('--keep=') ? kept.slice(7) : null;
  const wanted = argv.filter((a) => !a.startsWith('-'));

  const chrome = findChrome();
  const harness = fs.readFileSync(path.join(here, 'harness.js'), 'utf8');

  const drivers = fs.readdirSync(path.join(here, 'drivers'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .filter((n) => !wanted.length || wanted.includes(n))
    .sort();

  if (!drivers.length) {
    throw new Error(wanted.length
      ? 'no driver matches ' + wanted.join(', ')
      : 'no drivers in web/browser-test/drivers');
  }

  const work = keepIn || fs.mkdtempSync(path.join(os.tmpdir(), 'jqweb-browser-'));
  fs.mkdirSync(work, { recursive: true });
  const sources = drivers.map((n) => ({
    name: n,
    src: fs.readFileSync(path.join(here, 'drivers', n + '.js'), 'utf8')
  }));

  const pages = renderPages(work, new Set(sources.map((d) => pageOf(d.src))));
  const pad = padTo(Math.max(...drivers.map((n) => n.length)));

  console.log('chrome  ' + chrome);
  console.log('drivers ' + drivers.length + ' against ' + Object.keys(pages).length + ' page(s)\n');

  return runAll(chrome, work, harness, sources, pages).then((runs) => {
    let checks = 0, failed = 0, broken = 0;

    for (const run of runs) {
      if (!run.report) {
        broken++;
        console.log(RED + 'FAIL' + OFF + '  ' + pad(run.name) + '  no report' +
          (run.err ? ' (' + run.err.message.split('\n')[0] + ')' : ''));
        console.log(DIM + '        page: ' + run.file + OFF);
        for (const line of chromeComplaints(run.stderr)) console.log(DIM + '        ' + line + OFF);
        continue;
      }
      const bad = run.report.checks.filter((c) => !c.ok);
      checks += run.report.checks.length;
      failed += bad.length;
      const tag = bad.length ? RED + 'FAIL' + OFF : GREEN + 'ok  ' + OFF;
      console.log(tag + '  ' + pad(run.name) + '  ' +
        (run.report.checks.length - bad.length) + '/' + run.report.checks.length);
      for (const c of bad) {
        console.log('        ' + RED + 'x' + OFF + ' ' + c.name + (c.detail ? ' -- ' + c.detail : ''));
      }
      for (const n of run.report.noise) console.log(DIM + '        ! ' + n + OFF);
      if (bad.length) console.log(DIM + '        page: ' + run.file + OFF);
    }

    console.log('\n' + checks + ' checks, ' + failed + ' failed' +
      (broken ? ', ' + broken + ' driver(s) produced nothing' : ''));
    if (kept) console.log('pages kept in ' + work);
    else fs.rmSync(work, { recursive: true, force: true });

    /* Set rather than exited on, so that everything written above is flushed:
       stdout to a pipe is asynchronous, and exiting on the spot cuts it off
       partway through the run that failed. */
    process.exitCode = failed || broken ? 1 : 0;
  });
}

/* Chrome writes a page of GPU and display complaints on a machine with no
   screen, none of which is about jqweb. Only what it says about running the
   page is worth showing next to a driver that failed. */
function chromeComplaints(stderr) {
  return String(stderr || '').split('\n')
    .filter((l) => /Uncaught|SyntaxError|ERROR:CONSOLE|console\.error/.test(l))
    .slice(0, 10);
}

function renderPages(work, names) {
  const doc = path.join(here, 'testdata', 'doc.json');
  const pages = {};
  let binary = null;

  for (const name of names) {
    if (name === 'docs') {
      pages.docs = path.join(repo, 'docs', 'index.html');
      if (!fs.existsSync(pages.docs)) throw new Error('docs/index.html is missing');
      continue;
    }
    if (!binary) {
      binary = path.join(work, 'jqweb');
      execFileSync('go', ['build', '-o', binary, '.'], { cwd: repo, stdio: 'inherit' });
    }
    const out = path.join(work, name + '.html');
    execFileSync(binary, PAGES[name].map((a) => a === '$out' ? out : a === '$doc' ? doc : a),
      { cwd: repo, stdio: 'inherit' });
    pages[name] = out;
  }
  return pages;
}

/* Chrome takes a couple of seconds to start whatever it is asked to do, so
   the drivers go a few at a time. */
const LANES = Math.min(4, Math.max(1, os.cpus().length));

async function runAll(chrome, work, harness, sources, pages) {
  const queue = sources.slice();
  const runs = [];

  async function lane() {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const file = path.join(work, job.name + '.run.html');
      fs.writeFileSync(file,
        inject(fs.readFileSync(pages[pageOf(job.src)], 'utf8'), harness, job.src));

      /* A profile of its own for each driver. Every page here is a file://
         URL and they all count as one origin, so a shared profile hands one
         driver the theme the last one stored. It also has to be a profile no
         Chrome has held before: these are killed as soon as they have dumped,
         and the next start on a profile left locked by a killed process waits
         rather than loading anything. */
      const profile = path.join(work, 'profile-' + job.name);
      const dom = path.join(work, job.name + '.dom.html');
      const out = await loadPage(chrome, profile, windowOf(job.src), file, dom);
      runs.push({
        name: job.name, file: file, err: out.err, stderr: out.stderr,
        report: out.bytes ? readReport(fs.readFileSync(dom, 'utf8')) : null
      });
    }
  }

  await Promise.all(Array.from({ length: LANES }, () => lane()));
  return runs.sort((a, b) => a.name.localeCompare(b.name));
}

/* Nothing here is worth a stack trace: a missing Chrome, a driver naming a
   page that does not exist and a Go build that failed are all things to read
   and fix rather than debug. */
try {
  main().catch(die);
} catch (e) {
  die(e);
}

function die(e) {
  console.error(e.message || e);
  process.exitCode = 2;
}
