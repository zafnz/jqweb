/* Tests for the pure half of the page script. Run with:  node --test web/
   These cover the parser, the HTML renderer and the path reader; the DOM
   wiring in page.js is not exercised here. */

import test from 'node:test';
import assert from 'node:assert';
import { parseJSON, renderTree, parsePath, quote, esc } from './src/core.js';

/* The leaf text of a node, with the markup stripped and the escaping undone,
   so tests can talk about values rather than spans. Escaping itself is checked
   separately, against the raw HTML. */
function leaf(node) {
  assert.strictEqual(node.t, 'l', 'expected a leaf node');
  return node.h
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:lt|gt|#34|#39);/g, (e) => ({ '&lt;': '<', '&gt;': '>', '&#34;': '"', '&#39;': "'" })[e])
    .replace(/&amp;/g, '&');
}

test('parseJSON keeps object keys in document order', () => {
  const node = parseJSON('{"b":1,"a":2,"B":3}');
  assert.strictEqual(node.t, 'o');
  assert.deepStrictEqual(node.k, ['b', 'a', 'B']);
  assert.strictEqual(node.v.length, 3);
});

test('parseJSON keeps duplicate keys', () => {
  // JSON.parse would collapse these; the tree shows the document as written.
  const node = parseJSON('{"a":1,"a":2}');
  assert.deepStrictEqual(node.k, ['a', 'a']);
  assert.deepStrictEqual(node.v.map(leaf), ['1', '2']);
});

test('parseJSON keeps numbers exactly as written', () => {
  const written = ['1.0', '1e5', '1E+5', '-0', '0.1000', '123456789012345678901234567890'];
  const node = parseJSON('[' + written.join(',') + ']');
  assert.deepStrictEqual(node.v.map(leaf), written);
});

test('parseJSON handles the literals', () => {
  const node = parseJSON('[true,false,null]');
  assert.deepStrictEqual(node.v.map(leaf), ['true', 'false', 'null']);
  assert.match(node.v[0].h, /class="v bool"/);
  assert.match(node.v[2].h, /class="v null"/);
});

test('parseJSON handles empty containers', () => {
  assert.deepStrictEqual(parseJSON('{}'), { t: 'o', k: [], v: [] });
  assert.deepStrictEqual(parseJSON('[]'), { t: 'a', v: [] });
  assert.deepStrictEqual(parseJSON('[{},[]]').v, [{ t: 'o', k: [], v: [] }, { t: 'a', v: [] }]);
});

test('parseJSON decodes string escapes', () => {
  assert.strictEqual(leaf(parseJSON('"caf\\u00e9"')), '"café"');
  assert.strictEqual(leaf(parseJSON('"a\\tb"')), '"a\\tb"'); // re-quoted, not raw
  assert.strictEqual(leaf(parseJSON('"quote:\\""')), '"quote:\\""');
  assert.strictEqual(leaf(parseJSON('"back\\\\slash"')), '"back\\\\slash"');
});

test('parseJSON handles a key or value containing a delimiter', () => {
  const node = parseJSON('{"a,b":"]},[{"}');
  assert.deepStrictEqual(node.k, ['a,b']);
  assert.strictEqual(leaf(node.v[0]), '"]},[{"');
});

test('parseJSON tolerates whitespace between tokens', () => {
  const node = parseJSON('{ "a" : [ 1 , 2 ] , "b" : { } }');
  assert.deepStrictEqual(node.k, ['a', 'b']);
  assert.strictEqual(node.v[0].v.length, 2);
});

test('parseJSON nests containers', () => {
  const node = parseJSON('{"a":[1,{"b":[2]}]}');
  assert.strictEqual(node.v[0].t, 'a');
  assert.strictEqual(node.v[0].v[1].t, 'o');
  assert.strictEqual(leaf(node.v[0].v[1].v[0].v[0]), '2');
});

test('markup in values is escaped', () => {
  const node = parseJSON('["<img src=x>","a & b","q\\"q"]');
  for (const child of node.v) {
    assert.ok(!/<(img|script)/.test(child.h), 'value markup leaked into the tree: ' + child.h);
  }
  assert.match(node.v[0].h, /&lt;img src=x&gt;/);
  assert.match(node.v[1].h, /a &amp; b/);
});

test('esc escapes every HTML-significant character', () => {
  assert.strictEqual(esc(`<>&"'`), '&lt;&gt;&amp;&#34;&#39;');
  assert.strictEqual(esc('plain'), 'plain');
});

