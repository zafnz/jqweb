![Release](https://github.com/zafnz/jqweb/workflows/release/badge.svg)
![GitHub Release](https://img.shields.io/github/v/release/zafnz/jqweb)
![GitHub Issues](https://img.shields.io/github/issues/zafnz/jqweb)
![GitHub License](https://img.shields.io/github/license/zafnz/jqweb)

# jqweb
Renders json like jq, but as a webpage

## Install

    brew install zafnz/tap/jqweb              # macOS
    go install github.com/zafnz/jqweb@latest  # with Go installed

On Linux, or macOS without Homebrew, this puts the latest release in
`~/.local/bin`:

    curl -fsSL https://raw.githubusercontent.com/zafnz/jqweb/main/install.sh | sh

Or download a binary for macOS, Linux or Windows from
[Releases](https://github.com/zafnz/jqweb/releases) and put it on your `$PATH`.
The macOS builds are signed and notarized.

## Example Usage

**Quick view of json output. (See screenshot below, or <a href="https://zafnz.github.io/jqweb/">view here</a>)**

```
$ curl -s https://zafnz.github.io/jqweb/k8s.json | jqweb
jqweb: serving on http://127.0.0.1:52748/ (Ctrl-C to stop)
```

<img src="demo.png" alt="jqweb rendering the Wikipedia REST API spec" width="580">

You can also use -O (or --open) to automatically open your 
default web browser
```
jqweb -O < myfile.json
```

Add -C (or --close) and jqweb stops once the browser has the page, instead of
serving until Ctrl-C. -OC does both:
```
jqweb -OC myfile.json
```


**Output to an html file for offline viewing**
```bash
$ kubectl get pods -o json | jqweb -o k8s.html
# Saves k8s.html for offline viewing
```

<br clear="right">

## Usage
usage: `jqweb [-p|--port <port>] [--host <ip>] [-o|--output <file>] [-O|--open] [-C|--close] [--simple] [--theme <name>] [<input-file>]`

Reads JSON from <input-file> ("-" or absent: stdin) and renders it as a
self-contained interactive HTML page, served on a random port or written to file
```
  -p, --port <port>    serve the page on http://<host>:<port>/
      --host <ip>      bind address for -p (default 127.0.0.1)
  -o, --output <file>  write the page to <file>; "-" writes to stdout
  -O, --open           opens your default web browser with the output
  -C, --close          stop serving once the page has been fetched
      --close-delay <d>  how long after the last fetch -C waits, such as
                       500ms or 5s (default 1s); giving it turns on -C
      --simple         leave out the jq query engine, for a smaller page
      --theme <name>   light, dark, or auto to follow the reader's system
```
With no -p and no -o, it listens on a random available port.

`-C` waits out `--close-delay` after the *last* fetch of the page rather than
exiting on the first one. Every fetch restarts the timer, so a reload or a
second tab keeps the server up, and a prefetcher or link scanner that gets
there first extends the wait instead of ending it.


## Search

The search box filters keys and values as you type, and also accepts a jq-style
path. Paste `.list.of.things[302].item`, or any prefix of it such as
`.list.of.things`, and the page shows that node with everything under it. The
copy button on each line puts that line's path on the clipboard, so a copied
path can be pasted straight back into the box.

## jq queries

The search box answers jq queries as well as filtering text:

```
.items[] | select(.status.phase == "Running") | .metadata.name
[.users[] | {name, admin: (.user.username == "admin")}] | sort_by(.name)
.. | objects | select(has("error"))
```

A query whose output is not part of the document -- anything with `map`,
`keys`, `to_entries` or a constructed object in it -- replaces the tree with
its results, numbered down the left. A query that only walks down, such as
`.a.b[3]`, still highlights that node in the document, the way a pasted path
always has.

The dropdown decides how the box is read: `Auto`, `Text` or `jq`. On `Auto`
anything starting with `.` `[` `(` `$` or `|` is a query and anything else is
text to find, so typing a word still searches; `jq` forces a query, which is
how to run a bare-word one such as `keys`.

This is a subset of jq, not all of it. Paths, `[]`, slices, `|`, `,`, `//`,
`?`, comparisons, arithmetic, `if/then/elif/else/end`, array and object
construction, and around 100 builtins:

- **picking things out** — `select`, `map`, `map_values`, `keys`, `length`,
  `type`, `has`, `in`, `contains`, `inside`, `any`, `all`, `first`, `last`,
  `limit`, `range`, `recurse`, `walk`, `paths`, `getpath`, `isempty`,
  `while`, `until`
- **rearranging** — `to_entries`, `from_entries`, `with_entries`, `add`,
  `sort`, `sort_by`, `group_by`, `unique`, `unique_by`, `min_by`, `max_by`,
  `flatten`, `reverse`, `join`, `split`
- **text** — `test`, `match`, `capture`, `scan`, `splits`, `sub`, `gsub`,
  `startswith`, `endswith`, `ltrimstr`, `rtrimstr`, `ascii_downcase`,
  `ascii_upcase`, `explode`, `implode`, `index`, `rindex`, `indices`
- **converting** — `tostring`, `tonumber`, `tojson`, `fromjson`, and the
  format strings `@text`, `@json`, `@csv`, `@tsv`, `@uri`, `@html`, `@sh`,
  `@base64`, `@base64d`
- **dates** — `now`, `todate`, `fromdate`, `gmtime`, `mktime`, `strftime`
- **numbers** — `floor`, `ceil`, `round`, `fabs`, `sqrt`, `pow`, `log`,
  `log2`, `log10`, `exp`, `exp2`, `exp10`, `trunc`
- the type filters — `arrays`, `objects`, `strings`, `numbers`, `booleans`,
  `nulls`, `iterables`, `scalars`, `values`

Two things differ from jq on purpose. Regular expressions are JavaScript's
rather than Oniguruma's, which part ways in the corners. `index` and `indices`
count characters into a string, where jq counts UTF-8 bytes; jq's own slices
count characters, so in jq `.[index("x"):]` cuts in the wrong place as soon as
the text before the match is not all ASCII. Pure ASCII behaves identically
either way.

Variables and `as`, `def`, `reduce`, `foreach`, `try`/`catch` and string
interpolation are not there. Neither is anything that edits a document --
assignment, `del`, `setpath` -- since the page is for reading one. A query
using any of them says so by name instead of guessing at what it meant.

`--simple` leaves the engine out, for a page that is about 70KB smaller and
does nothing but browse, filter and look up paths.

## Filtering on a value

Every line of the document has two buttons. `&#x29C9;` puts that line's path on
the clipboard. `&#x2261;` fills the search box with a query built from that line
and drops down the other queries the line could have meant, each labelled with
what it returns.

Which one you want is a judgement about the document, not something that can be
read off the path. Standing on `"Page content"` in `.paths["/page/"].get.tags[0]`
of an OpenAPI spec you might mean that tag, or the operations on that path
carrying it, or every path in the document that does, so all of them are
offered, most results first:

```
.paths | with_entries(select(.value.get.tags? | index("Page content")?))   14 keys
.paths[] | .[]? | select(.tags? | index("Page content")?)                  14 results
.. | objects | select(.tags? | index("Page content")?)                     14 results
.paths["/page/"].get.tags[] | select(. == "Page content")                   1 result
.paths["/page/"].get.tags[0]                                               1 result
```

14 against 1 tells you which reading you meant without your having to work out
the jq. Click a row to run it, or arrow up and down through them; the list
stays open, so trying the next one is a keystroke. The `&#x29C9;` on a row
copies that query. Clicking elsewhere puts the list away, and clicking back
into the box brings it back.

A value the size of a whole subtree is asked about by presence instead --
`select(.value.get? != null)`, "which paths have a get at all" -- because
pasting the subtree into the query would give a row nobody can read.

Where the pivot is a list of records, one of the readings searches each record
whole rather than following the path the value was clicked at. Records differ
in shape often enough that no one path finds them all: in a `kubectl get all -o
json` listing, a Pod keeps its containers at `.spec.containers` and a Deployment
keeps them under `.spec.template.spec`, so clicking a container port offers both

```
.items[] | select(any(.. | objects; .containerPort? == 80))                4 results
.items[] | select(.spec.containers[0].ports[0].containerPort? == 80)       2 results
```

and the first of them finds the Deployment and the ReplicaSet as well as the two
Pods. What it returns is the record rather than the port object, which is what
makes the next part possible.

## Picking what comes out

Finding the records is half of it; the other half is saying what to show about
each one. Every line of a result carries `&#x229E;`, which adds that line to the
output. The path is read relative to the result it sits in, so it names the same
field in every one of them: clicking `&#x229E;` on the `"name"` line inside
`.metadata` above leaves

```
.items[] | select(any(.. | objects; .containerPort? == 80)) | {name: .metadata.name}
```

in the box. Clicking a second line adds a second member, named after the key it
sat under; clicking a picked line again takes it out.

Nothing runs until you press Enter. The results on screen are what the fields
are being picked from, and running the query replaces them with what it
returned, so the run waits until there is nothing left to pick. Enter turns the
four records into the four names.

## Why?

Sometimes it's easier to view it in your webbrowser then search through large json output to
find the exact value you need, especially if you don't know the json path.

## License

MIT Copyright Nick Clifford
