/* Tests for the jq subset. Run with:  npm --prefix web test

   The bulk of the coverage is a corpus of queries whose expected output came
   from jq itself (see ../testdata/regenerate.js); the tests written out here
   cover what a corpus cannot -- the queries that must fail, and the stream
   behaviour that is easy to get subtly wrong. */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { stringify } from '../../src/model/node.ts';
import { parseJSON } from '../../src/model/parse.ts';
import { parsePath } from '../../src/model/path.ts';
import { builtins } from '../../src/query/engine/builtins.ts';
import { stream } from '../../src/query/engine/evaluate.ts';
import { compile, isJqError } from '../../src/query/engine/index.ts';
import { parse } from '../../src/query/engine/parser.ts';

/* The corpus file: the jq that answered, a fixture document, and each query
   with the output jq gave for it, one JSON text per output, and the kind of
   error it then raised if it did. */
interface Corpus {
  jq: string;
  input: unknown;
  cases: { q: string; out: string[]; error?: 'parse' | 'run' }[];
}

const corpus: Corpus = JSON.parse(fs.readFileSync(new URL('../testdata/jq-corpus.json', import.meta.url), 'utf8'));

/* Runs a query over a JSON document and returns its outputs as JSON text, so
   that a test can talk about values rather than nodes. */
function run(query: string, doc: string): string[] {
  return compile(query).run(parseJSON(doc)).map((n) => stringify(n));
}

/* The error a query raises, as "<kind>: <message>". */
function error(query: string, doc?: string): string {
  try {
    const out = run(query, doc === undefined ? 'null' : doc);
    assert.fail(`${query} did not fail; it returned ${JSON.stringify(out)}`);
  } catch (e) {
    if (!isJqError(e)) throw e;
    return `${e.jq}: ${e.message}`;
  }
}

test('every corpus query agrees with jq', () => {
  /* The outputs are taken as they come rather than from run(), which drops
     them on an error, so a query that fails is held to producing what jq
     produced first and then failing the same way. */
  const doc = parseJSON(JSON.stringify(corpus.input));
  for (const c of corpus.cases) {
    const out: string[] = [];
    let failed: string | undefined;
    try {
      stream(parse(c.q), doc, (n) => { out.push(stringify(n)); });
    } catch (e) {
      if (!isJqError(e)) throw e;
      failed = e.jq;
    }
    assert.deepStrictEqual(out, c.out, `output of ${c.q}`);
    assert.strictEqual(failed, c.error, `error from ${c.q}`);
  }
});

