# Notes for Claude

`README.md` is what jqweb does. `CONTRIBUTING.md` is how to build, test and
release it. This is the part that is neither: what the thing is made of, and
the rules that are not obvious from reading one file at a time.

## Which document a thing goes in

`README.md` is for the people who run jqweb. It says what a flag does and what
the page can do, and nothing about how any of it is built. Leave implementation
out of it unless someone running the command has to know: how the `-C` timer
decides when to exit belongs there because it changes what the user sees, and
how `reorderArgs` places a flag's value does not.

Anything a reader can already assume goes nowhere. A flag taking one dash or
two is what both the Unix and the Go conventions lead people to expect, so it
needs no paragraph — and it is not a feature of jqweb.

`CONTRIBUTING.md` is for people working on jqweb: building, testing, releasing,
and the reasoning behind decisions in the source. `CLAUDE.md` is this file, for
Claude. Neither belongs in `README.md`.

## Where the work is tracked

Bugs, wanted features and anything else not being worked on right now are
GitHub issues on `zafnz/jqweb`. `gh issue list` for what is open, `gh issue
create` to file one. `TODO.md` holds the entries that were filed as issues and
is not where new ones go.

When someone asks for something to be added to the TODO without saying where,
ask whether they want an issue filed or just a note kept for the rest of the
session.

## Where the work happens

Branch work is done in a git worktree under `.claude/worktrees/`, which is
gitignored. The primary checkout `~/projects/jqweb` stays on `main` and stays
usable while several branches are in flight. A worktree the `EnterWorktree` tool
makes carries a `worktree-<name>` branch and is locked; one added by hand for an
existing branch keeps that branch's own name.

When asked to start a feature, a bugfix, or anything else that wants its own
branch, ask whether it should go in a worktree before making any change. The
usual answer is yes, so that is the one to offer first, but ask rather than
assume: a one-line fix is sometimes wanted on `main` in the primary checkout.

To move work already started on a branch in the primary checkout: commit it,
switch that checkout back to `main`, `git worktree add .claude/worktrees/<branch>
<branch>`, then work from that path.

## What it is

A Go binary that turns a JSON document into one self-contained HTML page, and
either serves it or writes it to a file. Everything interesting is in the page.

The Go side is four files, all `package main`:

| file | what it holds |
|---|---|
| `main.go` | the flag definitions, `reorderArgs`, and the flow of `main` |
| `check.go` | `check` and the error messages it builds for input that is not one well-formed JSON document |
| `serve.go` | the HTTP server, the `-C` close timer, and `openBrowser` |
| `page.go` | the embedded `web/*` assets, template assembly, and the comment stripper |

Each has a `_test.go` of its own along the same lines.

`page.go` assembles the page by substituting into a template built from `web/*`.
The document goes in as compact JSON inside `<script id="data">`; the tree is
built in the browser, not in Go. That is why `renderPage` is cheap on a 5MB
document and why the page scripts are where the work is.

There are two page builds. The default carries the jq engine; `--simple` leaves
it out. `script()` and `style()` in `page.go` pick the file list, and
`pageTemplate(jq)` caches one assembled template per state.

## The files in `web/`, and which build gets them

| file | ships in | what it is |
|---|---|---|
| `core.js` | both | parse, render, path text. No DOM, no jq. |
| `page.js` | both | the tree, text filter, path lookup, copy, folding, theme button |
| `theme.js` | both | runs in `<head>`, picks the palette before the body parses |
| `page.css` | both | the palette, both themes |
| `jq.js` | default only | the jq engine |
| `suggest.js` | default only | builds the queries a clicked line could mean, and the key completions of a half-typed one. No DOM. |
| `query.js` | default only | search box as a query, results view, suggestion list |
| `query.css` | default only | mode select, suggestion list, error box, results |

`web/browser-test` ships in nothing. It is the drivers, the harness they are
written against and the runner that loads them, and no rendered page has ever
seen any of it.

`page.js` must work with the other three absent. It calls `jqui()` when
`query.js` is there and falls back to path lookup when it is not. Anything that
reads the box as a query, or renders what a query produced, belongs in
`query.js`.

## The value model

`core.js` `parseJSON` produces nodes, not JavaScript values:

    {t:'o', k:[keys], v:[children]}
    {t:'a', v:[children]}
    {t:'l', r:<scalar>, n:<number as written>, h:<rendered html>}

It hand-parses rather than using `JSON.parse` because the tree shows keys in
document order and numbers exactly as written, and neither survives
`JSON.parse`.

**The jq engine works on that same node form.** That is the load-bearing
decision: a query result goes straight back to `renderTree` with key order and
number text intact, and the document is parsed once rather than twice. `r` is
what comparisons and arithmetic read; `leafOf` builds a node from a computed
scalar.

In `jq.js`, a stream is an array. Every jq expression maps one input to many
outputs, and an array makes `,`, `[]` and `select` fall out for free. Nothing
short-circuits as a result, so no builtin may produce an endless stream.

## Rules that bite

