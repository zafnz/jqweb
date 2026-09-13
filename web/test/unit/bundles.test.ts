/* The modules each page script is built from. A --simple page leaves the query
   engine out, and the head script runs before the body exists, so what each
   bundle reaches is read from esbuild's own module graph rather than trusted
   to the import statements. Run with:  npm --prefix web test */

import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { options, root } from '../../bundles.ts';
import type { Bundle } from '../../bundles.ts';

/* The query half of the page, which only the full script may reach: every
   module under src/query, read from the directory so that a new one is
   covered without being listed here. */
const QUERY = 'src/query/';
const queryModules = readdirSync(join(root, QUERY), { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.[jt]s$/.test(f) && !f.endsWith('.d.ts'))
  .map((f) => QUERY + f)
  .sort();

async function modules(name: Bundle): Promise<string[]> {
  const result = await build({ ...options(name), metafile: true });
  assert.ok(result.metafile, 'esbuild returned no metafile');
  return Object.keys(result.metafile.inputs).sort();
}

test('the simple script reaches none of the query modules', async () => {
  const simple = await modules('simple');
  assert.deepStrictEqual(simple.filter((m) => m.startsWith(QUERY)), []);
  assert.ok(simple.includes('src/page/bootstrap.ts'), 'the simple script does not reach page/bootstrap.ts');
});

test('the full script reaches the simple modules and the query modules', async () => {
  const simple = await modules('simple');
  const full = await modules('full');
  const shared = simple.filter((m) => m !== 'src/entries/simple.ts');
  assert.deepStrictEqual(shared.filter((m) => !full.includes(m)), []);
  assert.ok(queryModules.length > 2, `only ${queryModules.length} modules under ${QUERY}`);
  assert.deepStrictEqual(queryModules.filter((m) => !full.includes(m)), []);
});

test('the head script reaches only the theme and the /alive request', async () => {
  assert.deepStrictEqual(await modules('theme'),
    ['src/entries/theme.ts', 'src/page/alive.ts', 'src/page/theme.ts']);
});
