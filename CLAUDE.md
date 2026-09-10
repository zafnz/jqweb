# Notes for Claude

`README.md` is what jqweb does. `CONTRIBUTING.md` is how to build, test and
release it. This is the part that is neither: what the thing is made of, and
the rules that are not obvious from reading one file at a time.

## Where the work is tracked

Bugs, wanted features and anything else not being worked on right now are
GitHub issues on `zafnz/jqweb`. `gh issue list` for what is open, `gh issue
create` to file one. `TODO.md` holds the entries that were filed as issues and
is not where new ones go.

When someone asks for something to be added to the TODO without saying where,
ask whether they want an issue filed or just a note kept for the rest of the
session.

## What it is

A Go binary that turns a JSON document into one self-contained HTML page, and
either serves it or writes it to a file. Everything interesting is in the page.

`main.go` does argument handling, validates the input, and assembles the page by
substituting into a template built from `web/*`. The document goes in as compact
JSON inside `<script id="data">`; the tree is built in the browser, not in Go.
That is why `renderPage` is cheap on a 5MB document and why the page scripts are
where the work is.

There are two page builds. The default carries the jq engine; `--simple` leaves
it out. `script()` and `style()` in `main.go` pick the file list, and
`pageTemplate(jq)` caches one assembled template per state.

## The files in `web/`, and which build gets them

| file | ships in | what it is |
|---|---|---|
| `core.js` | both | parse, render, path text. No DOM, no jq. |
| `page.js` | both | the tree, text filter, path lookup, copy, folding, theme button |
| `theme.js` | both | runs in `<head>`, picks the palette before the body parses |
| `page.css` | both | the palette, both themes |
| `jq.js` | default only | the jq engine |
| `suggest.js` | default only | builds the queries a clicked line could mean. No DOM. |
| `query.js` | default only | search box as a query, results view, suggestion list |
| `query.css` | default only | mode select, suggestion list, error box, results |

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

**`docs/index.html` is generated and committed.** Regenerate it after any change
under `web/`, with the command in `CONTRIBUTING.md`.

**Sample documents are gitignored** — `simple.json`, `large.json`,
`wiki-rest.json`. They are scratch fixtures. A wide `git add` has swept one in
before.

**`reorderArgs` in `main.go` needs to know about every value-taking flag**, or
`jqweb file.json --theme light` puts the value in the wrong place. It also does
not split bundled short flags, so `-OC` is read as one flag named `OC`.

## Testing

`go test ./...` and `node --test` are what CI runs. Beyond that:

**The jq engine is checked against real jq.** `web/testdata/jq-corpus.json` holds
147 queries with the output jq itself gave for each; `node
web/testdata/regenerate.js` rewrites the answers and needs `jq` on the path. A
builtin with no case in the corpus fails the test that reads the table back out
of `jq.js`. When jq's behaviour is in question, run `jq` and find out — guessing
has been wrong about operator stream order, `"ab" * 0`, `max_by` ties and
`from_entries` key spellings.

**Nothing in CI drives a browser, and no driver is kept in the repo.** The ones
used so far were written per session and thrown away, so do not go looking for
them. The page can be driven headlessly, and it is worth doing for anything that
touches the DOM:

    # inject a script that writes its findings into <pre id="report">
    python3 -c "page=open('page.html').read(); d=open('driver.js').read();
      open('run.html','w').write(page.replace('</body>','<script>'+d+'</script></body>'))"
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
      --disable-gpu --window-size=1200,800 --virtual-time-budget=30000 \
      --dump-dom "file:///tmp/run.html"

`--screenshot=out.png` instead of `--dump-dom` for a look at it. This is how the
scroll bug, the icon alignment and the contrast were all settled. Assert the
property that matters, not a particular pixel: several drivers failed first
because the expectation was wrong, not the code.

**Anything that only reproduces in a browser needs a driver before a fix.**
Three bugs this way were each different from what they looked like: typing `.`
scrolled halfway down because `.` resolves to the root and centring an element
taller than the window puts its middle in the middle; a suggestion beginning
with a name was text-searched because auto mode read the first character; the
line buttons were invisible in light mode at 1.6:1.

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
