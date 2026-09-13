/* The modules each page script is built from. A --simple page leaves the query
   engine out, and the head script runs before the body exists, so what each
   bundle reaches is read from esbuild's own module graph rather than trusted
   to the import statements. Run with:  node --test */

import assert from 'node:assert';
import test from 'node:test';
import { build } from 'esbuild';
import { options } from './bundles.ts';
import type { Bundle } from './bundles.ts';

/* The query half of the page, which only the full script may reach. */
const QUERY = ['src/jq.js', 'src/query.js', 'src/suggest.js'];

async function modules(name: Bundle): Promise<string[]> {
  const result = await build({ ...options(name), metafile: true });
  assert.ok(result.metafile, 'esbuild returned no metafile');
  return Object.keys(result.metafile.inputs).sort();
}

test('the simple script reaches none of the query modules', async () => {
  const simple = await modules('simple');
  assert.deepStrictEqual(simple.filter((m) => QUERY.includes(m)), []);
  assert.ok(simple.includes('src/page.js'), 'the simple script does not reach page.js');
});

test('the full script reaches the simple modules and the query modules', async () => {
  const simple = await modules('simple');
  const full = await modules('full');
  const shared = simple.filter((m) => m !== 'src/entries/simple.js');
  assert.deepStrictEqual(shared.filter((m) => !full.includes(m)), []);
  assert.deepStrictEqual(QUERY.filter((m) => !full.includes(m)), []);
});

test('the head script reaches only the theme', async () => {
  assert.deepStrictEqual(await modules('theme'), ['src/entries/theme.js', 'src/theme.js']);
});
