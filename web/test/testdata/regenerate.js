/* Fills in the expected output of every case in jq-corpus.json by running the
   queries through jq itself:

       node web/test/testdata/regenerate.js
       node web/test/testdata/regenerate.js jq-semantics.json

   Run it after adding a case, or after a jq upgrade whose behaviour the tests
   should follow. CI has no jq, which is why the answers are committed rather
   than worked out while the tests run. */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(import.meta.dirname, process.argv[2] || 'jq-corpus.json');
const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
const input = JSON.stringify(corpus.input);

const cases = corpus.cases.map(({ q }) => {
  const r = spawnSync('jq', ['-c', q], { input, encoding: 'utf8', timeout: 5000 });
  if (r.error) throw r.error;
  if (r.signal || ![0, 3, 5].includes(r.status)) throw new Error(`jq failed for ${q}: ${r.stderr}`);
  // Explicit sentinel errors reveal which argument ran first. Type-error
  // wording differs between engines, so only compare these literal messages.
  const message = [...q.matchAll(/error\("([^"\\]*)"\)/g)]
    .map(m => m[1]).find(text => r.stderr.trimEnd().endsWith(': ' + text));
  return { q, out: r.stdout.split('\n').filter(Boolean),
    ...(r.status ? { error: r.status === 3 ? 'parse' : 'run' } : {}),
    ...(r.status && message !== undefined ? { message } : {}) };
});

/* One case per line, so that adding a query shows up as one line of diff. */
const body = cases.map((c) => '    ' + JSON.stringify(c)).join(',\n');
fs.writeFileSync(file,
  '{\n  "jq": ' + JSON.stringify(execFileSync('jq', ['--version'], { encoding: 'utf8' }).trim()) +
  ',\n  "input": ' + JSON.stringify(corpus.input, null, 2).replace(/\n/g, '\n  ') +
  ',\n  "cases": [\n' + body + '\n  ]\n}\n');

const failed = cases.filter((c) => c.error).length;
console.log(cases.length + ' cases, ' + failed + ' of them errors');
