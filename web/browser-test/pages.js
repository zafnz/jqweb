/* The pages the specs run against, and where they are built.

   Each variant is rendered once per run, by global-setup.js, and shared by
   every spec naming it. "docs" is not rendered: it is the copy committed for
   GitHub Pages, and driving the committed bytes is the only way anything here
   says whether the page people are pointed at works. "query" and "simplequery"
   are built with a query on the command line, for the specs checking the query
   a page opens on. */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const here = __dirname;
const repo = path.resolve(here, '..', '..');

/* Rendered pages and the binary that made them. Kept at a stable path rather
   than in a temporary directory, so a page named in a trace can be opened in a
   browser without hunting for it. Nothing under .out is committed. */
const built = path.join(here, '.out', 'pages');

const PAGES = {
  default: ['-o', '$out', '$doc'],
  simple: ['--simple', '-o', '$out', '$doc'],
  light: ['--theme', 'light', '-o', '$out', '$doc'],
  query: ['-o', '$out', '.items[] | .metadata.name', '$doc'],
  simplequery: ['--simple', '-o', '$out', '.items[3]', '$doc'],
  docs: null
};

/* The fixture: ten records with repeated fields, so a suggestion has something
   to pivot on, and long enough that the page scrolls. */
const doc = path.join(here, 'testdata', 'doc.json');

function pageFile(name) {
  if (!(name in PAGES)) throw new Error('unknown page "' + name + '"');
  return name === 'docs'
    ? path.join(repo, 'docs', 'index.html')
    : path.join(built, name + '.html');
}

/* Whatever follows the file name is added to the address, so a spec can check
   what the page reads out of its own URL. */
function pageURL(name, address) {
  return pathToFileURL(pageFile(name)).href + (address || '');
}

/* Builds jqweb and renders every variant. Rendering all of them costs a few
   hundred milliseconds next to the Go build, so there is nothing to gain from
   working out which ones this run will ask for. */
function renderAll() {
  fs.rmSync(built, { recursive: true, force: true });
  fs.mkdirSync(built, { recursive: true });

  const binary = path.join(built, 'jqweb');
  execFileSync('go', ['build', '-o', binary, '.'], { cwd: repo, stdio: 'inherit' });

  for (const [name, args] of Object.entries(PAGES)) {
    if (!args) continue;
    execFileSync(binary, args.map((a) =>
      a === '$out' ? pageFile(name) : a === '$doc' ? doc : a), { cwd: repo, stdio: 'inherit' });
  }

  const committed = pageFile('docs');
  if (!fs.existsSync(committed)) throw new Error('docs/index.html is missing');
}

module.exports = { PAGES, pageFile, pageURL, renderAll, built, repo };
