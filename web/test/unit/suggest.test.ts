/* Tests for query/suggest.ts: the queries offered when you click the filter
   button on a line, and the completions of a key or a function name still
   being typed. Run with:  npm --prefix web test

   The property that matters most is near the bottom: every query offered for
   every line of a document has to compile and run against that document. A
   suggestion that errors is worse than no suggestion, and the shapes that
   break one -- a pivot whose members are not all objects, a value sitting in
   an array, a key that needs quoting -- are easy to miss by hand. */

import test from 'node:test';
import assert from 'node:assert';
import type { Node } from '../../src/model/node.ts';
import { parseJSON } from '../../src/model/parse.ts';
import type { Segment } from '../../src/model/path.ts';
import { DOCS } from '../../src/query/docs.ts';
import { builtins } from '../../src/query/engine/builtins.ts';
import { compile, isJqError } from '../../src/query/engine/index.ts';
import { completions, countOf, functionCompletions, splitCall, splitPartial, suggest } from '../../src/query/suggest.ts';
import type { Candidate } from '../../src/query/suggest.ts';

/* A document with the shapes that have caught the generator out: an object
   used as a map, records reached through a second map level, an array of
   scalars, an array of records, keys needing quotes, and a root holding both
   scalars and containers. */
const DOC = parseJSON(JSON.stringify({
  version: '2.0',
  paths: {
    '/page/': { get: { tags: ['Page content'], summary: 'a' } },
    '/feed/': { get: { tags: ['Feed'], summary: 'b' }, post: { tags: ['Page content'] } },
    '/misc/': { get: { tags: ['Page content', 'Feed'] } }
  },
  rows: [
    { id: 1, name: 'alpha', flags: ['x'] },
    { id: 2, name: 'beta', flags: [] }
  ],
  big: { blob: 'y'.repeat(200) }
}));

/* Where "Page content" sits in .paths["/page/"].get.tags. */
const TAG: Segment[] = [{ key: 'paths' }, { key: '/page/' }, { key: 'get' }, { key: 'tags' }, { index: 0 }];

const queries = (segs: Segment[]) => suggest(DOC, segs).map((c) => c.q);

/* What one candidate returns, counted the way its shape says to count it. */
function yields(c: Candidate, doc?: Node): number {
  return countOf(c.shape, compile(c.q).run(doc || DOC));
}

test('a value in an array is asked about with index, not equality', () => {
  /* "which records list this tag" rather than "whose tag list is exactly
     this", which is the question people mean almost every time. */
  const qs = queries(TAG);
  assert.ok(qs.includes('.paths | with_entries(select(.value.get.tags? | index("Page content")?))'),
    qs.join('\n'));
});

test('pivoting on the array the value sits in compares the value itself', () => {
  /* There the elements are handed straight to the test, so containment would
     be asking whether "Page content" contains "Page content". */
  const qs = queries(TAG);
  assert.ok(qs.includes('.paths["/page/"].get.tags[] | select(. == "Page content")'), qs.join('\n'));
});

test('the line itself is always offered', () => {
  assert.ok(queries(TAG).includes('.paths["/page/"].get.tags[0]'));
  assert.ok(queries([{ key: 'version' }]).includes('.version'));
  assert.ok(queries([{ key: 'rows' }, { index: 0 }, { key: 'id' }]).includes('.rows[0].id'));
});

test('the reading of the line itself is marked', () => {
  /* The caller puts it first when nothing else narrows the document down, so
     it has to be findable without matching on the label. */
  const lines: Segment[][] = [TAG, [{ key: 'version' }], [{ key: 'rows' }, { index: 0 }]];
  for (const segs of lines) {
    const plain = suggest(DOC, segs).filter((c) => c.plain);
    assert.strictEqual(plain.length, 1, `for ${JSON.stringify(segs)}`);
    assert.strictEqual(plain[0].q, suggest(DOC, segs).find((c) => c.why === 'this line')?.q);
  }
});

