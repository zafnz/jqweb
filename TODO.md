# TODO

Things worth doing, not being done yet. Newest at the bottom.

## The filter button disappears in the result view

After a query runs, its output replaces the document and the lines lose their
filter button, with nothing saying why. The reason is that a result's path is
relative to the result rather than to the document, so any query built from one
would be wrong. Keeping the button means tracking each output back to where it
came from, which is what jq's `path()` does and what this engine does not.
Chaining filters falls out of the same work.

## --cdn mode

Render the page with its CSS and JavaScript referenced from
https://zafnz.github.io/jqweb/ rather than inlined, for people who would rather
have a small file than a self-contained one. Needs the assets published there
under a versioned path, and a decision about what a page does when the CDN is
unreachable.

## Quit once the page has been fetched

`jqweb file.json` serves until Ctrl-C, which is a nuisance for the common case
of looking at a document once. `-C|--close` for it, off by default: this
changes when the process exits, which is the kind of thing that surprises
people mid-task, so it should be asked for rather than assumed.

`-OC` -- open the browser and quit once it has the page -- is the combination
worth designing for. Go's `flag` package does not bundle short flags, so `-OC`
is read as one flag named `OC` and rejected; `reorderArgs` would have to split
a run of single-letter flags before parsing.

Exiting on the first GET of `/` is the obvious rule and a weak one. The page is
one self-contained file with no subresources, so exactly one GET happens per
view, which is what makes it tempting -- but a reload is a second view, and by
then the server is gone, so the fix for the problem is the thing that is
broken. Prefetch, link scanners and corporate proxies all issue GETs of their
own and would end the server before anyone saw the page.

Waiting for an idle period with no requests, rather than for the first one,
survives all of that. Holding a connection open and exiting when it drops --
what dev servers do -- is better still and tells you the tab actually closed.

## One hover button instead of one per line

Each line carries its own copy and filter buttons, so a document renders twice
the buttons it used to. On large.json -- 4.8MB, 173,000 lines -- that is 57.9MB
of markup instead of 47.2MB, and the browser takes about 700ms longer to build
the tree: 4.3s against 5.0s. Building the string costs 14ms of that; the rest
is the DOM.

One button element moved to whichever line is hovered would cost nothing per
line and would make every page faster than it is today, not just undo the
difference. It changes how the buttons behave on touch, where there is no
hover, so that needs an answer first.

## Keep the browser drivers

Every bug in the page so far has been settled by driving it headlessly, and
none of those drivers survive: they were written into a temporary directory a
session at a time and thrown away. The last set was fourteen of them, 194
checks, covering the suggestion list, the search box, query errors, the fold
button, toolbar widths, themes and contrast ratios, scrolling, the `--simple`
page and the committed `docs/index.html`. `go test` and `node --test` cannot
see any of it, so nothing catches a regression in the half of this project that
only exists in a browser.

The technique is written down in `CLAUDE.md`: inject a script into a rendered
page that writes its findings into a `<pre id="report">`, load it with Chrome's
`--headless --dump-dom`, and read the block back out. It needs no npm packages,
which is what makes it usable here where Playwright or Puppeteer would not be.

What needs deciding is where they live and how they run. Somewhere like
`web/browser/*.js` with a small runner, so that a person can run the lot with
one command. GitHub's ubuntu runners ship Chrome, so CI could run them too,
which is the point of keeping them.

## Split main.go

721 lines in one file, in four parts that barely refer to each other: the flags
and the flow of `main`, JSON validation and its error messages (`check` through
`lineCol`, about 270 lines and by far the largest part), the HTTP server and
opening a browser, and page assembly with the comment stripper.

Everything is `package main`, so this is moving functions between files rather
than designing anything: something like `check.go`, `serve.go` and `page.go`
alongside a `main.go` that is only argument handling. `main_test.go` is 483
lines and would divide along the same lines.

