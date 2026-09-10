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
$ curl -s 'https://en.wikipedia.org/api/rest_v1/?spec' | jqweb
jqweb: serving on http://127.0.0.1:52748/ (Ctrl-C to stop)

# You can also use -O (or --open) to automatically open your 
# default web browser

$ curl -s 'https://en.wikipedia.org/api/rest_v1/?spec' | jqweb -O
jqweb: serving on http://127.0.0.1:52748/ (Ctrl-C to stop)
```

<img src="demo.png" alt="jqweb rendering the Wikipedia REST API spec" width="580">


**Output to an html file for offline viewing**
```bash
$ kubectl get pods -o json | jqweb -o k8s.html
$ open k8s.html # Opens webpage in your browser
```

**Specify port and host**
```bash
$ jqweb --host 0.0.0.0 --port 9000 < input.json
jqweb: serving on http://[::]:9000/ (Ctrl-C to stop)
```
<br clear="right">

## Usage
usage: `jqweb [-p|--port <port>] [--host <ip>] [-o|--output <file>] [-O|--open] [--jq] [<input-file>]`

Reads JSON from <input-file> ("-" or absent: stdin) and renders it as a
self-contained interactive HTML page, served on a random port or written to file
```
  -p, --port <port>    serve the page on http://<host>:<port>/
      --host <ip>      bind address for -p (default 127.0.0.1)
  -o, --output <file>  write the page to <file>; "-" writes to stdout
  -O, --open           opens your default web browser with the output
      --jq             answer jq queries in the search box
```
With no -p and no -o, it listens on a random available port.


## Search

The search box filters keys and values as you type, and also accepts a jq-style
path. Paste `.list.of.things[302].item`, or any prefix of it such as
`.list.of.things`, and the page shows that node with everything under it. The
copy button on each line puts that line's path on the clipboard, so a copied
path can be pasted straight back into the box.

The leading dot is optional, `["quoted keys"]` and negative array indices such
as `[-1]` both work, and text that does not resolve to a path is used as a
filter instead.

## jq queries

With `--jq`, the box answers jq queries as well:

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

The dropdown decides what the text in the box means. On `auto` anything
starting with `.` `[` `(` `$` or `|` is a query and anything else is a filter,
so typing a word still searches; `jq` forces a query, which is how to run a
bare-word one such as `keys`.

This is a subset of jq, not all of it. Paths, `[]`, slices, `|`, `,`, `//`,
`?`, comparisons, arithmetic, `if/then/elif/else/end`, array and object
construction, and about 60 builtins are there: `select`, `map`, `map_values`,
`keys`, `length`, `type`, `has`, `to_entries`, `from_entries`, `with_entries`,
`add`, `any`, `all`, `sort_by`, `group_by`, `unique_by`, `min_by`, `max_by`,
`flatten`, `range`, `limit`, `first`, `last`, `join`, `split`, `test`,
`startswith`, `contains`, `index`, `rindex`, `indices`, `tostring`, `tonumber`,
`tojson`, `recurse` and the type filters.

Two things differ from jq on purpose. Regular expressions are JavaScript's
rather than Oniguruma's, which part ways in the corners. `index` and `indices`
count characters into a string, where jq counts UTF-8 bytes; jq's own slices
count characters, so in jq `.[index("x"):]` cuts in the wrong place as soon as
the text before the match is not all ASCII. Pure ASCII behaves identically
either way.

Variables and `as`, `def`, `reduce`, `foreach`, assignment, `path`, string
interpolation and format strings are not. A query using one says so by name
instead of guessing at what it meant.

The engine adds about 44KB to every page it is built into, which is why it is
behind a flag rather than always on. A page built without `--jq` carries none
of it.

## Why?

Sometimes it's easier to view it in your webbrowser then search through large json output to
find the exact value you need, especially if you don't know the json path.

## License

MIT Copyright Nick Clifford
