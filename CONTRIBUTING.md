# Contributing

## Building and testing

    go build .                     # a jqweb binary in the working directory
    go test ./...                  # Go: argument handling, input validation, page assembly
    node --test                    # JavaScript: web/core.test.js, web/jq.test.js
    node web/browser-test/run.js   # the page in a browser (needs Chrome)

No dependencies, either side: `go.mod` requires nothing, there is no
`package.json`, and the JavaScript tests use the test runner built into Node
18 and later. Please keep it that way — `go install github.com/zafnz/jqweb@latest`
runs the Go toolchain and nothing else, so anything that needs a build step
would have to be committed as generated output. The browser drivers hold to
the same rule: they drive Chrome through its own command line rather than
through Playwright or Puppeteer.

CI runs the same four commands on every push, with the Go job against both
the `go.mod` floor and the current release. The two have disagreed before:
Go 1.27 changed `json.Decoder.More()` at the end of a truncated document,
which changed the error message a user sees.

## Colours

Every colour is a custom property on `:root` in `web/page.css`, defined twice:
once for dark and once under `:root[data-theme="light"]`. Adding a colour means
adding it to both, and using a literal anywhere means one theme gets it wrong.

`web/theme.js` runs in the head, before the body is parsed, so a page never
paints in one theme and swaps to the other. It reads `data-pref` -- which
`--theme` sets -- then the stored choice if there is one, resolves `auto`
against `prefers-color-scheme`, and writes `data-theme`, which is what the
stylesheet selects on.

## Testing changes to the page

The Go tests assert what page assembly must preserve — that every placeholder
is substituted, that the embedded document parses back to the input, that a
value containing `</script` cannot close the element holding it — rather than
comparing against a stored copy of a rendered page, which would need
regenerating for every change to the styling.

The Go and Node tests do not run the page in a browser. The drivers that do
are in `web/browser-test` and are documented there. CI runs them on every
push.

A driver only checks what it was written to check. For a change to the scripts
that should not have altered the rendering at all, diffing the whole tree
against a build from `main` covers the rest:

    go build -o /tmp/jqweb-new .
    git stash && go build -o /tmp/jqweb-old . && git stash pop
    echo '{"a":[1,2,{"b":"x<y"}]}' > /tmp/doc.json
    for v in old new; do
      /tmp/jqweb-$v -o /tmp/page-$v.html /tmp/doc.json
      chromium --headless --dump-dom "file:///tmp/page-$v.html" > /tmp/dom-$v.html
    done
    diff /tmp/dom-old.html /tmp/dom-new.html

The stylesheets carry no comments, because only the scripts are stripped: CSS
is inlined as written, so a comment in `page.css` or `query.css` ships in every
page. `TestPageCarriesNoComments` fails if one does.

`stripComments` gives up on any line where a `/` turns up outside a string
without a `*` after it, and emits that line exactly as written. Regular
expressions and division both trip it, so a comment at the end of such a line
would ship in every rendered page. Keep comments on their own line; the page
should carry none at all, which is what `TestPageCarriesNoComments` checks.

## Phone width

At 600px and below the page shows the tree, the fold button and the theme
button. The rule is `@media (max-width: 600px)` in `web/page.css`, and
`web/page.js` runs `matchMedia` on the same query, so the two have to agree.

The stylesheet hides the search box, the mode select, the count and the line
buttons rather than leaving them out of the markup, because a phone turned on
its side is wider than 600px and gets the full page back without a reload. The
script covers a window narrowed across the line with a search in the box: it
clears the search, since the filtered tree or the query results would
otherwise stay on screen with no box left to clear them from.

The breakpoint is 600 rather than a phone's own width because headless Chrome
will not open a window narrower than 500px, and a lower breakpoint could not be
driven. `phone.js` runs at 500 and `narrow.js` at 640, either side of it.
Phones in portrait are 430px and under.

## The jq subset

`web/jq.js` is the query engine, `web/suggest.js` builds the queries a line of
the document could have meant, `web/query.js` is the search box wiring that
drives both, and `web/query.css` styles what only they put on the page. Those
four are what `--simple` leaves out, so none of them costs
anything in a page built with it; `web/page.js` ships either way and works
without them, calling `jqui()` when it is there and falling back to the path
lookup when it is not. Anything that reads the box as a query, or renders what
one produced, belongs in `query.js` rather than `page.js`.

