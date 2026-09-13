/* The types jq.js is called through by query/ui.ts, the full entry and the
   unit tests. The engine itself is still JavaScript. */

import type { Node } from './model/node.ts';
import type { Segment } from './model/path.ts';

/* A compiled query. path is the segments of a query that only walks down the
   document, in the form parsePath produces, and null for anything else. run
   returns the stream the query produces for one input. */
export interface Query {
  path: Segment[] | null;
  run(input: Node): Node[];
}

/* What compile and run throw for a query at fault. jq is 'parse' for a query
   that does not compile and 'run' for one that fails against a value; pos is
   where a parse error gave up. */
export interface JqError extends Error {
  jq: 'parse' | 'run';
  pos?: number;
}

/* Compiles a query, throwing a JqError with a pos for text that is not one. */
export function compile(src: string): Query;

/* Whether a thrown value is a JqError, rather than a fault in the engine or
   the page. */
export function isJqError(e: unknown): e is JqError;
