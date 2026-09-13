/* The errors the engine throws, and how to tell one from anything else thrown.

   kind is 'parse' for a query that does not compile and 'run' for one that
   fails against a value. Only 'run' errors are the ones "?" swallows, and
   only 'parse' errors carry a position to point at. */

function fail(kind, msg, pos) {
  var e = new Error(msg);
  e.jq = kind;
  e.pos = pos;
  return e;
}
function parseErr(msg, pos) { return fail('parse', msg, pos); }
function runErr(msg) { return fail('run', msg); }

/* Whether a thrown value is one of the errors above, rather than a fault in
   the engine or the page. */
function isJqError(e) { return e instanceof Error && 'jq' in e; }

export { isJqError, parseErr, runErr };
