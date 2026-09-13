/* The default page: everything the simple page has, with the search box also
   read as a jq query. */

import { esc, leafOf, parseJSON, parsePath, pathText, quote, renderTree, stringify } from '../core.js';
import { compile } from '../jq.js';
import { completions, splitPartial, suggest } from '../suggest.js';
import { startPage } from '../page.js';
import { jqui } from '../query.js';

/* The browser specs find a line of the tree with jqweb.parsePath, run the
   queries a suggestion offers with jqjs, and check that --simple leaves both
   engine globals out. The objects are written out for the reason given in
   simple.js. */
window.jqweb = { parseJSON, leafOf, stringify, renderTree, parsePath, pathText, quote, esc };
window.jqjs = { compile };
window.jqsuggest = { suggest, splitPartial, completions };

startPage(jqui);
