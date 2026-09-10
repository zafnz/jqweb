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

## Prefer the exact line when nothing else narrows anything

Clicking a value like `.paths["/page/"].get.responses["200"].description`
offers a list where every reading returns one result. When they all return one,
the reading a person means is almost always the line itself, but it currently
sorts last. Rank the plain path first when nothing on the list narrows the
document down.

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

## Changing text in filter/search/jq box should delete dropdown

At the moment the dropdown doesn't disappear until you fully erase the text
box. but as soon as the user starts removing stuff the filter should go. 

## Error message shrinks text input

A long error message makes the text input shrink. Combined with the issue
above, there should be no way the dropdown can produce an error, so instead have
the error message appear hovering below the input. 

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

