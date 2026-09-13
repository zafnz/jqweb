/* The page --simple builds: the tree, text search and path lookup, without the
   jq engine. Nothing reachable from here may import jq.js, suggest.js or
   query.js, and bundles.test.ts fails when something does. */

import { esc, leafOf, parseJSON, parsePath, pathText, quote, renderTree, stringify } from '../core.js';
import { startPage } from '../page.js';

/* The browser specs find a line of the tree with jqweb.parsePath. The object is
   written out rather than imported as a namespace, which esbuild builds with a
   getter per name and which costs this bundle 155 bytes. */
window.jqweb = { parseJSON, leafOf, stringify, renderTree, parsePath, pathText, quote, esc };

startPage(null);
