# Changelog

What each release of jqweb changed, written for someone upgrading. The form is
the one described at https://keepachangelog.com/en/1.1.0/, and the versions
follow https://semver.org/spec/v2.0.0.html.

The release workflow publishes the section for the tag as the release notes,
above the commit list GoReleaser generates.

## [Unreleased]

**Fixed:** pressing Escape to dismiss query suggestions no longer clears the
search box.

## [0.8.0] - 2026-09-12

### A query on the command line

`jqweb '.items[] | .metadata.name' file.json` opens the page with that query
already run. With only one argument supplied it auto-detects if it's a file
or query.

## [0.7.1] - 2026-09-12

### Update checker

jqweb now tells you when a newer release is available. It checks at most once a
day, and does not mention a release until a day after first seeing it.

## [0.7.0] - 2026-09-12

### Phone-width pages keep the tree in view

At 600px wide and below, the page hides the search box, mode selector, match
count and per-line copy and filter buttons. The tree, its toggles, Collapse all
and the theme button stay visible, so a phone in portrait gets the document
rather than a toolbar wrapped over it.

### Opening a page follows `$BROWSER`

`-O` and `-OC` now use `$BROWSER` when it is set, before falling back to the
platform opener. Remote development environments such as Codespaces and VS
Code containers set that to a helper which opens the page on the local machine,
so `jqweb -O file.json` works there without needing `xdg-open` inside the
container.

### A half-typed key completes instead of running as nulls

jq reads a missing key as null, so `.items[].ki` on the way to `.items[].kind`
replaced the results with one null per item. The page holds that run back: it
runs the query up to the trailing name, and while that name is a prefix of keys
the output really has, the suggestion list offers those keys and the view stays
where it was.

An exact key runs as it always did, a name no key starts with runs as written,
Enter runs the half-typed text, and a bare trailing dot offers every key
instead of a syntax error. `.items[] | .na` completes against what flows into
the pipe. Only the default build carries this; `--simple` is unchanged.

## [0.6.0] - 2026-09-11

### Stop serving once the page has been fetched

`-C` (or `--close`) serves the page and exits once a browser has fetched it,
instead of holding the terminal until Ctrl-C. `-OC` does that and opens the
browser:

```
jqweb -OC deploy.json
```

The wait is `--close-delay`, 1 second by default.

**Fixed:** the one-dash spellings of the long flags -- `-theme`, `-host`,
`-port` and `-output` -- could take the wrong value once the arguments were
reordered, and now behave as their two-dash forms do.

## [0.5.0] - 2026-09-10

### More of jq

The search box understands about 105 filters, up from 62. The ones worth
knowing about:

**Regular expressions** -- `match`, `capture`, `scan`, `splits`, `sub` and
`gsub`, alongside the `test` that was already there. A replacement is a filter
run against the match's named captures, so jq's own example works:
`gsub("(?<c>l)"; "[" + .c + "]")`.

**Format strings**, written with an `@` as jq writes them: `@text`, `@json`,
`@csv`, `@tsv`, `@uri`, `@html`, `@sh`, `@base64` and `@base64d`. `@base64d` is
the one that makes a Kubernetes secret readable.

**`any(gen; cond)` and `all(gen; cond)`**, which take a stream rather than the
input's own members, so a test can reach anywhere in a subtree:
`.items[] | select(any(.. | objects; .containerPort? == 80))`.

**`paths`, `paths(f)` and `getpath`** for looking at the shape of a document,
and `walk`, `while`, `until`, `isempty`, `error` and `recurse(f; cond)`.

**Dates** -- `now`, `todate`, `fromdate`, `gmtime`, `mktime` and `strftime`,
which is what a Kubernetes timestamp wants.

Also `explode`, `implode`, and `pow`, `log`, `log2`, `log10`, `exp`, `exp2`,
`exp10` and `trunc`.

