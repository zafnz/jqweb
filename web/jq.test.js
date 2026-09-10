/* Tests for the jq subset. Run with:  node --test web/

   The bulk of the coverage is a corpus of queries whose expected output came
   from jq itself (see testdata/regenerate.js); the tests written out here
   cover what a corpus cannot -- the queries that must fail, and the stream
   behaviour that is easy to get subtly wrong. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { parseJSON, stringify } = require('./core.js');
const { compile } = require('./jq.js');
const corpus = require('./testdata/jq-corpus.json');

/* Runs a query over a JSON document and returns its outputs as JSON text, so
   that a test can talk about values rather than nodes. */
function run(query, doc) {
  return compile(query).run(parseJSON(doc)).map((n) => stringify(n));
}

/* The error a query raises, as "<kind>: <message>". */
function error(query, doc) {
  try {
    const out = run(query, doc === undefined ? 'null' : doc);
    assert.fail(`${query} did not fail; it returned ${JSON.stringify(out)}`);
  } catch (e) {
    if (!e.jq) throw e;
    return `${e.jq}: ${e.message}`;
  }
}

test('every corpus query agrees with jq', () => {
  const doc = JSON.stringify(corpus.input);
  for (const c of corpus.cases) {
    assert.deepStrictEqual(run(c.q, doc), c.out, `query ${c.q}`);
  }
});

test('the corpus exercises every builtin', () => {
  /* A builtin no corpus case runs is one whose answer has never been compared
     with jq's. The names are read back out of the table in jq.js, so adding a
     builtin without a case for it fails here. */
  const table = fs.readFileSync(require.resolve('./jq.js'), 'utf8');
  const names = new Set();
  for (const m of table.slice(table.indexOf('var builtins = {'))
    .matchAll(/^ {4}'([a-z_0-9]+)\/\d+':/gm)) names.add(m[1]);
  assert.ok(names.size > 50, `only found ${names.size} builtins to check`);

  const queries = corpus.cases.map((c) => c.q).join('\n');
  const missing = [...names].filter((n) => !new RegExp(`\\b${n}\\b`).test(queries));
  assert.deepStrictEqual(missing, [], 'builtins with no corpus case');
});

test('identity and literals', () => {
  assert.deepStrictEqual(run('.', '{"a":1}'), ['{"a":1}']);
  assert.deepStrictEqual(run('1, "x", true, false, null', 'null'),
    ['1', '"x"', 'true', 'false', 'null']);
  assert.deepStrictEqual(run('1.5, 1e3, 0.25', 'null'), ['1.5', '1000', '0.25']);
});

test('a number keeps the text it was written with until it is computed with', () => {
  /* The tree shows 1.0 and 1e5 as written, so a query that only moves a value
     around must not turn them into 1 and 100000. */
  assert.deepStrictEqual(run('.[]', '[1.0,1e5,0.10]'), ['1.0', '1e5', '0.10']);
  assert.deepStrictEqual(run('.[0] + 0', '[1.0]'), ['1']);
});

test('a stream is every output, in order', () => {
  assert.deepStrictEqual(run('.[]', '[1,2,3]'), ['1', '2', '3']);
  assert.deepStrictEqual(run('.[] | . * 10', '[1,2]'), ['10', '20']);
  assert.deepStrictEqual(run('(1,2), (3,4)', 'null'), ['1', '2', '3', '4']);
  assert.deepStrictEqual(run('[.[] | select(. > 1)]', '[1,2,3]'), ['[2,3]']);
  assert.deepStrictEqual(run('empty', 'null'), []);
  assert.deepStrictEqual(run('[empty]', 'null'), ['[]']);
});

test('a two-value operator runs its right-hand stream on the outside', () => {
  /* jq's order, which shows up the moment either side fans out. */
  assert.deepStrictEqual(run('[(1,2) + (10,20)]', 'null'), ['[11,12,21,22]']);
  assert.deepStrictEqual(run('[(1,2) < (2,2)]', 'null'), ['[true,false,true,false]']);
});

test('object construction takes its first member on the outside', () => {
  assert.deepStrictEqual(run('[{a:(1,2), b:(3,4)}]', 'null'),
    ['[{"a":1,"b":3},{"a":1,"b":4},{"a":2,"b":3},{"a":2,"b":4}]']);
});

test('a repeated key collapses to its last value', () => {
  /* The document form can hold the same key twice; jq's value model cannot. */
  assert.deepStrictEqual(run('.a', '{"a":1,"a":2}'), ['2']);
  assert.deepStrictEqual(run('keys', '{"a":1,"a":2}'), ['["a"]']);
  assert.deepStrictEqual(run('length', '{"a":1,"a":2}'), ['1']);
  assert.deepStrictEqual(run('[.[]]', '{"a":1,"a":2}'), ['[2]']);
  assert.deepStrictEqual(run('{x: 1, x: 2}', 'null'), ['{"x":2}']);
});

