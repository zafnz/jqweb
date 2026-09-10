# Contributing

## Building and testing

    go build .        # a jqweb binary in the working directory
    go test ./...     # Go: argument handling, input validation, page assembly
    node --test       # JavaScript: web/core.test.js

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

## The example page

`docs/index.html` is a rendered page committed for GitHub Pages, and it does
not regenerate itself. After a change to the scripts or the styling it is
stale until someone rebuilds it. The file name sets the page title, so keep
it:

    curl -s 'https://en.wikipedia.org/api/rest_v1/?spec' > wikipedia-reset-spec.json
    go build -o jqweb . && ./jqweb -o docs/index.html wikipedia-reset-spec.json

## Releases

Tagging `v*` runs GoReleaser, which builds for macOS, Linux and Windows, signs
and notarizes the macOS binaries, and updates the Homebrew tap. Nothing else
should need doing by hand.
