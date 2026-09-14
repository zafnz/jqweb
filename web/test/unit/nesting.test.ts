import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leafOf, stringify } from '../../src/model/node.ts';
import type { Node } from '../../src/model/node.ts';
import { MAX_DEPTH, NestingError } from '../../src/model/nesting.ts';
import { parseJSON } from '../../src/model/parse.ts';
import { renderTree } from '../../src/model/render.ts';
import { compile, isJqError } from '../../src/query/engine/index.ts';

function nested(depth: number, shape: string, value = '0'): string {
  for (let i = 0; i < depth; i++) {
    value = shape === 'object' || (shape === 'mixed' && i % 2)
      ? '{"a":' + value + '}' : '[' + value + ']';
  }
  return value;
}

test('Go and the page enforce the same nesting limit', () => {
  const go = readFileSync(new URL('../../../internal/check/check.go', import.meta.url), 'utf8');
  assert.equal(Number(/const maxDepth = (\d+)/.exec(go)?.[1]), MAX_DEPTH);
});

for (const shape of ['array', 'object', 'mixed']) {
  test(`parsing ${shape} nesting counts containers, including empty ones`, () => {
    for (const value of ['1.00e+2', '{}', '[]', '"[{\\\""']) {
      const depth = value === '{}' || value === '[]' ? MAX_DEPTH - 1 : MAX_DEPTH;
      const src = nested(depth, shape, value);
      assert.equal(stringify(parseJSON(src)), src);
      assert.throws(() => parseJSON(nested(depth + 1, shape, value)), NestingError);
    }
    for (const depth of [4000, 9000, 10001]) {
      assert.throws(() => parseJSON(nested(depth, shape)), NestingError);
    }
  });

  test(`queries traverse ${shape} values at the limit`, () => {
    const src = nested(MAX_DEPTH, shape);
    const node = parseJSON(src);
    for (const q of ['walk(.)', 'fromjson']) {
      assert.equal(stringify(compile(q).run(q === 'fromjson' ? leafOf(src) : node)[0]), src);
    }
    assert.equal(compile('tojson').run(node)[0].t, 'l');
    assert.equal(stringify(compile('tojson | fromjson').run(node)[0]), src);
    assert.equal(compile('paths').run(node).length, MAX_DEPTH);
    assert.equal(compile('..').run(node).length, MAX_DEPTH + 1);
    assert.equal(stringify(compile('. == .').run(node)[0]), 'true');
    assert.equal(stringify(compile('contains(.)').run(node)[0]), 'true');
    if (shape === 'array') assert.equal(stringify(compile('flatten').run(node)[0]), '[0]');
    if (shape === 'object') assert.equal(stringify(compile('. * .').run(node)[0]), src);
  });
}

test('query construction rejects deep intermediates as runtime errors', () => {
  const node = parseJSON(nested(MAX_DEPTH, 'array'));
  for (const q of ['[.]', '{a: .}', '[.] | flatten', 'map([.])', 'walk([.])']) {
    assert.throws(() => compile(q).run(node), (e: unknown) =>
      isJqError(e) && e.jq === 'run' && e.message === 'JSON nesting exceeds the supported limit of 128', q);
  }
  // A reused subtree's cached depth must still be checked under its new parent.
  assert.equal(stringify(compile('. + .').run(node)[0]), '[' + nested(MAX_DEPTH - 1, 'array') + ',' + nested(MAX_DEPTH - 1, 'array') + ']');
  assert.throws(() => compile('[.]').run(node), /JSON nesting/);
  for (const q of ['until(false; [.])', 'until(false; {a: .})']) {
    assert.throws(() => compile(q).run(leafOf(null)), /JSON nesting/);
  }
});

test('fromjson reports excessive nesting as a runtime error, including under optional', () => {
  const input = leafOf(nested(9000, 'array'));
  assert.throws(() => compile('fromjson').run(input), (e: unknown) => isJqError(e) && e.jq === 'run' && /JSON nesting/.test(e.message));
  assert.deepEqual(compile('fromjson?').run(input), []);
});

test('siblings do not accumulate nesting depth', () => {
  const child = nested(MAX_DEPTH - 1, 'mixed');
  const src = '[' + child + ',' + child + ']';
  assert.equal(stringify(parseJSON(src)), src);
  assert.equal(stringify(compile('. + []').run(parseJSON(src))[0]), src);
});

test('rendering rejects an over-deep tree before emitting invalid HTML', () => {
  let node: Node = leafOf(0);
  for (let i = 0; i < 4000; i++) node = { t: 'a', v: [node] };
  assert.throws(() => renderTree(node), NestingError);
});
