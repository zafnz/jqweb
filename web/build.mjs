import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { bundles, options, root } from './bundles.ts';

const outdir = join(root, 'dist');

await mkdir(outdir, { recursive: true });
for (const name of bundles) {
  const result = await build(options(name));
  await writeFile(join(outdir, `${name}.js`), result.outputFiles[0].contents);
}
