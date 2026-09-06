// jqweb renders a JSON document as a self-contained interactive HTML page:
// a collapsible tree with jq-style coloring, text filtering, path lookup, and
// per-key copy-path buttons.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"unicode/utf8"
)

// versionString is set by the linker at release time:
// -X main.versionString=<tag>
var versionString = ""

// releaseVersion reports the release tag when the linker set one, otherwise the
// module version recorded by "go install", otherwise "dev" for a local build.
func releaseVersion() string {
	if versionString != "" {
		return versionString
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		if v := bi.Main.Version; v != "" && v != "(devel)" {
			return strings.TrimPrefix(v, "v")
		}
	}
	return "dev"
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: jqweb [-p|--port <port>] [--host <ip>] [-o|--output <file>] [<input-file>]

Reads JSON from <input-file> ("-" or absent: stdin) and renders it as a
self-contained interactive HTML page.

  -p, --port <port>    serve the page on http://<host>:<port>/
      --host <ip>      bind address for -p (default 127.0.0.1)
  -o, --output <file>  write the page to <file>; "-" writes to stdout
  -O, --open           open the page in the default browser

With no -p and no -o, it listens on a random available port.
`)
}

func main() {
	var (
		port    int
		output  string
		host    string
		open    bool
		version bool
	)
	flag.IntVar(&port, "p", 0, "")
	flag.IntVar(&port, "port", 0, "")
	flag.StringVar(&output, "o", "", "")
	flag.StringVar(&output, "output", "", "")
	flag.StringVar(&host, "host", "127.0.0.1", "")
	flag.BoolVar(&open, "open", false, "")
	flag.BoolVar(&open, "O", false, "")
	flag.BoolVar(&version, "version", false, "")
	flag.BoolVar(&version, "v", false, "")

	flag.Usage = usage
	flag.CommandLine.Parse(reorderArgs(os.Args[1:]))

	set := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
	portSet := set["p"] || set["port"]
	outSet := set["o"] || set["output"]

	if version {
		fmt.Fprintf(os.Stdout, "jqweb %s\n", releaseVersion())
		os.Exit(0)
	}

	if flag.NArg() > 1 {
		fmt.Fprintln(os.Stderr, "jqweb: at most one input file")
		usage()
		os.Exit(2)
	}
	inName := "-"
	if flag.NArg() == 1 {
		inName = flag.Arg(0)
	}

	var data []byte
	var err error
	if inName == "-" {
		if isTTY(os.Stdin) {
			fmt.Fprintln(os.Stderr, "jqweb: no input file and stdin is a terminal")
			usage()
			os.Exit(2)
		}
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(inName)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		os.Exit(1)
	}
	if !portSet && !outSet {
		port = 0
		portSet = true
	}

	displayName := inName
	title := "stdin"
	if inName == "-" {
		displayName = "stdin"
	} else {
		title = filepath.Base(inName)
	}

	if err := check(data); err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %s: %s\n", displayName, err)
		os.Exit(1)
	}

	page := []byte(renderPage(data, title))

	if outSet {
		if output == "-" {
			os.Stdout.Write(page)
		} else {
			if err := os.WriteFile(output, page, 0o644); err != nil {
				fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
				os.Exit(1)
			}
			if open {
				// The filepath must be the absolute path, otherwise the browser will not be able to find the file.
				output, err := filepath.Abs(output)
				if err != nil {
					fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
					os.Exit(1)
				}
				url := "file://" + output
				if err := openBrowser(url); err != nil {
					fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
					os.Exit(1)
				}
			}
		}
	}
	if portSet {
		err := serve(host, port, page, open)
		if err != nil {
			fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if !outSet {
		os.Stdout.Write(page) // stdout is not a tty here
	}
}

// reorderArgs moves flags ahead of positional arguments so that
// "jqweb data.json -p 8080" works; the flag package stops parsing at the
// first non-flag argument.
func reorderArgs(args []string) []string {
	needsValue := map[string]bool{
		"-p": true, "--port": true,
		"-o": true, "--output": true,
		"-O": false, "--open": false,
		"-v": false, "--version": false,
		"--host": true,
	}
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if strings.HasPrefix(a, "-") && a != "-" {
			flags = append(flags, a)
			if needsValue[a] && i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
		} else {
			pos = append(pos, a)
		}
	}
	return append(flags, pos...)
}

func isTTY(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func serve(host string, port int, page []byte, open bool) (err error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "jqweb: serving on http://%s/ (Ctrl-C to stop)\n", ln.Addr())
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(page)
	})
	if open {
		if err := openBrowser(fmt.Sprintf("http://%s/", ln.Addr())); err != nil {
			fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
			os.Exit(1)
		}
	}
	return http.Serve(ln, mux)
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

// ---- JSON validation ----

// check reports whether data is a single well-formed JSON document. The page
// embeds the document itself and renders it in the browser, so nothing is kept
// from this pass but the error.
func check(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := checkValue(dec); err != nil {
		return describeErr(data, err)
	}
	if dec.More() {
		off := dec.InputOffset()
		line, col := lineCol(data, off)
		if moreValues(dec) {
			return fmt.Errorf("input has more than one top-level JSON value (line %d, column %d); "+
				"jqweb renders a single document, so pipe a JSON stream through `jq -s .` to wrap it in an array", line, col)
		}
		return fmt.Errorf("trailing data after top-level value (line %d, column %d)", line, col)
	}
	return nil
}

func checkValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return nil
	}
	switch d {
	case '[':
		for dec.More() {
			if err := checkValue(dec); err != nil {
				return err
			}
		}
	case '{':
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return err
			}
			if _, ok := kt.(string); !ok {
				return fmt.Errorf("object key is not a string: %v", kt)
			}
			if err := checkValue(dec); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("unexpected token %v", d)
	}
	_, err = dec.Token() // consume the closing delimiter
	return err
}

// moreValues reports whether the data left in dec begins with at least one
// further well-formed JSON value, which marks the input as a JSON stream
// (JSON Lines) rather than a single document with garbage appended.
func moreValues(dec *json.Decoder) bool {
	var raw json.RawMessage
	return dec.Decode(&raw) == nil
}

func describeErr(data []byte, err error) error {
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		if len(bytes.TrimSpace(data)) == 0 {
			return fmt.Errorf("empty input")
		}
		return fmt.Errorf("unexpected end of input; the document is truncated")
	}
	if what, binary := sniff(data); binary {
		return fmt.Errorf("input is not JSON; it is %s", what)
	}
	if !startsJSON(data) {
		return notJSON(data)
	}
	// The streaming Token API reports the offset of the last token it
	// consumed, not of the character it choked on, so re-parse the whole
	// input to locate the fault.
	if se, ok := exactErr(data); ok {
		i := int(se.Offset) - 1 // Offset points one past the offending byte
		if i < 0 {
			i = 0
		}
		line, col := lineCol(data, int64(i))
		msg := fmt.Sprintf("%v (line %d, column %d)", se, line, col)
		if h := syntaxHint(data, i); h != "" {
			msg += "\n  " + h
		}
		return errors.New(msg)
	}
	if se, ok := err.(*json.SyntaxError); ok {
		line, col := lineCol(data, se.Offset)
		return fmt.Errorf("%v (line %d, column %d)", err, line, col)
	}
	return err
}

// exactErr re-parses data in one pass to obtain a syntax error whose Offset
// points at the offending byte.
func exactErr(data []byte) (*json.SyntaxError, bool) {
	var raw json.RawMessage
	se, ok := json.Unmarshal(data, &raw).(*json.SyntaxError)
	return se, ok && se.Offset > 0 && int(se.Offset) <= len(data)
}

// syntaxHint explains the common near-JSON dialects, given the index of the
// byte the parser rejected. It returns "" when the error message alone says
// enough.
func syntaxHint(data []byte, i int) string {
	rest := data[i:]
	switch {
	case data[i] == '\'':
		return "JSON strings use double quotes; single quotes come from Python or JavaScript output"
	case data[i] == '/':
		return "JSON has no comments"
	case data[i] == '}' || data[i] == ']':
		if j := lastNonSpace(data[:i]); j >= 0 && data[j] == ',' {
			return "JSON does not allow a trailing comma"
		}
	case bytes.HasPrefix(rest, []byte("NaN")), bytes.HasPrefix(rest, []byte("Infinity")),
		bytes.HasPrefix(rest, []byte("-Infinity")), bytes.HasPrefix(rest, []byte("undefined")):
		return "JSON has no NaN, Infinity or undefined; use null or a string"
	case isIdentStart(data[i]):
		if j := i; identEnd(data, j) < len(data) && data[identEnd(data, j)] == ':' {
			return "object keys must be double-quoted strings"
		}
	}
	return ""
}

func lastNonSpace(b []byte) int {
	for i := len(b) - 1; i >= 0; i-- {
		switch b[i] {
		case ' ', '\t', '\r', '\n':
		default:
			return i
		}
	}
	return -1
}

func isIdentStart(c byte) bool {
	return c == '_' || c == '$' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func identEnd(data []byte, i int) int {
	for i < len(data) && (isIdentStart(data[i]) || (data[i] >= '0' && data[i] <= '9')) {
		i++
	}
	return i
}

// startsJSON reports whether the first non-whitespace byte of data could begin
// a JSON value. A false result means the input is not JSON at all, rather than
// JSON with a syntax error somewhere inside it.
func startsJSON(data []byte) bool {
	s := bytes.TrimLeft(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")), " \t\r\n")
	if len(s) == 0 {
		return false
	}
	switch s[0] {
	case '{', '[', '"':
		return true
	case '-':
		return len(s) > 1 && s[1] >= '0' && s[1] <= '9'
	case 't', 'f', 'n':
		return bytes.HasPrefix(s, []byte("true")) ||
			bytes.HasPrefix(s, []byte("false")) ||
			bytes.HasPrefix(s, []byte("null"))
	}
	return s[0] >= '0' && s[0] <= '9'
}

// notJSON builds the error for input that never starts a JSON value, naming
// the format when it is recognizable and quoting the start of the input
// otherwise.
func notJSON(data []byte) error {
	what, _ := sniff(data)
	msg := "input does not look like JSON"
	if what != "" {
		msg += "; it looks like " + what
	}
	return fmt.Errorf("%s\n  starts with: %s", msg, preview(data))
}

// sniff guesses the format of a non-JSON input. what is "" when there is no
// guess beyond "not JSON"; binary is true for content that should not be
// echoed into the error message.
func sniff(data []byte) (what string, binary bool) {
	s := bytes.TrimSpace(data)
	if len(s) == 0 {
		return "", false
	}
	if bytes.HasPrefix(s, []byte{0x1f, 0x8b}) {
		return "gzip-compressed data; decompress it first, e.g. with gunzip or curl --compressed", true
	}
	head := s[:min(len(s), 1024)]
	// A cut at 1024 bytes can land mid-rune; drop the partial one.
	for i := 0; i < 3 && len(head) < len(s) && len(head) > 0 && !utf8.Valid(head); i++ {
		head = head[:len(head)-1]
	}
	if bytes.IndexByte(head, 0) >= 0 || !utf8.Valid(head) {
		return "binary data", true
	}
	switch {
	case bytes.HasPrefix(bytes.ToLower(s), []byte("<?xml")):
		return "XML", false
	case s[0] == '<':
		return "HTML or XML", false
	case bytes.HasPrefix(s, []byte("#!")):
		return "a script", false
	case bytes.HasPrefix(s, []byte("---")):
		return "YAML", false
	case bytes.HasPrefix(s, []byte("{'")), bytes.HasPrefix(s, []byte("[{'")):
		return "Python repr output; JSON strings need double quotes", false
	case s[0] == '#' || s[0] == '/':
		return "a comment; JSON has no comments", false
	}
	return "", false
}

// preview returns the first line of data, shortened and stripped of control
// characters, for quoting back in an error message.
func preview(data []byte) string {
	s := strings.TrimSpace(string(data))
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	s = strings.Map(func(r rune) rune {
		if r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if rs := []rune(s); len(rs) > 60 {
		s = string(rs[:60]) + "..."
	}
	return s
}

func lineCol(data []byte, off int64) (int, int) {
	if off > int64(len(data)) {
		off = int64(len(data))
	}
	prefix := data[:off]
	line := bytes.Count(prefix, []byte{'\n'}) + 1
	col := int(off) - bytes.LastIndexByte(prefix, '\n')
	return line, col
}

// ---- page assembly ----

// renderPage embeds the document in the page as compact JSON; the script in
// pageTemplate parses it and builds the tree in the browser.
func renderPage(data []byte, title string) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, data); err != nil {
		// check has already accepted the document, so this cannot fail.
		buf.Reset()
		buf.Write(data)
	}
	return strings.NewReplacer(
		"{{TITLE}}", html.EscapeString(title),
		"{{DATA}}", scriptSafe(buf.String()),
	).Replace(pageTemplate)
}

// scriptSafe escapes "<" as its \u003c escape so that a string containing
// "</script" cannot end the script element holding the JSON. In JSON, "<"
// only ever appears inside a string, where \u003c denotes the same character.
func scriptSafe(s string) string {
	return strings.ReplaceAll(s, "<", `\u003c`)
}

const pageTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}} &middot; jqweb</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: #101114; color: #d4d7dd;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
header {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 14px; background: #17191d; border-bottom: 1px solid #26292f;
}
header .name { color: #8a9199; margin-right: 4px; }
header button {
  font: inherit; color: #d4d7dd; background: #22252b;
  border: 1px solid #33373f; border-radius: 4px; padding: 3px 10px; cursor: pointer;
}
header button:hover { background: #2a2e35; }
#q {
  font: inherit; flex: 1 1 220px; max-width: 420px; color: inherit;
  background: #101114; border: 1px solid #33373f; border-radius: 4px;
  padding: 4px 9px; outline: none;
}
#q:focus { border-color: #4a90d9; }
#stats { color: #8a9199; }
main { padding: 10px 14px 60px; }

.line { white-space: pre-wrap; word-break: break-word; border-radius: 3px; }
.line:hover { background: rgba(255,255,255,.045); }
.toggle, .sp { display: inline-block; width: 1.15em; }
.toggle {
  background: none; border: none; padding: 0; margin: 0;
  color: #7d848d; cursor: pointer; font: inherit; text-align: left;
}
.toggle::before { content: "\25BE"; }
.node.collapsed > .line > .toggle::before { content: "\25B8"; }
.kids { margin-left: .55em; padding-left: .8em; border-left: 1px solid #24272c; }
.closer { padding-left: 1.15em; }
.node.collapsed > .kids, .node.collapsed > .closer { display: none; }
.node:not(.collapsed) > .line > .fold { display: none; }
.fold { color: #7d848d; cursor: pointer; }

.key { color: #6cb6ff; font-weight: 600; }
.str { color: #57d364; }
.num { color: #d4d7dd; }
.bool { color: #d4d7dd; font-weight: 600; }
.null { color: #8a9199; font-weight: 600; }
.p { color: #eceef2; font-weight: 600; }
.pn { color: #d4d7dd; }
.c { color: #8a9199; }

.cp {
  background: none; border: none; padding: 0 5px;
  font: inherit; font-size: .92em; color: #8a9199; cursor: pointer; opacity: .35;
}
.line:hover .cp, .cp:focus { opacity: 1; }
.cp.ok { color: #57d364; opacity: 1; }
.cp.fail { color: #e5534b; opacity: 1; }

.node.hidden { display: none; }
.node.hit > .line { background: rgba(210,168,60,.16); }
</style>
</head>
<body>
<header>
  <span class="name">jqweb &middot; {{TITLE}}</span>
  <button id="expand" type="button">Expand all</button>
  <button id="collapse" type="button">Collapse all</button>
  <input id="q" type="search" placeholder="Filter keys and values, or paste a path (press /)" autocomplete="off" spellcheck="false">
  <span id="stats"></span>
</header>
<main id="tree"></main>
<script id="data" type="application/json">{{DATA}}</script>
<script>
(function () {
  'use strict';
  var tree = document.getElementById('tree');
  var input = document.getElementById('q');
  var stats = document.getElementById('stats');

  /* ---- parse ---- */

  /* The embedded document is compact JSON, parsed here rather than with
     JSON.parse because the tree shows object keys in document order and
     numbers exactly as written, neither of which survives JSON.parse. A node
     is {t:'o',k:keys,v:children}, {t:'a',v:children} or {t:'l',h:leafHTML}. */
  function parseJSON(src) {
    var i = 0;

    function ws() { while (i < src.length && src.charCodeAt(i) <= 32) i++; }

    /* Reads a string literal starting at src[i] and returns its value. */
    function str() {
      var start = i++;
      while (src.charCodeAt(i) !== 34) i += src.charCodeAt(i) === 92 ? 2 : 1;
      return JSON.parse(src.slice(start, ++i));
    }

    function value() {
      ws();
      var c = src.charAt(i), keys, vals, lit, start;
      if (c === '{') {
        i++; keys = []; vals = []; ws();
        if (src.charAt(i) === '}') {
          i++;
        } else {
          for (;;) {
            ws();
            keys.push(str());
            ws(); i++;                 /* ':' */
            vals.push(value());
            ws();
            if (src.charAt(i++) === '}') break;
          }
        }
        return { t: 'o', k: keys, v: vals };
      }
      if (c === '[') {
        i++; vals = []; ws();
        if (src.charAt(i) === ']') {
          i++;
        } else {
          for (;;) {
            vals.push(value());
            ws();
            if (src.charAt(i++) === ']') break;
          }
        }
        return { t: 'a', v: vals };
      }
      if (c === '"') return { t: 'l', h: span('str', esc(quote(str()))) };
      start = i;
      while (i < src.length && ',]}'.indexOf(src.charAt(i)) < 0 && src.charCodeAt(i) > 32) i++;
      lit = src.slice(start, i);
      return { t: 'l', h: span(lit === 'null' ? 'null' : lit === 'true' || lit === 'false' ? 'bool' : 'num', lit) };
    }

    return value();
  }

  function span(cls, text) { return '<span class="v ' + cls + '">' + text + '</span>'; }

  /* JSON.stringify leaves U+2028 and U+2029 raw; they are escaped so the tree
     shows them instead of an invisible separator. */
  function quote(s) {
    return JSON.stringify(s).replace(/[\u2028\u2029]/g, function (c) {
      return '\\u202' + (c === '\u2028' ? '8' : '9');
    });
  }

  var escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return escMap[c]; }); }

  /* ---- render ---- */

  var CP = '<button class="cp" title="Copy path">&#x29C9;</button>';

  function renderTree(root) {
    var out = [];
    emit(out, root, null, -1, false);
    return out.join('');
  }

  /* Emits one tree node. key is non-null for object members, idx >= 0 for
     array elements; the root has neither. comma appends a trailing comma. */
  function emit(out, node, key, idx, comma) {
    var attrs = key !== null ? ' data-key="' + esc(key) + '"'
      : idx >= 0 ? ' data-index="' + idx + '"' : '';
    var keyPart = '', endBtn = CP;   /* unkeyed nodes get the button at the end of the line */
    if (key !== null) {
      keyPart = '<span class="key">' + esc(quote(key)) + '</span>' + CP +
        '<span class="pn">: </span>';
      endBtn = '';
    }
    var c = comma ? '<span class="c">,</span>' : '';

    if (node.t === 'l') {
      out.push('<div class="node leaf"' + attrs + '><div class="line"><span class="sp"></span>' +
        keyPart + node.h + c + endBtn + '</div></div>');
      return;
    }
    var obj = node.t === 'o';
    var open = obj ? '{' : '[';
    var close = obj ? '}' : ']';
    var n = node.v.length;
    if (!n) {
      out.push('<div class="node leaf"' + attrs + '><div class="line"><span class="sp"></span>' +
        keyPart + '<span class="p">' + open + close + '</span>' + c + endBtn + '</div></div>');
      return;
    }
    var noun = (obj ? 'key' : 'item') + (n === 1 ? '' : 's');
    out.push('<div class="node branch"' + attrs +
      '><div class="line"><button class="toggle" aria-label="Toggle"></button>' +
      keyPart + '<span class="p">' + open + '</span>' +
      '<span class="fold"> &#x2026; ' + n + ' ' + noun + ' <span class="p">' + close + '</span>' +
      c + '</span>' + endBtn + '</div><div class="kids">');
    for (var j = 0; j < n; j++) {
      emit(out, node.v[j], obj ? node.k[j] : null, obj ? -1 : j, j < n - 1);
    }
    out.push('</div><div class="closer"><span class="p">' + close + '</span>' + c + '</div></div>');
  }

  tree.innerHTML = renderTree(parseJSON(document.getElementById('data').textContent));
  var rootNode = tree.querySelector(':scope > .node');

  tree.addEventListener('click', function (e) {
    var cp = e.target.closest('.cp');
    if (cp) { copyPath(cp); return; }
    var tg = e.target.closest('.toggle');
    if (tg) { tg.closest('.node').classList.toggle('collapsed'); return; }
    var fold = e.target.closest('.fold');
    if (fold) { fold.closest('.node').classList.remove('collapsed'); }
  });

  document.getElementById('expand').addEventListener('click', function () {
    each('.node.branch', function (n) { n.classList.remove('collapsed'); });
  });
  document.getElementById('collapse').addEventListener('click', function () {
    each('.node.branch', function (n) { if (n !== rootNode) n.classList.add('collapsed'); });
  });

  function each(sel, fn) {
    Array.prototype.forEach.call(tree.querySelectorAll(sel), fn);
  }

  /* ---- copy path ---- */
  var identRe = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function pathOf(node) {
    var segs = [];
    var n = node;
    while (n) {
      if (n.dataset.index !== undefined) {
        segs.unshift('[' + n.dataset.index + ']');
      } else if (n.dataset.key !== undefined) {
        var k = n.dataset.key;
        segs.unshift(identRe.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
      }
      n = n.parentElement && n.parentElement.closest('.node');
    }
    var p = segs.join('');
    if (!p) return '.';
    if (p.charAt(0) === '[') p = '.' + p;
    return p;
  }

  function copyPath(btn) {
    var path = pathOf(btn.closest('.node'));
    copyText(path, function (ok) { flash(btn, ok); });
  }

  function copyText(t, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(t).then(
        function () { done(true); },
        function () { done(legacyCopy(t)); });
    } else {
      done(legacyCopy(t));
    }
  }

  function legacyCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return ok;
  }

  function flash(btn, ok) {
    btn.classList.add(ok ? 'ok' : 'fail');
    btn.textContent = ok ? '✓' : '✗';
    setTimeout(function () {
      btn.classList.remove('ok', 'fail');
      btn.textContent = '⧉';
    }, 900);
  }

  /* ---- search ---- */
  var timer = null;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && e.target !== input) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape' && e.target === input) { input.value = ''; run(); }
  });

  /* Text containing "." or "[" may be a path such as .a.b[3].c, so it is tried
     as one first; a bare word is always a text filter. A path that does not
     resolve falls back to text filtering unless it was written with a leading
     dot, which takes it as a path regardless. */
  function run() {
    var raw = input.value.trim();
    if (!raw) { reset(); return; }
    if (/[.[]/.test(raw)) {
      var segs = parsePath(raw);
      if (segs) {
        var found = resolvePath(segs);
        if (found.depth === segs.length) {
          showPath(found.node, true);
          stats.textContent = pathOf(found.node);
          return;
        }
        if (raw.charAt(0) === '.') {
          showPath(found.node, found.depth > 0);
          stats.textContent = found.depth ? 'no path past ' + pathOf(found.node) : 'no such path';
          return;
        }
      }
    }
    textFilter(raw.toLowerCase());
  }

  function reset() {
    each('.node', function (n) { n.classList.remove('hidden', 'hit'); });
    stats.textContent = '';
  }

  /* ---- path navigation ---- */
  var pathChar = /[^.[\]"'\s]/;

  /* parsePath splits a jq-style path such as .a.b[3]["x y"] into key and index
     segments. The leading dot is optional. Returns null for text that is not a
     path. */
  function parsePath(str) {
    var s = str.trim();
    if (s === '.') return [];
    var segs = [], i = 0;
    if (s.charAt(0) !== '.' && s.charAt(0) !== '[') {
      while (i < s.length && pathChar.test(s.charAt(i))) i++;
      if (!i) return null;
      segs.push({ key: s.slice(0, i) });
    }
    while (i < s.length) {
      var c = s.charAt(i), q, j, start;
      if (c === '.') {
        i++;
        if (s.charAt(i) === '[') continue;
        start = i;
        while (i < s.length && pathChar.test(s.charAt(i))) i++;
        if (i === start) return null;
        segs.push({ key: s.slice(start, i) });
      } else if (c === '[') {
        q = s.charAt(i + 1);
        if (q === '"' || q === "'") {
          j = i + 2;
          while (j < s.length && s.charAt(j) !== q) j += s.charAt(j) === '\\' ? 2 : 1;
          if (s.charAt(j) !== q || s.charAt(j + 1) !== ']') return null;
          if (q === '"') {
            try { segs.push({ key: JSON.parse(s.slice(i + 1, j + 1)) }); }
            catch (e) { return null; }
          } else {
            segs.push({ key: s.slice(i + 2, j).replace(/\\(['\\])/g, '$1') });
          }
          i = j + 2;
        } else {
          j = s.indexOf(']', i + 1);
          if (j < 0 || !/^-?\d+$/.test(s.slice(i + 1, j))) return null;
          segs.push({ index: parseInt(s.slice(i + 1, j), 10) });
          i = j + 1;
        }
      } else {
        return null;
      }
    }
    return segs.length ? segs : null;
  }

  /* Walks segs from the root, returning the deepest node reached and how many
     segments matched; depth === segs.length is a full match. */
  function resolvePath(segs) {
    var node = rootNode, i = 0;
    for (; i < segs.length; i++) {
      var next = childMatching(node, segs[i]);
      if (!next) break;
      node = next;
    }
    return { node: node, depth: i };
  }

  function childMatching(node, seg) {
    var kids = node.querySelectorAll(':scope > .kids > .node'), i;
    if (seg.key !== undefined) {
      for (i = 0; i < kids.length; i++) {
        if (kids[i].dataset.key === seg.key) return kids[i];
      }
      return null;
    }
    i = seg.index < 0 ? kids.length + seg.index : seg.index;
    return kids[i] && kids[i].dataset.index === String(i) ? kids[i] : null;
  }

  /* Shows target with its whole subtree, plus the ancestors leading to it. */
  function showPath(target, mark) {
    each('.node', function (n) { n.classList.add('hidden'); n.classList.remove('hit'); });
    for (var n = target; n; n = n.parentElement && n.parentElement.closest('.node')) {
      n.classList.remove('hidden', 'collapsed');
    }
    if (mark) target.classList.add('hit');
    Array.prototype.forEach.call(target.querySelectorAll('.node'), function (d) {
      d.classList.remove('hidden');
    });
    target.scrollIntoView({ block: 'center' });
  }

  /* ---- text filter ---- */

  /* Lowercased key + leaf value text for one node, cached on the element. */
  function ownText(n) {
    if (n._q === undefined) {
      var s = '';
      if (n.dataset.key !== undefined) s += n.dataset.key.toLowerCase() + '\n';
      var v = n.querySelector(':scope > .line > .v');
      if (v) s += v.textContent.toLowerCase();
      n._q = s;
    }
    return n._q;
  }

  function textFilter(needle) {
    var hits = 0;
    /* Returns whether this subtree contains a match. "forced" keeps the whole
       subtree of a matching node visible without counting it as a match. */
    function walk(node, forced) {
      var own = ownText(node).indexOf(needle) !== -1;
      if (own) hits++;
      var childKeep = false;
      var kids = node.querySelectorAll(':scope > .kids > .node');
      for (var i = 0; i < kids.length; i++) {
        if (walk(kids[i], forced || own)) childKeep = true;
      }
      node.classList.toggle('hidden', !(own || forced || childKeep));
      node.classList.toggle('hit', own);
      if (childKeep) node.classList.remove('collapsed');
      return own || childKeep;
    }
    walk(rootNode, false);
    stats.textContent = hits === 1 ? '1 match' : hits + ' matches';
  }
})();
</script>
</body>
</html>
`
