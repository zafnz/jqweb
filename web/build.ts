import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { bundles, options, root } from './bundles.ts';

const outdir = join(root, 'dist');

await mkdir(outdir, { recursive: true });
for (const name of bundles) {
  const [file] = (await build(options(name))).outputFiles ?? [];
  if (!file) throw new Error(`esbuild returned no output for ${name}`);
  await writeFile(join(outdir, `${name}.js`), file.contents);
}