test('values sort in jq order across types', () => {
  assert.deepStrictEqual(run('sort', '[{},[],"s",1,true,false,null]'),
    ['[null,false,true,1,"s",[],{}]']);
  assert.deepStrictEqual(run('sort', '[[1,2],[1,1],[1]]'), ['[[1],[1,1],[1,2]]']);
  assert.deepStrictEqual(run('sort', '[{"b":1},{"a":2}]'), ['[{"a":2},{"b":1}]']);
});

test('"?" drops a type error and keeps everything else', () => {
  assert.deepStrictEqual(run('.a?', '3'), []);
  assert.deepStrictEqual(run('[.[]?]', '3'), ['[]']);
  assert.deepStrictEqual(run('[.[] | .a?]', '[{"a":1},2,{"a":3}]'), ['[1,3]']);
  assert.deepStrictEqual(run('.a?', '{"a":1}'), ['1']);
});

test('"//" falls back only when nothing truthy came out', () => {
  assert.deepStrictEqual(run('.a // "d"', '{}'), ['"d"']);
  assert.deepStrictEqual(run('.a // "d"', '{"a":false}'), ['"d"']);
  assert.deepStrictEqual(run('.a // "d"', '{"a":0}'), ['0']);
  assert.deepStrictEqual(run('[(1,null,2) // 9]', 'null'), ['[1,2]']);
  /* A left-hand side that fails outright counts as producing nothing. */
  assert.deepStrictEqual(run('.a.b // "d"', '{"a":3}'), ['"d"']);
});

test('and/or stop once the left-hand value settles the answer', () => {
  assert.deepStrictEqual(run('false and .a.b', '3'), ['false']);
  assert.deepStrictEqual(run('true or .a.b', '3'), ['true']);
  assert.deepStrictEqual(run('null | not', 'null'), ['true']);
});

test('if without an else passes the input through', () => {
  assert.deepStrictEqual(run('if . > 10 then "big" end', '3'), ['3']);
  assert.deepStrictEqual(run('if . > 10 then "big" end', '30'), ['"big"']);
  assert.deepStrictEqual(run('if .[] then "y" else "n" end', '[true,false]'),
    ['"y"', '"n"']);
});

test('indexing a missing key or a past-the-end index gives null', () => {
  assert.deepStrictEqual(run('.nope', '{"a":1}'), ['null']);
  assert.deepStrictEqual(run('.a.b.c', '{}'), ['null']);
  assert.deepStrictEqual(run('.[5]', '[1]'), ['null']);
  assert.deepStrictEqual(run('.[-1]', '[1,2]'), ['2']);
  assert.deepStrictEqual(run('.[1.7]', '[1,2,3]'), ['2']);
});

test('slices clamp to the ends and work on strings', () => {
  assert.deepStrictEqual(run('.[1:3]', '[1,2,3,4]'), ['[2,3]']);
  assert.deepStrictEqual(run('.[-2:]', '[1,2,3,4]'), ['[3,4]']);
  assert.deepStrictEqual(run('.[:100]', '[1,2]'), ['[1,2]']);
  assert.deepStrictEqual(run('.[3:1]', '[1,2,3,4]'), ['[]']);
  assert.deepStrictEqual(run('.[1:3]', '"hello"'), ['"el"']);
  assert.deepStrictEqual(run('.[2:4]', 'null'), ['null']);
});

test('length counts characters, not UTF-16 units', () => {
  assert.deepStrictEqual(run('length', '"h\\u00e9llo\\ud83d\\ude00"'), ['6']);
  assert.deepStrictEqual(run('length', '-5'), ['5']);
  assert.deepStrictEqual(run('length', 'null'), ['0']);
});

test('the document is never altered by a query that reads it', () => {
  /* Results share nodes with the document, so a builtin that sorted or
     reversed in place would corrupt the tree the page is showing. */
  const doc = parseJSON('{"a":[3,1,2]}');
  const before = stringify(doc);
  compile('.a | sort, reverse, unique').run(doc);
  assert.strictEqual(stringify(doc), before);
});

test('a query that only walks down reports its path', () => {
  assert.deepStrictEqual(compile('.').path, []);
  assert.deepStrictEqual(compile('.a.b').path, [{ key: 'a' }, { key: 'b' }]);
  assert.deepStrictEqual(compile('.a[2]').path, [{ key: 'a' }, { index: 2 }]);
  assert.deepStrictEqual(compile('.a[-1]').path, [{ key: 'a' }, { index: -1 }]);
  assert.deepStrictEqual(compile('.["x y"]').path, [{ key: 'x y' }]);
  assert.deepStrictEqual(compile('."x y".z').path, [{ key: 'x y' }, { key: 'z' }]);
  assert.deepStrictEqual(compile('.a.["b"]').path, [{ key: 'a' }, { key: 'b' }]);
});