`suggest.js` is text in, text out -- segments and a parsed document give back
query strings -- so `web/suggest.test.js` can check it without a browser. The
test that matters most runs every query it offers for every line of a fixture
and fails if any of them will not compile or will not run: a suggestion that
errors is worse than no suggestion, and the shapes that cause one are easy to
miss by hand.

The engine works on the same node form `core.js` builds for rendering, so a
result goes straight back to `renderTree` with key order and number text intact
and the document is parsed once; scalars come from the `r` field on a leaf.

Its answers are checked against jq itself rather than against what anyone
believed jq does. `web/testdata/jq-corpus.json` holds a fixture document, a
list of queries and the output jq gave for each, and `web/jq.test.js` runs
every one through the engine. After adding a query, or after a jq upgrade whose
behaviour the tests should follow:

    node web/testdata/regenerate.js

That needs `jq` on the path. CI has none, which is why the answers are
committed rather than worked out while the tests run. A builtin with no case in
the corpus fails the test that reads the table back out of `jq.js`, so adding
one means adding a query for it.

## The example page

`docs/index.html` is a rendered page committed for GitHub Pages, and it does
not regenerate itself. After a change to the scripts or the styling it is
stale until someone rebuilds it. Build it the default way, so
that the page people are pointed at is the one they will get. The input file
name sets the page title, so build from `docs/k8s.json` where it sits:

    go build -o jqweb . && ./jqweb -o docs/index.html docs/k8s.json

`docs/k8s.json` is the document that page shows: a `kubectl get all -o json`
listing, generated rather than taken from a real cluster. GitHub Pages serves
it at https://zafnz.github.io/jqweb/k8s.json, which is what the `curl` in
`README.md` fetches, so changing the file changes both the example page and
the first command a reader runs.

## Bugs and wanted features

Both go in the issue tracker at https://github.com/zafnz/jqweb/issues. File one
rather than leaving a comment in the code for a change nobody has scheduled.
`TODO.md` holds the entries that were filed as issues and is not where new ones
go.

## Pull requests

Before merging, read the pull request's commit list as part of the review. A
merge commit is useful when the branch tells a coherent story, but fixup,
squash or reword any "try again" commits before the merge so `main` keeps that
story rather than the noise from getting there.

## Releases

The release notes live in `CHANGELOG.md`, in the form described at
https://keepachangelog.com/en/1.1.0/. A pull request that changes what someone
using jqweb sees adds its own section under `## [Unreleased]`, written for
someone upgrading rather than as a summary of the diff. A version heading is
`## [0.6.0] - 2026-09-11`, so the headings within an entry start at `###`;
they say what changed, in place of the Added/Changed/Fixed categories Keep a
Changelog suggests. Writing the entry in the pull request that earns it is what
keeps the notes on `main` before the tag is pushed, rather than costing a round
trip through review of their own.

Labels decide which pull requests have to carry one. `accessibility`, `bug`,
`functionality` and `optimisation` require an entry, and `.github/workflows/pr.yml`
fails a pull request without one; `no-changelog` overrides that, for a change
those labels fit but a reader of the release notes would not. Nothing stops any
other pull request carrying an entry, and a `toolchain` change that someone
upgrading would notice should have one. Every pull request needs at least one
label, which is what keeps a change that wants an entry from arriving
unlabelled and unasked.

Releasing renames `## [Unreleased]` to the version and the date, opens an empty
`## [Unreleased]` above it, and updates the link definitions at the foot of the
file. The release workflow extracts the section for the tag with awk and hands
it to GoReleaser as `--release-header`, which puts it above the commit list on
the release page. That step fails the run when the section is missing or empty,
because GoReleaser does not: an empty header is a warning it publishes through,
and the release page would tell everyone upgrading nothing at all.

Apple's notary service is the one part of a release that is neither ours nor
reliable, and a release that trips over it publishes nothing: notarising
happens several steps before publishing, so the run dies with no release, no
assets and no tap commit. The workflow retries the whole command after 5, 10
and 20 minutes when the failure mentions the notary service, and fails on the
spot when it does not, so a genuine build error is not repeated four times over
half an hour. Set the `NOTARY_RETRY_DELAYS` repository variable to change the
waits, or to shorten them while testing the retrying itself.

Tagging `v*` runs GoReleaser, which builds for macOS, Linux and Windows, signs
and notarizes the macOS binaries, and updates the Homebrew tap. Nothing else
should need doing by hand.
