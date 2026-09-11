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

## Releases

The release notes live in `.goreleaser.yaml` under `release.header`, and say
what that release changed rather than what the tool does. Rewrite them before
tagging and bump the `# notes-for:` marker above them to the version going out.
The tidiest moment for that is in the pull request that makes the change worth
releasing, rather than in one of its own afterwards: the notes have to be on
`main` before the tag is pushed, so leaving them costs an extra round trip
through review.
The release workflow compares that marker with the tag and refuses to publish
when they disagree, because nothing else can tell stale notes from fresh ones:
the tag builds, the binaries are fine, and the release page quietly tells
everyone upgrading that the last version's features are new again.

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
