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

## How the page is put together

A rendered page is one self-contained HTML file with the document embedded in
it as JSON. Nothing is fetched, so it works from a `file://` URL, off a USB
stick, or attached to a ticket.

    web/page.html    the shell, with {{TITLE}} {{DATA}} {{STYLE}} {{SCRIPT}}
    web/page.css     styling
    web/core.js      parser, HTML renderer, path reader -- no DOM
    web/page.js      the DOM wiring on top of core.js

All four are pulled in with `go:embed`. At startup `buildTemplate()`
substitutes the stylesheet and the scripts into the shell once; `renderPage()`
then fills in `{{TITLE}}` and `{{DATA}}` per document. Substitution is a
single pass, so a document that happens to contain `{{TITLE}}` is left as the
data it is.

Two things happen to the scripts on the way in. They are concatenated,
`core.js` first, since `page.js` reads the `jqweb` global that `core.js`
defines. And their comments are stripped, so the source can explain itself
without every reader of a rendered page paying for it.

### Why core.js has no DOM in it

`core.js` is where the parts worth testing live, and keeping the DOM out of it
means Node can load it directly — no jsdom, no bundler, no browser. If you add
something with no need for the DOM, it belongs there, and it should arrive
with tests. `page.js` is for the parts that genuinely need a document.

### Why the tree is built from strings

`renderTree()` returns markup, which `page.js` assigns to `innerHTML` in one
write, rather than building nodes with `createElement`. For a large document
that is around twice as fast, and it is what keeps the renderer free of the
DOM. The cost is that escaping is a discipline: everything taken from the
document goes through `esc()` on its way into markup, attributes included.

### Why the JSON is parsed by hand

`JSON.parse` sorts nothing and normalizes numbers, and the tree wants neither:
object keys are shown in document order, and numbers exactly as written, so
`1.0` and `1e5` and a 30-digit integer survive the round trip. The parser in
`core.js` does no validation, because the Go side has already rejected
anything that is not a single well-formed JSON document.

## Conventions

Run `gofmt` — CI fails on anything it would reformat. The JavaScript is ES5
in style (`var`, `function`), which is deliberate: it runs as-is in a browser
with no transpiling, and there is nothing to build.

Comments are for someone who did not write the code. Every function says what
it is for, and the ones doing something non-obvious say how they work. Since
the comments never reach the rendered page, there is no reason to be terse.

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