test('the corpus exercises every builtin', () => {
  /* A builtin no corpus case runs is one whose answer has never been compared
     with jq's. The names are read out of the builtin table, format strings
     included, so adding a builtin without a case for it fails here. */
  const names = new Set(Object.keys(builtins).map((key) => key.slice(0, key.lastIndexOf('/'))));
  assert.ok(names.size > 80, `only found ${names.size} builtins to check`);

  const queries = corpus.cases.map((c) => c.q).join('\n');
  /* A word boundary cannot sit before the "@" of a format name, so those are
     looked for as plain text. */
  const missing = [...names].filter((n) => n.startsWith('@')
    ? !queries.includes(n)
    : !new RegExp(`\\b${n}\\b`).test(queries));
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

test('a NaN or an infinity stays a number and prints as jq prints it', () => {
  assert.deepStrictEqual(run('(-1 | sqrt) | type, not, tostring', 'null'), ['"number"', 'false', '"null"']);
  assert.deepStrictEqual(run('(1000 | exp) / 2, ((1000 | exp) * 0)', 'null'),
    ['1.7976931348623157e+308', 'null']);
  assert.deepStrictEqual(run('[(-1 | sqrt) < (-1 | sqrt), (-1 | sqrt) == (-1 | sqrt)]', 'null'),
    ['[true,false]']);
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
  /* A left-hand side that fails is an error, as in jq 1.7; "?" is what
     turns the failure into nothing. */
  assert.strictEqual(error('.a.b // "d"', '{"a":3}'), 'run: cannot index number with "b"');
  assert.deepStrictEqual(run('.a.b? // "d"', '{"a":3}'), ['"d"']);
});

test('a stream stops once its consumer has what it needs', () => {
  /* The rest of the stream is never run, so what would have failed or
     never ended is neither reached nor finished. */
  assert.deepStrictEqual(run('first(1, error("boom"))', 'null'), ['1']);
  assert.deepStrictEqual(run('first(range(1000000000))', 'null'), ['0']);
  assert.deepStrictEqual(run('[limit(3; 0 | recurse(. + 1))]', 'null'), ['[0,1,2]']);
  assert.deepStrictEqual(run('isempty(1, error("boom"))', 'null'), ['false']);
  assert.deepStrictEqual(run('any(true, error("boom"); .)', 'null'), ['true']);
  assert.deepStrictEqual(run('map_values(., error("boom"))', '{"a":1}'), ['{"a":1}']);
  /* The outputs "?" had already passed on stay. */
  assert.deepStrictEqual(run('[(1, error("boom"), 2)?]', 'null'), ['[1]']);
});

test('"?" catches the expression it wraps and not what comes after', () => {
  assert.strictEqual(error('(1,2)? | error("d")'), 'run: d');
  assert.deepStrictEqual(run('[((1,2)? | error("d"))?]', 'null'), ['[]']);
  assert.deepStrictEqual(run('[(.[]? | .a?)]', '[3,{"a":1}]'), ['[1]']);
});

test('a long loop does not exhaust the stack', () => {
  assert.deepStrictEqual(run('until(. >= 100000; . + 1)', '0'), ['100000']);
  assert.deepStrictEqual(run('[while(. < 100000; . + 1)] | length', '0'), ['100000']);
  assert.deepStrictEqual(run('[limit(100000; recurse(. + 1))] | length', '0'), ['100000']);
  /* A branching step is recursion on the stack for the first levels and
     collected a step at a time past them, so its depth is not bounded. */
  assert.deepStrictEqual(run('[limit(1; until(. >= 10000; (. + 1, . + 2)))]', '0'), ['[10000]']);
  assert.deepStrictEqual(run('[limit(3; recurse(if . < 10000 then (. + 1, . + 2) else empty end))] | length', '0'), ['3']);
});

test('a loop follows a branch before it asks for the next one', () => {
  assert.deepStrictEqual(run('first(while(true; error("late")))', '0'), ['0']);
  assert.deepStrictEqual(run('first(until(. >= 1; (. + 1, error("late"))))', '0'), ['1']);
  assert.deepStrictEqual(run('[limit(2; recurse((. + 1, error("late"))))]', '0'), ['[0,1]']);
  assert.deepStrictEqual(run('[limit(3; while(true; range(1; 1000000000)))]', '0'), ['[0,1,1]']);
});

test('running out of work is not an error "?" can drop', () => {
  for (const q of ['[recurse(. + 1)]?', '([recurse(. + 1)])? // 1', '[(recurse(. + 1) | empty)?]']) {
    assert.strictEqual(error(q, '0'), 'run: query produced too much work', q);
  }
});

test('a global match stops when its consumer does', () => {
  /* One match object for the first result, not one per character. */
  let count = 0;
  const q = compile('first(match("."; "g")) | .string');
  const doc = parseJSON(JSON.stringify('x'.repeat(200000)));
  const t0 = performance.now();
  count = q.run(doc).length;
  assert.strictEqual(count, 1);
  assert.ok(performance.now() - t0 < 200, 'first match took too long');
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
  /* The page hands a pasted path to whichever of the two is available, so the
     segments they produce have to match. */
  for (const q of ['.a', '.a.b', '.a[0]', '.a[-1]', '.["x y"]', '.']) {
    assert.deepStrictEqual(compile(q).path, parsePath(q), `path ${q}`);
  }
});

test('syntax the subset leaves out is named, not mis-parsed', () => {
  const cases: Record<string, string> = {
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
    '@base64 "x"': '@base64 applied to a string needs interpolation, which is not supported',
    '"a \\(.b) c"': 'string interpolation is not supported',
    'label $out | 1': 'labels are not supported'
  };
  for (const [q, want] of Object.entries(cases)) {
    assert.strictEqual(error(q), `parse: ${want}`, `query ${q}`);
  }
});

test('a filter that does not exist says so', () => {
  for (const name of ['tostream', 'env', 'inputs', 'leaf_paths',
    'toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
    assert.strictEqual(error(name), `parse: ${name} is not a supported filter`);
  }
  assert.strictEqual(error('sort_by(.a; .b)'), 'parse: sort_by takes 1 argument, not 2');
  assert.strictEqual(error('range(1;2;3;4)'), 'parse: range takes 1, 2 or 3 arguments, not 4');
  assert.strictEqual(error('@nope'), 'parse: @nope is not a supported format');
});

test('the filters that change a document are not here', () => {
  /* The page shows a document; nothing in it edits one. Leaving these out
     keeps path expressions out of the evaluator, which is what del and the
     assignment operators would need. */
  for (const q of ['del(.a)', 'setpath(["a"]; 1)', 'delpaths([["a"]])']) {
    assert.ok(error(q).startsWith('parse:'), q);
  }
});

test('a malformed query reports where it gave up', () => {
  const cases: [string, number][] = [['', 0], ['.a |', 4], ['(.a', 3], ['{a', 2], ['..a', 2],
    ['.a[', 3], ['"unclosed', 0], ['1 +', 3]];
  for (const [q, pos] of cases) {
    try {
      compile(q);
      assert.fail(`${q} compiled`);
    } catch (e) {
      if (!isJqError(e)) throw e;
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

test('index counts characters where jq counts bytes', () => {
  /* Not in the corpus, because this is the one place the engine knowingly
     disagrees with jq: jq reports UTF-8 byte offsets from indices, which do
     not line up with its own slices or its own length. "h\u00e9llo\ud83d\ude00x"
     has its x at character 6 and byte 10; jq says 10 and then slices from
     there to nothing. */
  const doc = '"h\\u00e9llo\\ud83d\\ude00x"';
  assert.deepStrictEqual(run('index("x")', doc), ['6']);
  assert.deepStrictEqual(run('length', doc), ['7']);
  assert.deepStrictEqual(run('.[index("x"):]', doc), ['"x"']);
  /* Everything ASCII, which is nearly every use, agrees with jq exactly. */
  assert.deepStrictEqual(run('index("X")', '"aXbXc"'), ['1']);
  assert.deepStrictEqual(run('.[index("X"):]', '"aXbXc"'), ['"XbXc"']);
});

test('index finds a subsequence in an array, not one element', () => {
  assert.deepStrictEqual(run('index([[2]])', '[1,[2],3]'), ['1']);
  assert.deepStrictEqual(run('indices([2])', '[1,[2],3]'), ['[]']);
  assert.deepStrictEqual(run('index(null)', '[null,1]'), ['0']);
  assert.deepStrictEqual(run('index("a")', 'null'), ['null']);
  assert.strictEqual(error('index(1)', '"abc"'), 'run: cannot look for number in a string');
  assert.strictEqual(error('index("a")', '{"a":1}'), 'run: cannot look inside object');
});

test('an index of 0 is still a truthy select', () => {
  /* select keeps anything but false and null, so a match at the start counts.
     This is the reason index reads well inside select. */
  assert.deepStrictEqual(run('[.[] | select(index("a"))]', '["abc","bca","xyz"]'),
    ['["abc","bca"]']);
});

test('modifiers combine with alternatives, captures, comments and empty matches', () => {
  /* n takes the alternative that consumes a character where there is one,
     and skips the position where there is none. */
  assert.deepStrictEqual(run('[match("a*|b"; "gn") | .string]', '"b"'), ['["b"]']);
  assert.deepStrictEqual(run('[match("a*|b"; "gn") | .string]', '"ab"'), ['["a","b"]']);
  assert.deepStrictEqual(run('[match("X*"; "gn") | .offset]', '"aXb"'), ['[1]']);
  /* A bracket in an x-mode comment is not a group. */
  assert.deepStrictEqual(run('capture("#(ignored)\\n(?<x>a)"; "x")', '"a"'), ['{"x":"a"}']);
  assert.deepStrictEqual(run('[match("[a-c] # letters\\n"; "gix") | .string]', '"aBcd"'), ['["a","B","c"]']);
  assert.deepStrictEqual(run('[match("(a)|b"; "gn") | .captures | length]', '"ba"'), ['[1,1]']);
});

test('regex modifiers are jq\'s letters, and the one JavaScript cannot do is refused', () => {
  assert.deepStrictEqual(run('test("A"; "i")', '"a"'), ['true']);
  assert.strictEqual(error('test("a"; "q")', '"a"'), 'run: q is not a valid modifier string');
  assert.strictEqual(error('test("a"; "l")', '"a"'), 'run: the l modifier is not supported');
  assert.ok(error('test("(")', '"a"').startsWith('run: bad regular expression'));
});

test('comments and whitespace are skipped', () => {
  assert.deepStrictEqual(run('.a # the key\n | . + 1', '{"a":1}'), ['2']);
  assert.deepStrictEqual(run('  .a  ', '{"a":1}'), ['1']);
});
