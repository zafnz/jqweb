import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, 'dist');

// Keep today's source order until the files become modules. The three outputs
// are already the eventual page entry points: the early palette selection,
// the page without jq, and the full page with it.
const bundles = {
  theme: ['theme.js'],
  simple: ['core.js', 'page.js'],
  full: ['core.js', 'jq.js', 'suggest.js', 'query.js', 'page.js']
};

await mkdir(outdir, { recursive: true });
for (const [name, files] of Object.entries(bundles)) {
  const parts = await Promise.all(files.map((file) => readFile(join(root, file), 'utf8')));
  const result = await transform(parts.join('\n'), {
    charset: 'utf8',
    legalComments: 'none',
    loader: 'js',
    minify: true,
    target: 'es2015'
  });
  await writeFile(join(outdir, `${name}.js`), result.code);
}