Nothing here edits a document. `del`, `setpath` and the assignment operators
need path expressions, and the page is for reading a document rather than
changing one. Variables, `def`, `reduce`, `foreach`, `try`/`catch` and string
interpolation are still out, and a query using one says so by name.

### Page size

The engine is about 70KB in a page, up from about 53KB in 0.4.1. `--simple` is
unchanged, since none of this ships in one.

## [0.4.1] - 2026-09-10

A bug fix and a small addition, on top of 0.4.0.

### Typing "." no longer jumps into the middle of the document

"." is jq's identity, so it resolved to the whole document, and revealing that
scrolled the middle of it to the middle of the window -- half way down the
file, whatever the file. Anything taller than the window did the same, so a
match on a large subtree opened at its midpoint rather than at its top.

A match that does not fit on screen now opens at its top, under the toolbar.
One already on screen is left where it is, so typing a path one character at a
time no longer drags the page about.

### The name in the toolbar links to the project

jqweb carries the GitHub mark and the full text colour, next to the file name,
which stays muted. It opens in a new tab, because a page holds a filter, a
collapsed tree and whatever query has been built up in it.

## [0.4.0] - 2026-09-10

### jq queries

The search box answers jq queries as well as finding text: paths, iteration,
slices, pipes, `//`, `?`, comparisons, arithmetic, if/then/elif/else/end, array
and object construction, and about 60 builtins including `select`, `map`,
`keys`, `to_entries`, `sort_by`, `group_by`, `unique_by`, `flatten`, `range`,
`join`, `test` and `index`. Variables, `def`, `reduce`, assignment, string
interpolation and format strings are not there, and a query using one says so
by name rather than guessing at what it meant.

A query whose output is not part of the document replaces the tree with its
results. One that only walks down, such as `.a.b[3]`, highlights that node, the
way a pasted path always has.

### Filtering on a value

Every line has a second button. It fills the search box with a query built from
that line and offers the other queries the line could have meant, each labelled
with what it returns -- 14 results against 1 says which reading was meant
without anyone having to work out the jq.

### Light and dark

The page follows the reader's system. The button at the right of the toolbar
cycles auto, light and dark and remembers the choice; `--theme light` or
`--theme dark` sets what a page starts in.

### Toolbar

Expand all and Collapse all are one button, moved to the right, and the search
box fills the room they left.

### Page size

The query engine is inlined into every page, which makes one about 57KB larger
than 0.3.0 whatever the document. `--simple` leaves it out, for a page that
browses, filters and looks up paths and nothing else; that one is about 5KB
larger than 0.3.0, which is the second colour palette.

Against that, the comments in the page scripts are no longer served to every
reader of a page. They were written for someone reading `web/*.js` and were
being inlined along with the code; stripping them takes about 10KB off a page
before any of the above is added.

### Truncated input

JSON that ends inside an unclosed container reports that it was truncated,
rather than an end-of-input error, whichever version of Go built the binary. Go
1.27 changed what the decoder returns there, which had made the message worse
in a binary built with it.

## [0.3.0] - 2026-09-09

The page carries the document as JSON and builds the tree in the browser,
rather than being served a tree already rendered.

## [0.2.1] - 2026-09-04

The version flag reports the module version when the linker sets none, so a
binary from `go install` names itself.

## [0.2.0] - 2026-09-04

The search box looks up a path in the document. `install.sh` and the live
example page arrive with it.

## [0.1.0] - 2026-09-01

The first release: a JSON document rendered as one self-contained HTML page,
served or written to a file, with a flag to open a browser on it and a flag to
report the version.

[Unreleased]: https://github.com/zafnz/jqweb/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/zafnz/jqweb/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/zafnz/jqweb/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/zafnz/jqweb/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/zafnz/jqweb/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/zafnz/jqweb/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/zafnz/jqweb/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/zafnz/jqweb/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zafnz/jqweb/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/zafnz/jqweb/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/zafnz/jqweb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zafnz/jqweb/releases/tag/v0.1.0