test('anything more than walking down has no path', () => {
  for (const q of ['.a[]', '.a | .b', 'keys', '.a[1:2]', '.a?', '..', '.[.b]',
    '[.a]', '.a == 1', 'map(.a)', '.a[1.5]']) {
    assert.strictEqual(compile(q).path, null, `query ${q}`);
  }
});

test('a path query agrees with parsePath on the same text', () => {
  /* page.js hands a pasted path to whichever of the two is available, so the
     segments they produce have to match. */
  const { parsePath } = require('./core.js');
  for (const q of ['.a', '.a.b', '.a[0]', '.a[-1]', '.["x y"]', '.']) {
    assert.deepStrictEqual(compile(q).path, parsePath(q), `path ${q}`);
  }
});

test('syntax the subset leaves out is named, not mis-parsed', () => {
  const cases = {
    '.a = 1': 'assignment is not supported',
    '.a |= 1': 'assignment is not supported',
    '.a += 1': 'assignment is not supported',
    'map(.a = 1)': 'assignment is not supported',
    '. as $x | $x': 'variables are not supported',
    '$ENV': 'variables are not supported',
    'def f: 1; f': 'function definitions are not supported',
    'reduce .[] as $x (0; . + $x)': 'reduce is not supported',
    'foreach .[] as $x (0; . + $x)': 'foreach is not supported',
    'try .a catch "e"': 'try/catch is not supported, but a trailing "?" is',
    '@base64': 'format strings are not supported',
    '"a \\(.b) c"': 'string interpolation is not supported',
    'label $out | 1': 'labels are not supported'
  };
  for (const [q, want] of Object.entries(cases)) {
    assert.strictEqual(error(q), `parse: ${want}`, `query ${q}`);
  }
});

test('a filter that does not exist says so', () => {
  assert.strictEqual(error('splits("x")'), 'parse: splits is not a supported filter');
  assert.strictEqual(error('getpath(["a"])'), 'parse: getpath is not a supported filter');
  assert.strictEqual(error('sort_by(.a; .b)'), 'parse: sort_by takes 1 argument, not 2');
  assert.strictEqual(error('range(1;2;3;4)'), 'parse: range takes 1, 2 or 3 arguments, not 4');
});

test('a malformed query reports where it gave up', () => {
  for (const [q, pos] of [['', 0], ['.a |', 4], ['(.a', 3], ['{a', 2], ['..a', 2],
    ['.a[', 3], ['"unclosed', 0], ['1 +', 3]]) {
    try {
      compile(q);
      assert.fail(`${q} compiled`);
    } catch (e) {
      assert.strictEqual(e.jq, 'parse', `query ${q}`);
      assert.strictEqual(e.pos, pos, `position for ${q}`);
      assert.ok(e.message.length > 0, `message for ${q}`);
    }
  }
});

test('a type error names both the operation and the type', () => {
  assert.strictEqual(error('.a', '3'), 'run: cannot index number with "a"');
  assert.strictEqual(error('.[0]', '{"a":1}'), 'run: cannot index object with a number');
  assert.strictEqual(error('.[]', '3'), 'run: cannot iterate over number');
  assert.strictEqual(error('. + 1', '"s"'), 'run: string and number cannot be added');
  assert.strictEqual(error('. / 0', '1'), 'run: cannot divide by zero');
  assert.strictEqual(error('keys', '3'), 'run: number has no keys');
  assert.strictEqual(error('length', 'true'), 'run: boolean has no length');
  assert.strictEqual(error('sort', '3'), 'run: sort needs array, not number');
  assert.strictEqual(error('tonumber', '"x"'), 'run: cannot parse "x" as a number');
});

test('a runaway query stops instead of hanging', () => {
  /* recurse(.+1) has no end, so the step limit is the only thing that stops
     it. The message is what the search box shows. */
  const e = error('[recurse(. + 1)]', '0');
  assert.strictEqual(e, 'run: query produced too much work');
});

test('a query can be run more than once', () => {
  /* The step counter is shared, so it has to be reset per run rather than
     accumulating until a later run trips it. */
  const q = compile('[range(100)] | length');
  const doc = parseJSON('null');
  for (let i = 0; i < 200; i++) {
    assert.deepStrictEqual(q.run(doc).map((n) => stringify(n)), ['100']);
  }
});

test('regex flags outside the supported set are refused', () => {
  assert.deepStrictEqual(run('test("A"; "i")', '"a"'), ['true']);
  assert.strictEqual(error('test("a"; "x")', '"a"'), 'run: unsupported regex flag "x"');
  assert.ok(error('test("(")', '"a"').startsWith('run: bad regular expression'));
});

test('comments and whitespace are skipped', () => {
  assert.deepStrictEqual(run('.a # the key\n | . + 1', '{"a":1}'), ['2']);
  assert.deepStrictEqual(run('  .a  ', '{"a":1}'), ['1']);
});
