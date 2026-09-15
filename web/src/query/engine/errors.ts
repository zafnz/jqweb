/* The errors the engine throws, and how to tell one from anything else thrown.

   kind is 'parse' for a query that does not compile and 'run' for one that
   fails against a value. Only 'run' errors are the ones "?" swallows, and
   only 'parse' errors carry a position to point at. */

export type ErrorKind = 'parse' | 'run';

/* What compile and run throw for a query at fault: the kind in jq, and for a
   parse error the position where the parser gave up in pos. */
export interface JqError extends Error {
  jq: ErrorKind;
  pos?: number;
  fatal?: boolean;
}

function fail(kind: ErrorKind, msg: string, pos?: number): JqError {
  return Object.assign(new Error(msg), { jq: kind, pos: pos });
}
export function parseErr(msg: string, pos: number): JqError { return fail('parse', msg, pos); }
export function runErr(msg: string): JqError { return fail('run', msg); }
export function workErr(msg: string): JqError { return Object.assign(runErr(msg), { fatal: true }); }

/* Whether a thrown value is one of the errors above, rather than a fault in
   the engine or the page. */
export function isJqError(e: unknown): e is JqError { return e instanceof Error && 'jq' in e; }
