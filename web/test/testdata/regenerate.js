/* Fills in the expected output of every case in jq-corpus.json by running the
   queries through jq itself:

       node web/test/testdata/regenerate.js

   Run it after adding a case, or after a jq upgrade whose behaviour the tests
   should follow. CI has no jq, which is why the answers are committed rather
   than worked out while the tests run. */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(import.meta.dirname, 'jq-corpus.json');
const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
const input = JSON.stringify(corpus.input);

/* A query jq refuses is kept with the kind of error and whatever it printed
   first, so the engine can be held to producing the same outputs and then
   failing the same way: jq exits with 3 for a query that does not compile
   and 5 for one that fails on the input. Anything else -- a timeout, a
   signal, no jq at all -- is a fault in this script's run, not an answer. */
const cases = corpus.cases.map(({ q }) => {
  const r = spawnSync('jq', ['-c', q], { input, encoding: 'utf8', timeout: 5000 });
  if (r.error) throw r.error;
  if (r.signal || (r.status !== 0 && r.status !== 3 && r.status !== 5)) {
    throw new Error('jq gave no answer for ' + q + ': ' + (r.signal || 'exit ' + r.status) + '\n' + r.stderr);
  }
  const out = r.stdout.split('\n').filter((l) => l !== '');
  return r.status ? { q, out, error: r.status === 3 ? 'parse' : 'run' } : { q, out };
});

/* One case per line, so that adding a query shows up as one line of diff. */
const body = cases.map((c) => '    ' + JSON.stringify(c)).join(',\n');
const version = execFileSync('jq', ['--version'], { encoding: 'utf8' }).trim();
fs.writeFileSync(file,
  '{\n  "jq": ' + JSON.stringify(version) +
  ',\n  "input": ' + JSON.stringify(corpus.input, null, 2).replace(/\n/g, '\n  ') +
  ',\n  "cases": [\n' + body + '\n  ]\n}\n');

const failed = cases.filter((c) => c.error).length;
console.log(cases.length + ' cases, ' + failed + ' of them errors jq raises');
