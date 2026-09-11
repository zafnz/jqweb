# Browser drivers

Tests for the part of the page that only exists in a browser: the tree, the
search box, queries and their errors, the suggestion list, folding, scrolling,
the toolbar and the two palettes. Nothing in this directory ships in a
rendered page.

    node web/browser-test/run.js                # every driver
    node web/browser-test/run.js suggest theme  # just those two
    node web/browser-test/run.js --keep         # leave the pages that ran behind

`run.js` builds jqweb, renders the pages the drivers ask for, injects
`harness.js` and one driver into each, loads it in headless Chrome with
`--dump-dom`, and reads the findings out of the `<pre id="report">` the harness
leaves in the page. Chrome comes from `$CHROME`, or from the usual places on
macOS and Linux. There is no npm package behind any of it.

CI runs them in a job of its own, with no install step: the GitHub runner
image ships Chrome.

## Writing a driver

A driver is one file in `drivers/`, named for the area it covers. Its opening
comment says which page it wants:

    /* page: simple, window: 460x800 */
    T.run(async (t) => {
      t.eq('the mode select stays hidden', t.$('#mode').hidden, true);
    });

The pages are `default` (the fixture built the default way), `simple`
(`--simple`), `light` (`--theme light`) and `docs` (`docs/index.html` as
committed). A driver naming none of them gets `default`. Each page is rendered
once and shared by every driver that asks for it.

`window:` is optional and defaults to 1200x800. Only the toolbar drivers set
it, because a toolbar with no room cannot be driven in a window that has room.

The fixture is `testdata/doc.json`: ten records with repeated fields, so a
suggestion has something to pivot on, and long enough that the page scrolls.

## The harness

| | |
|---|---|
| `check` `eq` `ne` `has` `atLeast` `atMost` `near` `note` | record a finding |
| `$` `$$` `at` `shown` `text` `visible` `rows` | find things |
| `click` `clickAway` `type` `press` `mode` `refocus` `sleep` | drive them |
| `contrast` `ratio` `rgba` `bg` `paint` | colour |

`t.at('.a.b[0]')` walks the rendered tree by the data attributes `emit()`
wrote, so a driver can name a line by its path instead of by where it sits in
the markup.

`t.contrast(el)` composites the element's colour and everything behind it
before working out the ratio, so a translucent wash such as `--hit` counts
towards what a reader actually sees.

Actions wait 400ms afterwards, which covers the 120ms the search box waits for
a pause in typing. Virtual time makes that wait free.

## How it runs

Chrome gets `--virtual-time-budget`, so the page's own waits cost nothing: the
120ms debounce on the search box and the 900ms a copy button stays ticked both
pass instantly, and the whole suite takes about 8 seconds.

Virtual time stops while a network fetch is outstanding. A profile Chrome has
not seen before sends it looking for sign-in, extension updates and default
apps, and those requests hold the clock still until the run is killed, leaving
a page that dumps with no report in it. The flags in `chromeArgs` turn all of
that off.

Each driver gets a profile of its own. Every page here is a `file://` URL and
they all count as one origin, so a shared profile hands one driver the theme
the last one stored.

Chrome is killed as soon as `</html>` arrives rather than waited on. It does
not reliably exit after a dump, and on macOS it starts an updater that
inherits the pipes. Waiting for either the process or stdout to close was 90
seconds per driver on a page that had finished in one.

The findings travel out of the page as base64 because `--dump-dom` serialises
the page as HTML, and a failure message is free to contain angle brackets.

About one Chrome start in forty hangs before loading anything, with four of
them going at once and each on a profile it has never seen before. It is not
particular to any driver, and it dumps nothing at all rather than something
partial, so a start that produces no DOM is made again up to three times
before it is called a failure. A driver that needed more than one says so in
the output; if that starts happening often, the number to look at is there
rather than hidden.

## When one fails

`--keep` leaves each page behind as one file holding the document, the harness
and the driver, so a failing check can be opened in a browser and watched. CI
uploads those as an artifact when the job fails.

Assert the property that matters rather than a particular pixel. Several of
these drivers failed first because the expectation was wrong and not the code.
The toolbar centres what is on a row, so items of different heights have
different tops, and counting tops says every one of them wrapped. Hiding what
did not match shortens the document, so a text search that scrolls nowhere
still ends at a smaller `scrollY` than it started at.

## Contrast

`contrast.js` holds words to 4.5:1 and shapes to 3:1. Six colours in the
palette do not reach that. Each is pinned to the ratio it reaches today in the
`BELOW` table in that file, so a change that dims one further still fails.
Raising them is tracked in zafnz/jqweb#23, and that table is what to delete as
it is worked through.
