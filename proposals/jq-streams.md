# jq stream evaluation

Issue: https://github.com/zafnz/jqweb/issues/91

Keep the AST, parser structure and shared document nodes. Replace the eager
array evaluator with lazy iterators, collecting the final result at `run()` so
the page and suggestion APIs remain unchanged.

## Decisions

- An expression can emit values before failing. `?` catches the failure where
  it occurs; `first`, `limit`, `any`, `all` and `isempty` stop consuming upstream.
  An uncaught error still makes the public `run()` throw.
- Each evaluation owns its work budget. Recursive filters use a bounded stack
  of suspended iterators, closed when a consumer stops. Work exhaustion is
  fatal; `?` cannot suppress it and continue executing.
- Proven scalar expressions use direct calls. This avoids an iterator for
  every arithmetic operand and lets scalar recursive steps reuse their frame.
  Branching recursion is limited to 4,096 pending continuations; all queries
  retain the five-million-step budget.
- Value-argument expansion shares one helper with explicit ordering. Native
  arithmetic and `pow` evaluate rightmost first; jq-defined `range` binds
  leftmost first. Filter arguments stay under the builtin's control.
- Collect where jq does: array construction, sorting and complete substitution
  replacement alternatives. `walk` collects array children but takes the first
  result for each object member, matching jq's update-assignment semantics.
- Numeric nodes retain infinity and NaN for subsequent evaluation. Their JSON
  representation saturates infinities and writes NaN as null. Decimal parsing,
  rounding, Unicode comparison and splitting use shared helpers.

## Compatibility and validation

The additional corpus records jq 1.7.1 outputs, including those emitted before
an error, plus compile/runtime failure status. It covers empty and branching
streams, evaluation order, short-circuiting, numbers, Unicode and validation.
Separate tests cover iterator cleanup, independent budgets and fatal limits.

The intentional JavaScript regex backend and character-based string offsets
remain. Unicode empty regex matches now advance by a whole code point. The
issue's six-field `mktime` example fails because jq requires eight fields;
eight-field inputs still normalize an overflowing month as jq does.

Before merging, run the unit, type, Go and browser checks, rebuild the committed
assets and example page, and compare query timings against the previous bundle.
