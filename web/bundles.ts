/* The three scripts web/dist holds, and the esbuild options for each. build.mjs
   writes them, and bundles.test.ts checks which modules each one reaches. */

import type { BuildOptions } from 'esbuild';

export const root = import.meta.dirname;

export const bundles = ['theme', 'simple', 'full'] as const;

export type Bundle = (typeof bundles)[number];

/* Each script is bundled on its own, with no shared chunk: a page inlines one
   script in the head and one in the body and loads nothing else. */
export function options(name: Bundle): BuildOptions {
  return {
    absWorkingDir: root,
    entryPoints: [`src/entries/${name}.js`],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2015',
    charset: 'utf8',
    legalComments: 'none',
    minify: true,
    write: false
  };
}