test('quote escapes the line separators JSON.stringify leaves raw', () => {
  // U+2028 and U+2029 are legal in JSON strings but end a line in JavaScript.
  assert.strictEqual(quote('a\u2028b'), '"a\\u2028b"');
  assert.strictEqual(quote('a\u2029b'), '"a\\u2029b"');
  assert.strictEqual(quote('plain'), '"plain"');
});

test('renderTree escapes markup in keys', () => {
  const html = renderTree(parseJSON('{"<script>":1}'));
  assert.ok(!html.includes('<script>'), 'key markup leaked into the tree');
  assert.match(html, /&lt;script&gt;/);
});

test('renderTree emits one node per value', () => {
  const html = renderTree(parseJSON('{"a":[1,2],"b":null}'));
  const nodes = html.match(/class="node/g) || [];
  assert.strictEqual(nodes.length, 5); // root, a, 1, 2, b
});

test('renderTree tags children with their key or index', () => {
  const html = renderTree(parseJSON('{"a":[7]}'));
  assert.match(html, /data-key="a"/);
  assert.match(html, /data-index="0"/);
});

test('renderTree marks containers as branches and scalars as leaves', () => {
  assert.match(renderTree(parseJSON('{"a":1}')), /class="node branch"/);
  assert.match(renderTree(parseJSON('1')), /class="node leaf"/);
  // An empty container has nothing to expand, so it renders as a leaf.
  assert.match(renderTree(parseJSON('{}')), /class="node leaf"/);
});

test('renderTree counts a container\'s children in its fold summary', () => {
  assert.match(renderTree(parseJSON('{"a":[1,2,3]}')), /3 items/);
  assert.match(renderTree(parseJSON('{"a":[1]}')), /1 item/);
  assert.match(renderTree(parseJSON('{"a":1}')), /1 key/);
  assert.match(renderTree(parseJSON('{"a":1,"b":2}')), /2 keys/);
});

test('parsePath reads dotted paths', () => {
  assert.deepStrictEqual(parsePath('.a'), [{ key: 'a' }]);
  assert.deepStrictEqual(parsePath('.a.b'), [{ key: 'a' }, { key: 'b' }]);
  assert.deepStrictEqual(parsePath('a.b'), [{ key: 'a' }, { key: 'b' }]); // leading dot optional
  assert.deepStrictEqual(parsePath('  .a  '), [{ key: 'a' }]);
  assert.deepStrictEqual(parsePath('.'), []); // the whole document
});

test('parsePath reads indices', () => {
  assert.deepStrictEqual(parsePath('.a[3]'), [{ key: 'a' }, { index: 3 }]);
  assert.deepStrictEqual(parsePath('.a[-1]'), [{ key: 'a' }, { index: -1 }]);
  assert.deepStrictEqual(parsePath('[0]'), [{ index: 0 }]);
  assert.deepStrictEqual(parsePath('.a[0][1]'), [{ key: 'a' }, { index: 0 }, { index: 1 }]);
  assert.deepStrictEqual(parsePath('.a[0].b'), [{ key: 'a' }, { index: 0 }, { key: 'b' }]);
});

test('parsePath reads bracketed keys', () => {
  assert.deepStrictEqual(parsePath('["x y"]'), [{ key: 'x y' }]);
  assert.deepStrictEqual(parsePath(`['x y']`), [{ key: 'x y' }]);
  assert.deepStrictEqual(parsePath('.a["b.c"]'), [{ key: 'a' }, { key: 'b.c' }]);
  assert.deepStrictEqual(parsePath('.a.["b"]'), [{ key: 'a' }, { key: 'b' }]); // jq's .a.["b"]
  assert.deepStrictEqual(parsePath('["a\\"b"]'), [{ key: 'a"b' }]);
  assert.deepStrictEqual(parsePath(`['a\\'b']`), [{ key: "a'b" }]);
});

test('parsePath rejects text that is not a path', () => {
  for (const s of ['', 'a b', '.a[', '.a[x]', '.a[]', '.a..b', '.a.', '["unclosed]', '.a[1', 'a]']) {
    assert.strictEqual(parsePath(s), null, `parsePath(${JSON.stringify(s)}) should be null`);
  }
});

test('a copied path round-trips through parsePath', () => {
  // pathOf() in page.js emits .key for identifiers and ["key"] otherwise;
  // both forms have to read back.
  const cases = [
    ['.items[302].item', [{ key: 'items' }, { index: 302 }, { key: 'item' }]],
    ['["a b"][0].c', [{ key: 'a b' }, { index: 0 }, { key: 'c' }]],
    ['._private.$x', [{ key: '_private' }, { key: '$x' }]],
  ];
  for (const [path, want] of cases) {
    assert.deepStrictEqual(parsePath(path), want, path);
  }
});
