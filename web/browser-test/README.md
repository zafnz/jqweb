# Browser tests

Tests for the part of the page that only exists in a browser: the tree, the
search box, queries and their errors, the suggestion list, folding, scrolling,
the toolbar and the two palettes. Nothing in this directory ships in a rendered
page.

    npm --prefix web run test:browser                    # every spec
    npm --prefix web run test:browser -- suggest theme   # just those two
    npm --prefix web run test:browser -- --headed        # watch it happen
    npm --prefix web run test:browser -- --debug         # step through one

Playwright Test drives Google Chrome, the one already installed rather than a
downloaded copy, so `npm ci` is the whole install. CI runs the suite in a job of
its own; the runner image ships Chrome.

`global-setup.js` builds jqweb and renders the pages once per run into `.out`,
which is not committed. `.out` also holds the traces and screenshots a failure
leaves behind.

## Writing a spec

A spec is one file in `specs/`, named for the area it covers. `test.use` says
which page it wants and how big a window to open it in:

    import { test, expect } from '../fixtures.js';

    test.use({ variant: 'simple', viewport: { width: 460, height: 800 } });

    test('the mode select stays hidden', async ({ page }) => {
      expect.soft(await page.evaluate(() => __t.$('#mode').hidden),
        'the mode select stays hidden').toBe(true);
    });

The variants are `default` (the fixture built the default way), `simple`
(`--simple`), `light` (`--theme light`), `query` (opening on the query
`.items[] | .metadata.name`), `simplequery` (`--simple`, opening on
`.items[3]`) and `docs` (`docs/index.html` as committed). A spec naming none of
them gets `default`, and a window of 1200x800.

`address` is the third option. Whatever it holds is added after the page's file
name in the address, so `test.use({ address: '?q=keys' })` is how a spec checks
what the page reads out of its own URL.

The fixture document is `testdata/doc.json`: ten records with repeated fields,
so a suggestion has something to pivot on, and long enough that the page
scrolls.

## Measuring, and asserting

Anything that has to look at computed style, composite a colour or measure a
box happens inside `page.evaluate`, where `__t` is the set of helpers in
`helpers.js`:

| | |
|---|---|
| `$` `$$` `at` `shown` `text` `visible` | find things |
| `box` `rows` | measure them |
| `contrast` `ratio` `rgba` `bg` `prop` `customProps` `paint` | colour |

Elements move around freely inside such a body; only what the body returns has
to survive the trip out, so return numbers, strings and objects of them and
assert on those.

`expect.soft` is what the checks use. A hard `expect` stops the test at the
first failure, which for a spec measuring 30 things means finding out about one
of them per run.

`fixtures.js` also exports the actions that need more than one step: `type`,
`settle`, `clickAway`, `refocus` and `near`.

`at=` is a selector engine, so a line of the document can be named by its jq
path and driven like anything else:

    await page.locator('at=.items[0].kind').locator('> .line > .fq').click();

## The clock

`page.clock.install()` runs before the page loads, and `settle(page)` winds it
forward. The 120ms the search box waits for a pause in typing and the 900ms a
copy button stays ticked both pass instantly, and the suite takes about nine
seconds.

Winding the clock is not optional after an action that comes back on a timer.
Without it the debounce never fires and the box appears not to have searched.

## Events are real

Playwright presses keys and clicks through the browser's input pipeline rather
than dispatching synthetic events, so the browser's own editing behaviour
happens too. That is a difference from the drivers this replaced, and it is the
point: a synthetic `keydown` runs the page's listeners and nothing else.

One check changed meaning because of it. Typing `/` into the search box used to
be asserted as leaving the box empty, which was only true because a synthetic
key press inserts no text; the spec now asserts that the `/` arrives in the box,
which is what "not swallowed by the shortcut" means for a real one.

One found a defect. `Escape` is meant to put the suggestion list away and leave
the box alone, and Chrome empties an `input` of `type=search` on `Escape` before
any of that. See `suggest.spec.js` and zafnz/jqweb#61.

## When one fails

The trace is the whole run: every action, the DOM at each one, the console and
the network.

    npx playwright show-trace web/browser-test/.out/results/<test>/trace.zip

The rendered pages stay in `.out/pages`, so the page a spec was driving can be
opened in a browser directly. CI uploads both when the job fails.

There are no retries, and there should not be. A test that only passes
sometimes is a finding about the page or about the test, and a second attempt
answers neither.

Assert the property that matters rather than a particular pixel. Several of
these failed first because the expectation was wrong and not the code. The
toolbar centres what is on a row, so items of different heights have different
tops, and counting tops says every one of them wrapped. Hiding what did not
match shortens the document, so a text search that scrolls nowhere still ends at
a smaller `scrollY` than it started at.

## Contrast

`contrast.spec.js` holds words to 4.5:1 and shapes to 3:1. Six colours in the
palette do not reach that. Each is pinned to the ratio it reaches today in the
`BELOW` table in that file, so a change that dims one further still fails.
Raising them is tracked in zafnz/jqweb#23, and that table is what to delete as
it is worked through.
