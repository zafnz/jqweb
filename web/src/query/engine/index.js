/* A subset of jq, evaluated in the page against the parsed document.

   The values this works on are the same nodes model/parse.ts builds for
   rendering, so a result goes straight to renderTree with object key order
   and number text intact, and the document is parsed once rather than twice.
   Scalars are read from a leaf's r field and built with leafOf.

   Every jq expression maps one input to a stream of outputs. Here a stream is
   an array, which makes ",", "[]" and select fall out of the evaluator for
   free; the price is that nothing short-circuits, so a filter over an endless
   stream would not terminate. None of the builtins produce one.

   What is missing, and rejected by name rather than mis-parsed: variables and
   "as", def, reduce, foreach, assignment, path expressions, string
   interpolation, format strings, and try/catch. Bare "?" is supported.

   Nothing in this directory touches the DOM; query/ui.ts drives it. */

import { evaluate } from './evaluate.js';
import { parse, pathSegs } from './parser.js';

/* Compiles a query. Throws a parse error, with a pos, for anything that is
   not one. The result's path is the segment list for a query that only
   walks down the document, and null otherwise. */
function compile(src) {
  var ast = parse(src);
  return {
    path: pathSegs(ast),
    run: function (input) {
      return evaluate(ast, input);
    }
  };
}

export { compile };
export { isJqError } from './errors.js';