**The phone breakpoint is written twice.** `@media (max-width: 600px)` in
`page.css` hides the search box and the line buttons, and `page.js` runs
`matchMedia` on the same query to clear a search when the window crosses it.
Change one and change the other. `phone.js` runs at 500px, the narrowest window
headless Chrome opens, and `narrow.js` at 640px, so a breakpoint moved outside
that range fails one of them.

**Offline, always.** A rendered page is one file that has to work with no
network: no CDN, no web fonts, no remote images. The GitHub mark in the toolbar
is inline SVG for this reason. (The `--cdn` issue would change this on
purpose, for people who want the opposite.)

**No dependencies, either side.** `go.mod` requires nothing, there is no
`package.json`, and the JavaScript tests use Node's built-in runner. Anything
needing a build step would have to be committed as generated output.

**Stylesheets carry no comments.** Only the scripts are comment-stripped; CSS is
inlined as written, so a comment in `page.css` or `query.css` ships in every
page. `TestPageCarriesNoComments` fails when one does. Put the reasoning in
`CONTRIBUTING.md` instead.

**No trailing comment on a line containing `/` outside a string.**
`stripComments` gives up on such a line and emits it verbatim, comment and all,
because the `/` could open a regular expression. Regexes and division both trip
it. Comments go on their own line.

**Every colour is a custom property, defined in both palettes.** A literal
colour anywhere means one theme gets it wrong. Check the contrast ratio rather
than the look on one screen: dimming a grey with `opacity` once gave 1.6:1.

**`docs/index.html` is generated and committed.** It is `docs/k8s.json`
rendered, so regenerate it after any change under `web/`, with the command in
`CONTRIBUTING.md`.

**`docs/k8s.json` is the example document.** It is a generated `kubectl get all
-o json` listing, committed and served at https://zafnz.github.io/jqweb/k8s.json,
and the `curl` in `README.md` fetches it from there. Examples that need a
document use this one.

**Other sample documents are gitignored** — `simple.json`, `large.json`,
`wiki-rest.json`. They are scratch fixtures. A wide `git add` has swept one in
before.

**Every value-taking flag has to be in `valueFlags` in `main.go`**, or
`jqweb file.json --theme light` leaves `light` behind as a second input file.
`TestValueFlagsCoversTheCommandLine` fails when a flag and the map disagree.
The key is the name the `flag` package knows, without dashes: one dash and two
mean the same thing there, and `flagName` strips them so `-host` and `--host`
are one entry.

**`-OC` and `-CO` are flags, not bundling.** The `flag` package has no notion
of a bundle, so the one combination worth writing as a bundle is registered
under those two names and sets `open` and `closeOnGet` itself. No other pair
works: `-vO` is rejected as an unknown flag.

## Testing

`go test ./...` and `node --test` are what CI runs. Beyond that:

**The jq engine is checked against real jq.** `web/testdata/jq-corpus.json` holds
147 queries with the output jq itself gave for each; `node
web/testdata/regenerate.js` rewrites the answers and needs `jq` on the path. A
builtin with no case in the corpus fails the test that reads the table back out
of `jq.js`. When jq's behaviour is in question, run `jq` and find out — guessing
has been wrong about operator stream order, `"ab" * 0`, `max_by` ties and
`from_entries` key spellings.

**The browser drivers are in `web/browser-test`, and CI runs them.** `node
web/browser-test/run.js` is the whole suite, 441 checks in about 8 seconds.
`web/browser-test/README.md` is how it works and how to write one; read it
before adding a driver. `--screenshot=out.png` in place of `--dump-dom` is
still the way to look at a page by hand.

**Anything that only reproduces in a browser needs a driver before a fix.**
Three bugs this way were each different from what they looked like: typing `.`
scrolled halfway down because `.` resolves to the root and centring an element
taller than the window puts its middle in the middle; a suggestion beginning
with a name was text-searched because auto mode read the first character; the
line buttons were invisible in light mode at 1.6:1. All three have a driver on
them now, and reintroducing the first one fails `scroll.js` with the node
1803px off the top.

**Assert the property that matters, not a particular pixel.** Several drivers
failed first because the expectation was wrong and not the code. The toolbar
centres what is on a row, so items of different heights have different tops and
counting tops says every one of them wrapped. Hiding what did not match
shortens the document, so a text search that scrolls nowhere still ends at a
smaller `scrollY` than it started at.

**The contrast bar the drivers hold to is not the one the palette meets.** Six
colours land under 4.5:1 for words or 3:1 for shapes, and `contrast.js` holds
each to what it reaches today so a change that dims one further still fails.
The `BELOW` table in that file is what to delete as zafnz/jqweb#23 is worked
through.

## Working habits that have paid off

Measure before claiming. Page sizes, contrast ratios, load times and result
counts have all been surprising — the query engine costs 70KB, and the 700ms it
adds on a 4.8MB document is the second button on each of 173,000 lines rather
than the script.

Check the tool actually validates what you think. `goreleaser check` loads the
config into Go structs and accepts a YAML null where the published JSON schema
wants a string; the GitHub API endpoint for a branch's rules returns every rule
whether or not the caller can bypass it. Both looked like verification and were
not.
