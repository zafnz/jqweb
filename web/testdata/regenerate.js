/* Fills in the expected output of every case in jq-corpus.json by running the
   queries through jq itself:

       node web/testdata/regenerate.js

   Run it after adding a case, or after a jq upgrade whose behaviour the tests
   should follow. CI has no jq, which is why the answers are committed rather
   than worked out while the tests run. */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, 'jq-corpus.json');
const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
const input = JSON.stringify(corpus.input);

const cases = corpus.cases.map(({ q }) => {
  try {
    const out = execFileSync('jq', ['-c', q], { input, encoding: 'utf8', timeout: 5000 });
    return { q, out: out.split('\n').filter((l) => l !== '') };
  } catch (e) {
    return { q, error: true };
  }
});

/* One case per line, so that adding a query shows up as one line of diff. */
const body = cases.map((c) => '    ' + JSON.stringify(c)).join(',\n');
fs.writeFileSync(file,
  '{\n  "input": ' + JSON.stringify(corpus.input, null, 2).replace(/\n/g, '\n  ') +
  ',\n  "cases": [\n' + body + '\n  ]\n}\n');

const failed = cases.filter((c) => c.error).length;
console.log(cases.length + ' cases, ' + failed + ' of them errors');
