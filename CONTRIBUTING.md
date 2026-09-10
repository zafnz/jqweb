# Contributing

## Building and testing

    go build .        # a jqweb binary in the working directory
    go test ./...     # Go: argument handling, input validation, page assembly
    node --test       # JavaScript: web/core.test.js, web/jq.test.js

No dependencies, either side: `go.mod` requires nothing, there is no
`package.json`, and the JavaScript tests use the test runner built into Node
18 and later. Please keep it that way — `go install github.com/zafnz/jqweb@latest`
runs the Go toolchain and nothing else, so anything that needs a build step
would have to be committed as generated output.

CI runs the same three commands on every push, with the Go job against both
the `go.mod` floor and the current release. The two have disagreed before:
Go 1.27 changed `json.Decoder.More()` at the end of a truncated document,
which changed the error message a user sees.

## Testing changes to the page

The Go tests assert what page assembly must preserve — that every placeholder
is substituted, that the embedded document parses back to the input, that a
value containing `</script` cannot close the element holding it — rather than
comparing against a stored copy of a rendered page, which would need
regenerating for every change to the styling.

Neither those nor the Node tests run the page in a browser. When you change
the scripts, it is worth rendering a document and diffing the resulting tree
against a build from `main`:

    go build -o /tmp/jqweb-new .
    git stash && go build -o /tmp/jqweb-old . && git stash pop
    echo '{"a":[1,2,{"b":"x<y"}]}' > /tmp/doc.json
    for v in old new; do
      /tmp/jqweb-$v -o /tmp/page-$v.html /tmp/doc.json
      chromium --headless --dump-dom "file:///tmp/page-$v.html" > /tmp/dom-$v.html
    done
    diff /tmp/dom-old.html /tmp/dom-new.html

A static dump only covers rendering. Searching, filtering, collapsing and
copy-path need driving, which means a browser automation tool; there is no
such test in CI today.

The stylesheets carry no comments, because only the scripts are stripped: CSS
is inlined as written, so a comment in `page.css` or `query.css` ships in every
page. `TestPageCarriesNoComments` fails if one does.

`stripComments` gives up on any line where a `/` turns up outside a string
without a `*` after it, and emits that line exactly as written. Regular
expressions and division both trip it, so a comment at the end of such a line
would ship in every rendered page. Keep comments on their own line; the page
should carry none at all, which is what `TestPageCarriesNoComments` checks.

## The jq subset

`web/jq.js` is the query engine, `web/suggest.js` builds the queries a line of
the document could have meant, `web/query.js` is the search box wiring that
drives both, and `web/query.css` styles what only they put on the page. All
four are inlined only when `--jq` is given, so none of them
costs anything in a default page; `web/page.js` ships either way and works
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
stale until someone rebuilds it. It is built without `--jq`, matching the
default. The file name sets the page title, so keep it:

    curl -s 'https://en.wikipedia.org/api/rest_v1/?spec' > wikipedia-reset-spec.json
    go build -o jqweb . && ./jqweb -o docs/index.html wikipedia-reset-spec.json

## Releases

Tagging `v*` runs GoReleaser, which builds for macOS, Linux and Windows, signs
and notarizes the macOS binaries, and updates the Homebrew tap. Nothing else
should need doing by hand.
