# TODO

Things worth doing, not being done yet. Newest at the bottom.

## The filter button disappears in the result view

After a query runs, its output replaces the document and the lines lose their
filter button, with nothing saying why. The reason is that a result's path is
relative to the result rather than to the document, so any query built from one
would be wrong. Keeping the button means tracking each output back to where it
came from, which is what jq's `path()` does and what this engine does not.
Chaining filters falls out of the same work.

## One button for expand and collapse

Expand all and Collapse all are two buttons on the left of the toolbar. Make
them one button that toggles, and move it to the right.

## Let the search box fill the toolbar

It is capped at 420px and the toolbar has room to spare.

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

## The line buttons are too faint

The copy and filter buttons sit at 35% opacity until the line is hovered, which
is too little to notice in either theme and worst in light, where a grey glyph
on near-white all but disappears. They need to read as available without
crowding the value they sit next to.

## Quit once the page has been fetched

`jqweb file.json` serves until Ctrl-C, which is a nuisance for the common case
of looking at a document once. Exit shortly after the first successful GET of
`/` -- half a second or so, enough for the browser to have the whole response.
`-A|--auto` for it, or make it the default and add `--no-close`; the second is
friendlier and the bigger change to what people already expect. Either way it
has to stay off when `-p` was given explicitly, since naming a port says the
page is meant to be visited more than once.
