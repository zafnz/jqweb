/* The globals the entries set for the browser specs: jqweb in every page, and
   jqjs and jqsuggest in the full page only. jqtheme, which the head script
   sets, is declared in page/theme.ts. */

import type { compile } from '../jq.js';
import type { esc, quote } from '../model/escape.ts';
import type { leafOf, stringify } from '../model/node.ts';
import type { parseJSON } from '../model/parse.ts';
import type { parsePath, pathText } from '../model/path.ts';
import type { renderTree } from '../model/render.ts';
import type { completions, splitPartial, suggest } from '../query/suggest.ts';

declare global {
  var jqweb: {
    parseJSON: typeof parseJSON;
    leafOf: typeof leafOf;
    stringify: typeof stringify;
    renderTree: typeof renderTree;
    parsePath: typeof parsePath;
    pathText: typeof pathText;
    quote: typeof quote;
    esc: typeof esc;
  };
  var jqjs: {
    compile: typeof compile;
  };
  var jqsuggest: {
    suggest: typeof suggest;
    splitPartial: typeof splitPartial;
    completions: typeof completions;
  };
}
