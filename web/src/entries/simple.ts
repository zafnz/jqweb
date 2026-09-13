/* The page --simple builds: the tree, text search and path lookup, without the
   jq engine. Nothing reachable from here may import jq.js or a module under
   query/, and bundles.test.ts fails when something does. */

import { esc, quote } from '../model/escape.ts';
import { leafOf, stringify } from '../model/node.ts';
import { parseJSON } from '../model/parse.ts';
import { parsePath, pathText } from '../model/path.ts';
import { renderTree } from '../model/render.ts';
import { startPage } from '../page/bootstrap.ts';

/* The browser specs find a line of the tree with jqweb.parsePath. The object is
   written out rather than imported as a namespace, which esbuild builds with a
   getter per name and which costs this bundle 155 bytes. */
window.jqweb = { parseJSON, leafOf, stringify, renderTree, parsePath, pathText, quote, esc };

startPage(null);
