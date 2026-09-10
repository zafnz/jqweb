/* Tests for the queries offered when you click the filter button on a line.
   Run with:  node --test

   The property that matters most is at the bottom: every query offered for
   every line of a document has to compile and run against that document. A
   suggestion that errors is worse than no suggestion, and the shapes that
   break one -- a pivot whose members are not all objects, a value sitting in
   an array, a key that needs quoting -- are easy to miss by hand. */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseJSON } = require('./core.js');
const { compile } = require('./jq.js');
const { suggest, project } = require('./suggest.js');

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
const TAG = [{ key: 'paths' }, { key: '/page/' }, { key: 'get' }, { key: 'tags' }, { index: 0 }];

/* Records of two shapes in one list, as a kubectl listing holds them: a Pod
   keeps its containers at .spec.containers, and a Deployment keeps them one
   level further down under a template. */
const LIST = parseJSON(JSON.stringify({
  items: [
    { kind: 'Pod', metadata: { name: 'a' }, spec: { containers: [{ ports: [{ containerPort: 80 }] }] } },
    {
      kind: 'Deployment',
      metadata: { name: 'b' },
      spec: { template: { spec: { containers: [{ ports: [{ containerPort: 80 }] }] } } }
    }
  ]
}));

/* Where the Pod's port sits. */
const PORT = [{ key: 'items' }, { index: 0 }, { key: 'spec' }, { key: 'containers' },
  { index: 0 }, { key: 'ports' }, { index: 0 }, { key: 'containerPort' }];

const queries = (segs) => suggest(DOC, segs).map((c) => c.q);

/* What one candidate returns, counted the way its shape says to count it. */
function yields(c, doc) {
  const out = compile(c.q).run(doc || DOC);
  if (c.shape !== 'keys') return out.length;
  return out.length && out[0].t === 'o' ? out[0].k.length : 0;
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
  for (const segs of [TAG, [{ key: 'version' }], [{ key: 'rows' }, { index: 0 }]]) {
    const plain = suggest(DOC, segs).filter((c) => c.plain);
    assert.strictEqual(plain.length, 1, `for ${JSON.stringify(segs)}`);
    assert.strictEqual(plain[0].q, suggest(DOC, segs).find((c) => c.why === 'this line').q);
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

test('a list of records can be searched a whole record at a time', () => {
  /* The shapes differ between records, so the path the port was clicked at
     finds the record it was read from and nothing else. */
  const all = suggest(LIST, PORT);
  const deep = all.find((c) => c.q === '.items[] | select(any(.. | objects; .containerPort? == 80))');
  assert.ok(deep, all.map((c) => c.q).join('\n'));
  assert.strictEqual(yields(deep, LIST), 2);
  const exact = all.find((c) => c.q === '.items[] | select(.spec.containers[0].ports[0].containerPort? == 80)');
  assert.strictEqual(yields(exact, LIST), 1);
});

test('the record beats the search that gives up on structure', () => {
  /* Both find two here, so the order the reader sees them in comes down to
     what they hand back: the record, or the port object, which no longer says
     which record it came from. */
  const all = suggest(LIST, PORT);
  const deep = all.find((c) => c.q.includes('.items[] | select(any('));
  const anywhere = all.find((c) => c.why === 'anywhere');
  assert.ok(deep.rank < anywhere.rank, `${deep.rank} should beat ${anywhere.rank}`);
});

test('a record answers for itself once it is what came back', () => {
  /* Which is the whole point of keeping it: the port is what was searched
     for, and .metadata.name is what says which thing has it. */
  const q = project('.items[] | select(any(.. | objects; .containerPort? == 80))',
    [[{ key: 'metadata' }, { key: 'name' }]], false);
  const out = compile(q).run(LIST);
  assert.deepStrictEqual(out.map((n) => n.v[0].r), ['a', 'b']);
});

test('a deep reading is not offered where an exact path asks the same thing', () => {
  /* .rows[] | select(.id? == 1) looks at the same records for the same value
     and says where it is looking. */
  const qs = queries([{ key: 'rows' }, { index: 0 }, { key: 'id' }]);
  assert.ok(!qs.some((q) => q.includes('any(.. | objects')), qs.join('\n'));
});

test('a container holding one member is not a list of records', () => {
  /* .big holds .blob and nothing else, so asking which of its members holds
     the value has one answer whatever the value is. */
  const qs = queries([{ key: 'big' }, { key: 'blob' }]);
  assert.ok(!qs.some((q) => q.includes('.big | with_entries(select(.value | any(')), qs.join('\n'));
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
  assert.strictEqual(kept.shape, 'keys');
  assert.strictEqual(yields(kept), 2);

  const stream = all.find((c) => c.q === '.. | objects | select(.tags? | index("Page content")?)');
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
  let deep = { end: 1 };
  for (let i = 0; i < 20; i++) deep = { down: deep };
  const doc = parseJSON(JSON.stringify(deep));
  const segs = [];
  for (let i = 0; i < 20; i++) segs.push({ key: 'down' });
  segs.push({ key: 'end' });
  assert.ok(suggest(doc, segs).length <= 16, suggest(doc, segs).length);
});

test('a line that is not in the document is offered nothing', () => {
  assert.deepStrictEqual(suggest(DOC, [{ key: 'nope' }]), []);
  assert.deepStrictEqual(suggest(DOC, [{ key: 'rows' }, { index: 99 }]), []);
});

/* Every segment list in a document, root included. */
function allPaths(node, at = []) {
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
        assert.fail(`${c.q}\n  offered for ${JSON.stringify(segs)}\n  ${e.jq}: ${e.message}`);
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

/* ---- picking the output ---- */

test('a picked line is named after the key it sat under', () => {
  assert.strictEqual(project('.items[]', [[{ key: 'metadata' }, { key: 'name' }]], false),
    '.items[] | {name: .metadata.name}');
});

test('a second pick under the same key is named by its whole path', () => {
  const picks = [[{ key: 'metadata' }, { key: 'name' }], [{ key: 'spec' }, { key: 'name' }]];
  assert.strictEqual(project('.items[]', picks, false),
    '.items[] | {name: .metadata.name, "spec.name": .spec.name}');
});

test('a name that is not a bare word is quoted where it is written', () => {
  const q = project('.items[]', [[{ key: 'app.kubernetes.io/name' }]], false);
  assert.strictEqual(q, '.items[] | {"app.kubernetes.io/name": .["app.kubernetes.io/name"]}');
  assert.doesNotThrow(() => compile(q));
});

test('a line reached by index alone is named by its path', () => {
  const q = project('.[]', [[{ index: 0 }]], false);
  assert.strictEqual(q, '.[] | {"[0]": .[0]}');
  assert.doesNotThrow(() => compile(q));
});

test('quoting every name is what a key the parser wants for itself needs', () => {
  /* {and: .and} is a parse error, which is the caller's cue to ask again. */
  assert.throws(() => compile(project('.', [[{ key: 'and' }]], false)));
  assert.doesNotThrow(() => compile(project('.', [[{ key: 'and' }]], true)));
});

test('every field of a record can be picked out of it', () => {
  /* A pick is a line of a result, so whatever the document holds can be one,
     and the query has to run whichever line that was. */
  for (const segs of allPaths(LIST.v[0].v[0])) {
    if (!segs.length) continue;
    const q = project('.items[]', [segs], false);
    let ran = q;
    try {
      compile(q);
    } catch (e) {
      ran = project('.items[]', [segs], true);
    }
    assert.doesNotThrow(() => compile(ran).run(LIST), ran);
  }
});
