import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJSON } from '../../src/model/parse.ts';
import { stringify } from '../../src/model/node.ts';
import { compile, isJqError } from '../../src/query/engine/index.ts';
import { Evaluation } from '../../src/query/engine/evaluate.ts';
import { parse } from '../../src/query/engine/parser.ts';
import type { Ast } from '../../src/query/engine/parser.ts';
import { builtins } from '../../src/query/engine/builtins.ts';
import { leafOf } from '../../src/model/node.ts';

interface Case { q: string; out: string[]; error?: 'parse' | 'run'; message?: string }
const corpus: { input: unknown; cases: Case[] } = JSON.parse(
  readFileSync(new URL('../testdata/jq-semantics.json', import.meta.url), 'utf8'));

for (const c of corpus.cases) {
  test(`jq semantics: ${c.q}`, () => {
    const out: string[] = [];
    let error: string | undefined;
    let message: string | undefined;
    try {
      const ast = parse(c.q);
      for (const n of new Evaluation().ev(ast, parseJSON(JSON.stringify(corpus.input)))) out.push(stringify(n));
    } catch (e) {
      if (!isJqError(e)) throw e;
      error = e.jq;
      message = e.message;
    }
    assert.equal(error, c.error);
    if (c.message !== undefined) assert.equal(message, c.message);
    // Compare JSON values while retaining object key order. jq builds can
    // print the same number as 100 or 1E+2; text preservation has its own tests.
    const normalized = (values: string[]) => values.map(s => JSON.stringify(JSON.parse(s)));
    assert.deepEqual(normalized(out), normalized(c.out));
    const run = () => compile(c.q).run(parseJSON(JSON.stringify(corpus.input)));
    if (c.error) assert.throws(run, e => isJqError(e) && e.jq === c.error);
    else assert.deepEqual(normalized(run().map(n => stringify(n))), normalized(c.out));
  });
}

test('early termination closes the upstream iterator without reading another value', () => {
  let closed = false;
  let readPastFirst = false;
  const producer: Ast = { op: 'call', key: 'test/0', args: [], p: 0, fn: function* () {
    try {
      yield leafOf(1);
      readPastFirst = true;
      yield leafOf(2);
    } finally { closed = true; }
  } };
  const ast: Ast = { op: 'call', key: 'first/1', fn: builtins['first/1'], args: [producer], p: 0 };
  assert.deepEqual(Array.from(new Evaluation().ev(ast, leafOf(null))).map(n => stringify(n)), ['1']);
  assert.equal(closed, true);
  assert.equal(readPastFirst, false);
});

test('work exhaustion cannot be swallowed by optional or alternative', () => {
  for (const q of ['0 | (recurse(.+1) | empty)?', '0 | until(false;.+1)?', '(range(10000000) | empty)?',
    '0 | (recurse(.+1) | empty) // 9', '"x" * (1000|exp)']) {
    assert.throws(() => compile(q).run(leafOf(null)),
      e => isJqError(e) && e.fatal === true && /too much work/.test(e.message), q);
  }
  assert.deepEqual(compile('first(range(10000000))').run(leafOf(null)).map(n => stringify(n)), ['0']);
});

test('suspended evaluations keep independent work budgets', () => {
  const a = new Evaluation();
  const b = new Evaluation();
  const ast = parse('range(10000000)');
  const first = a.ev(ast, leafOf(null))[Symbol.iterator]();
  const second = b.ev(ast, leafOf(null))[Symbol.iterator]();
  assert.equal(stringify(first.next().value!), '0');
  assert.throws(() => { for (let i = 0; i < 5000000; i++) a.tick(); }, /too much work/);
  assert.equal(stringify(second.next().value!), '0');
  first.return?.();
  second.return?.();
});

test('Unicode empty regex matches advance to the next code point', () => {
  // JavaScript's u flag is an intentional backend difference; jq rejects it.
  const out = compile('"😀" | match(""; "gu") | .offset').run(leafOf(null));
  assert.deepEqual(out.map(n => stringify(n)), ['0', '1']);
});
