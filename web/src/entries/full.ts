/* The default page: everything the simple page has, with the search box also
   read as a jq query. */

import { esc, quote } from '../model/escape.ts';
import { leafOf, stringify } from '../model/node.ts';
import { parseJSON } from '../model/parse.ts';
import { parsePath, pathText } from '../model/path.ts';
import { renderTree } from '../model/render.ts';
import { compile } from '../query/engine/index.js';
import { completions, splitPartial, suggest } from '../query/suggest.ts';
import { startPage } from '../page/bootstrap.ts';
import { jqui } from '../query/ui.ts';

/* The browser specs find a line of the tree with jqweb.parsePath, run the
   queries a suggestion offers with jqjs, and check that --simple leaves both
   engine globals out. The objects are written out for the reason given in
   simple.ts. */
window.jqweb = { parseJSON, leafOf, stringify, renderTree, parsePath, pathText, quote, esc };
window.jqjs = { compile };
window.jqsuggest = { suggest, splitPartial, completions };

startPage(jqui);
