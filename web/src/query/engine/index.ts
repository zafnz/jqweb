/* A subset of jq, evaluated in the page against the parsed document.

   The values this works on are the same nodes model/parse.ts builds for
   rendering, so a result goes straight to renderTree with object key order
   and number text intact, and the document is parsed once rather than twice.
   Scalars are read from a leaf's r field and built with leafOf.

   Every jq expression maps one input to a stream of outputs. An expression
   is run with a sink that takes each output as it is produced, so first,
   limit and isempty can stop a stream part way, and a query over an endless
   one -- limit(3; recurse(. + 1)) -- ends. run collects the stream into an
   array for the page.

   What is missing, and rejected by name rather than mis-parsed: variables and
   "as", def, reduce, foreach, assignment, path expressions, string
   interpolation, format strings, and try/catch. Bare "?" is supported.

   Nothing in this directory touches the DOM; query/ui.ts drives it. */

import type { Node } from '../../model/node.ts';
import type { Segment } from '../../model/path.ts';
import { evaluate } from './evaluate.ts';
import type { Stream } from './evaluate.ts';
import { parse, pathSegs } from './parser.ts';

export { isJqError } from './errors.ts';
export type { JqError } from './errors.ts';

/* A compiled query. path is the segments of a query that only walks down the
   document, in the form parsePath produces, and null for anything else. run
   returns the stream the query produces for one input. */
export interface Query {
  path: Segment[] | null;
  run(input: Node): Stream;
}

/* Compiles a query. Throws a parse error, with a pos, for anything that is
   not one. The result's path is the segment list for a query that only
   walks down the document, and null otherwise. */
export function compile(src: string): Query {
  const ast = parse(src);
  return {
    path: pathSegs(ast),
    run: function (input) {
      return evaluate(ast, input);
    }
  };
}