test('a key that needs quoting is quoted', () => {
  for (const q of queries(TAG)) {
    assert.ok(!/\.\/page\//.test(q), `unquoted key in ${q}`);
  }
});

test('the key a value sat under can be left open', () => {
  /* A tag on .get is usually wanted across .post too, and in this document
     that is the difference between two paths and three. */
  const qs = queries(TAG);
  const anyKey = '.paths[] | .[]? | select(.tags? | index("Page content")?)';
  assert.ok(qs.includes(anyKey), qs.join('\n'));
  assert.strictEqual(compile(anyKey).run(DOC).length, 3);
  assert.strictEqual(compile('.paths[] | select(.get.tags? | index("Page content")?)').run(DOC).length, 2);
});

test('a value too big to read is asked about by presence instead', () => {
  const qs = queries([{ key: 'big' }, { key: 'blob' }]);
  for (const q of qs) {
    assert.ok(q.length < 100, `unreadable suggestion: ${q}`);
    assert.ok(!q.includes('yyy'), `pasted the whole value into ${q}`);
  }
  assert.ok(qs.includes('with_entries(select(.value.blob? != null))'), qs.join('\n'));
});

test('a branch is asked about by value while it is small enough', () => {
  const qs = queries([{ key: 'paths' }, { key: '/page/' }, { key: 'get' }, { key: 'tags' }]);
  assert.ok(qs.includes('.paths | with_entries(select(.value.get.tags? == ["Page content"]))'),
    qs.join('\n'));
});

test('a named pivot outranks the document as a whole', () => {
  /* Both find the same records; ".paths | ..." says where to look. */
  const all = suggest(DOC, TAG);
  const named = all.find((c) => c.q.startsWith('.paths | with_entries'));
  const root = all.find((c) => c.q.startsWith('with_entries'));
  assert.ok(named && root, 'expected both readings');
  assert.ok(named.rank < root.rank, `${named.rank} should beat ${root.rank}`);
});

test('shape says how to count what comes back', () => {
  /* with_entries returns one object and the answer is its size; everything
     else returns a stream and the answer is its length. */
  const all = suggest(DOC, TAG);
  const kept = all.find((c) => c.q === '.paths | with_entries(select(.value.get.tags? | index("Page content")?))');
  assert.ok(kept, 'expected the with_entries reading');
  assert.strictEqual(kept.shape, 'keys');
  assert.strictEqual(yields(kept), 2);

  const stream = all.find((c) => c.q === '.. | objects | select(.tags? | index("Page content")?)');
  assert.ok(stream, 'expected the reading from anywhere');
  assert.strictEqual(stream.shape, 'results');
  assert.strictEqual(yields(stream), 3);
});

test('the same query is never offered twice', () => {
  for (const segs of allPaths(DOC)) {
    const qs = queries(segs);
    assert.strictEqual(new Set(qs).size, qs.length, `duplicate for ${JSON.stringify(segs)}`);
  }
});

test('a deeply nested line does not fill the list', () => {
  /* Every ancestor is a candidate pivot, so without a cap a value twenty
     levels down would offer forty readings. */
  let deep: unknown = { end: 1 };
  for (let i = 0; i < 20; i++) deep = { down: deep };
  const doc = parseJSON(JSON.stringify(deep));
  const segs: Segment[] = [];
  for (let i = 0; i < 20; i++) segs.push({ key: 'down' });
  segs.push({ key: 'end' });
  assert.ok(suggest(doc, segs).length <= 16, String(suggest(doc, segs).length));
});

test('a line that is not in the document is offered nothing', () => {
  assert.deepStrictEqual(suggest(DOC, [{ key: 'nope' }]), []);
  assert.deepStrictEqual(suggest(DOC, [{ key: 'rows' }, { index: 99 }]), []);
});

/* Every segment list in a document, root included. */
function allPaths(node: Node, at: Segment[] = []): Segment[][] {
  const out = [at];
  if (node.t === 'a') {
    node.v.forEach((child, i) => out.push(...allPaths(child, at.concat({ index: i }))));
  } else if (node.t === 'o') {
    node.k.forEach((k, i) => out.push(...allPaths(node.v[i], at.concat({ key: k }))));
  }
  return out;
}

test('every query offered for every line runs against the document it came from', () => {
  const paths = allPaths(DOC);
  assert.ok(paths.length > 30, `only ${paths.length} lines to check`);
  let checked = 0;
  for (const segs of paths) {
    for (const c of suggest(DOC, segs)) {
      try {
        compile(c.q).run(DOC);
      } catch (e) {
        const why = isJqError(e) ? `${e.jq}: ${e.message}` : String(e);
        assert.fail(`${c.q}\n  offered for ${JSON.stringify(segs)}\n  ${why}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 200, `only ${checked} suggestions checked`);
});

test('the reading of the line itself always finds the line', () => {
  /* The path row has to resolve, or the button lies about where you clicked. */
  for (const segs of allPaths(DOC)) {
    const all = suggest(DOC, segs);
    if (!all.length) continue;
    const line = all.find((c) => c.why === 'this line');
    assert.ok(line, `no path row for ${JSON.stringify(segs)}`);
    assert.strictEqual(compile(line.q).run(DOC).length, 1, `${line.q} did not resolve`);
  }
});

/* ---- completing a half-typed key ---- */

test('splitPartial reads a name still being typed', () => {
  assert.deepStrictEqual(splitPartial('.ite'), { lead: '', ctx: '.', partial: 'ite' });
  assert.deepStrictEqual(splitPartial('.items[].ki'),
    { lead: '.items[]', ctx: '.items[]', partial: 'ki' });
  assert.deepStrictEqual(splitPartial('.items[].metadata.na'),
    { lead: '.items[].metadata', ctx: '.items[].metadata', partial: 'na' });
  /* A trailing dot is a name of length zero: every key completes it. */
  assert.deepStrictEqual(splitPartial('.items[].'),
    { lead: '.items[]', ctx: '.items[]', partial: '' });
});

test('splitPartial keeps a pipe but does not run it', () => {
  /* ".items[] | " will not compile, so the keys come from ".items[]" while
     the completed text keeps the pipe as typed. */
  assert.deepStrictEqual(splitPartial('.items[] | .na'),
    { lead: '.items[] | ', ctx: '.items[]', partial: 'na' });
  assert.deepStrictEqual(splitPartial('.items[]|.na'),
    { lead: '.items[]|', ctx: '.items[]', partial: 'na' });
});

test('splitPartial leaves whole queries alone', () => {
  for (const raw of ['.', '..', '.a..', '.items[]', '.items[0]', '.a?', 'keys',
    '.items|keys', '', '.a == "b"']) {
    assert.strictEqual(splitPartial(raw), null, `split ${JSON.stringify(raw)}`);
  }
});

const stream = (...texts: string[]) => texts.map((t) => parseJSON(t));

test('completions gathers the keys that continue the name', () => {
  const out = stream('{"kind":"Pod","kindle":1}', '{"kind":"Job"}', '{"phase":"x"}', '[1]', '"s"');
  const got = completions(out, 'ki');
  assert.strictEqual(got.exact, false);
  assert.strictEqual(got.objects, 3);
  assert.deepStrictEqual(got.keys, [{ key: 'kind', n: 2 }, { key: 'kindle', n: 1 }]);
});

test('a name matching a whole key is exact, and not offered as its own finish', () => {
  const got = completions(stream('{"name":"a","namespace":"b"}'), 'name');
  assert.strictEqual(got.exact, true);
  assert.deepStrictEqual(got.keys, [{ key: 'namespace', n: 1 }]);
});

test('completions orders by how many objects carry the key, then by name', () => {
  const out = stream('{"b":1,"a":1}', '{"c":1,"a":1}', '{"c":1}');
  assert.deepStrictEqual(completions(out, '').keys,
    [{ key: 'a', n: 2 }, { key: 'c', n: 2 }, { key: 'b', n: 1 }]);
});

test('completions survives keys named after Object.prototype members', () => {
  const got = completions(stream('{"constructor":1,"hasOwnProperty":2}'), 'const');
  assert.deepStrictEqual(got.keys, [{ key: 'constructor', n: 1 }]);
});

test('completions caps the list', () => {
  const keys: string[] = [];
  for (let i = 0; i < 250; i++) keys.push(`"k${String(i).padStart(3, '0')}":1`);
  const got = completions(stream('{' + keys.join(',') + '}'), 'k');
  assert.strictEqual(got.keys.length, 200);
});

/* ---- completing a half-typed function name ---- */

test('splitCall reads a function name still being typed', () => {
  assert.deepStrictEqual(splitCall('len'), { lead: '', partial: 'len' });
  assert.deepStrictEqual(splitCall('.[] | joi'), { lead: '.[] | ', partial: 'joi' });
  assert.deepStrictEqual(splitCall('.items[] | select(len'),
    { lead: '.items[] | select(', partial: 'len' });
  assert.deepStrictEqual(splitCall('.a | test("x") | le'),
    { lead: '.a | test("x") | ', partial: 'le' });
  /* A format is a name with an @ on the front. */
  assert.deepStrictEqual(splitCall('.a | @cs'), { lead: '.a | ', partial: '@cs' });
});

test('splitCall leaves everything else alone', () => {
  /* A field is splitPartial's, a variable and an operator are whole, a name
     inside an unfinished string is text, a name in a comment is nothing, and
     a name followed by anything is finished. */
  for (const raw of ['', '.', '.items[].ki', '$x', '.a and', 'keys(1)', '.a | length ',
    '.a | test("ab', '.a # len', 'length | .a']) {
    assert.strictEqual(splitCall(raw), null, `split ${JSON.stringify(raw)}`);
  }
});

const offered = (partial: string) => functionCompletions(partial).hints.map((h) => h.q);

test('functionCompletions offers the names that continue a partial', () => {
  const got = functionCompletions('ma');
  assert.strictEqual(got.exact, false);
  assert.deepStrictEqual(got.hints.map((h) => h.q), ['map(', 'map_values(', 'match(', 'max', 'max_by(']);
  assert.deepStrictEqual(offered('len'), ['length']);
  assert.deepStrictEqual(offered('@b'), ['@base64', '@base64d']);
  assert.deepStrictEqual(offered('zz'), []);
});

test('a name that takes an argument in every form is offered with its paren', () => {
  /* "join" is a whole name, but run as written it can only fail: it stays on
     the list until the argument is typed. */
  const join = functionCompletions('join');
  assert.strictEqual(join.exact, false);
  assert.deepStrictEqual(join.hints.map((h) => h.q), ['join(']);
  /* "first" takes an argument or not, so the bare form is what runs, and so
     does a name that takes none. */
  assert.strictEqual(functionCompletions('first').exact, true);
  assert.deepStrictEqual(offered('first'), ['first']);
  assert.strictEqual(functionCompletions('length').exact, true);
  assert.strictEqual(functionCompletions('true').exact, true);
  /* A whole name that a longer one continues is still exact. */
  assert.strictEqual(functionCompletions('keys').exact, true);
  assert.deepStrictEqual(offered('keys'), ['keys', 'keys_unsorted']);
});

test('every hint carries its signature and what it does', () => {
  const all = functionCompletions('').hints;
  assert.ok(all.length > 100, `only ${all.length} hints`);
  for (const h of all) {
    assert.ok(h.sig.includes(h.q.replace(/\($/, '')), `${h.q}: signature ${h.sig}`);
    assert.match(h.doc, /^\S/, h.q);
  }
});

test('every builtin has a description, and every description is of a builtin or a word', () => {
  const names = new Set(Object.keys(builtins).map((key) => key.slice(0, key.lastIndexOf('/'))));
  const words = ['if', 'then', 'elif', 'else', 'end', 'and', 'or', 'true', 'false', 'null'];
  const undocumented = [...names].filter((n) => !DOCS[n]).sort();
  assert.deepStrictEqual(undocumented, [], 'builtins with no description');
  const unknown = Object.keys(DOCS).filter((n) => !names.has(n) && !words.includes(n)).sort();
  assert.deepStrictEqual(unknown, [], 'descriptions of nothing');
  for (const name of Object.keys(DOCS)) {
    const [sig, doc] = DOCS[name];
    assert.ok(sig.includes(name), `${name}: the signature does not name it`);
    assert.ok(sig.length <= 40, `${name}: the signature is too long for its column`);
    assert.ok(doc.length <= 60, `${name}: too long to read on a row of the list`);
  }
});
