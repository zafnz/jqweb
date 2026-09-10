// jqweb renders a JSON document as a self-contained interactive HTML page:
// a collapsible tree with jq-style coloring, text filtering, path lookup, and
// per-key copy-path buttons.
package main

import (
	"bytes"
	"embed"
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
	"sync"
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
      --jq             answer jq queries in the search box

With no -p and no -o, it listens on a random available port.
`)
}

func main() {
	var (
		port    int
		output  string
		host    string
		open    bool
		jq      bool
		version bool
	)
	flag.IntVar(&port, "p", 0, "")
	flag.IntVar(&port, "port", 0, "")
	flag.StringVar(&output, "o", "", "")
	flag.StringVar(&output, "output", "", "")
	flag.StringVar(&host, "host", "127.0.0.1", "")
	flag.BoolVar(&open, "open", false, "")
	flag.BoolVar(&open, "O", false, "")
	flag.BoolVar(&jq, "jq", false, "")
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

	page := []byte(renderPage(data, title, jq))

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
		"--jq":   false,
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
	if isTruncated(err) {
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

// isTruncated reports whether err means the input ran out mid-document.
//
// Which error that is depends on the Go version: through Go 1.26 the decoder
// returned io.EOF, but Go 1.27 reports More() as true inside an unclosed
// container, so the decoder reads on and returns a syntax error instead. The
// message is the only thing distinguishing it from a real syntax error, since
// its offset is the end of the input either way.
func isTruncated(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var se *json.SyntaxError
	return errors.As(err, &se) && se.Error() == "unexpected end of JSON input"
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
// the template parses it and builds the tree in the browser. jq selects the
// template that carries the query engine.
func renderPage(data []byte, title string, jq bool) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, data); err != nil {
		// check has already accepted the document, so this cannot fail.
		buf.Reset()
		buf.Write(data)
	}
	return strings.NewReplacer(
		"{{TITLE}}", html.EscapeString(title),
		"{{DATA}}", scriptSafe(buf.String()),
	).Replace(pageTemplate(jq))
}

// scriptSafe escapes "<" as its \u003c escape so that a string containing
// "</script" cannot end the script element holding the JSON. In JSON, "<"
// only ever appears inside a string, where \u003c denotes the same character.
func scriptSafe(s string) string {
	return strings.ReplaceAll(s, "<", `\u003c`)
}

//go:embed web/page.html web/page.css web/core.js web/jq.js web/query.js web/page.js
var assets embed.FS

// pageTemplate returns the page shell with its stylesheet and script inlined,
// leaving {{TITLE}} and {{DATA}} for renderPage to fill in. The two states of
// --jq give two different scripts, so there is a template for each, built the
// first time it is wanted.
func pageTemplate(jq bool) string {
	if jq {
		return withJQ()
	}
	return withoutJQ()
}

var withJQ = sync.OnceValue(func() string { return buildTemplate(true) })
var withoutJQ = sync.OnceValue(func() string { return buildTemplate(false) })

func buildTemplate(jq bool) string {
	return strings.NewReplacer(
		"{{STYLE}}", inline("web/page.css"),
		"{{SCRIPT}}", script(jq),
	).Replace(asset("web/page.html"))
}

// script returns the page's JavaScript: the pure core, then the query engine
// and the search box wiring that drives it when --jq asked for them, then the
// rest of the page. query.js has to precede page.js, which calls into it.
//
// The comments in those files are written for someone reading the source, and
// are not worth inlining into every rendered page.
func script(jq bool) string {
	parts := []string{"web/core.js"}
	if jq {
		parts = append(parts, "web/jq.js", "web/query.js")
	}
	parts = append(parts, "web/page.js")
	var b strings.Builder
	for i, name := range parts {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(stripComments(inline(name)))
	}
	return b.String()
}

// stripComments removes /* ... */ comments, and the lines left empty by
// removing them, from JavaScript source.
//
// It is deliberately not a tokenizer. It tracks string and template literals,
// so a "/*" inside one survives, and it gives up on any line where a "/" turns
// up outside a string without a "*" after it, since that could open a regular
// expression whose contents are not code. Such a line is emitted exactly as
// written: missing a comment costs a few bytes, mangling a regular expression
// costs a broken page.
func stripComments(src string) string {
	var out []string
	inComment := false
	for _, line := range strings.Split(src, "\n") {
		kept, stillInComment, ok := stripLine(line, inComment)
		if !ok {
			out = append(out, line) // ambiguous, so leave it as written
			inComment = false
			continue
		}
		inComment = stillInComment
		if kept = strings.TrimRight(kept, " \t"); kept != "" {
			out = append(out, kept)
		}
	}
	return strings.Join(out, "\n")
}

// stripLine removes the comments from one line, given whether the previous
// line ended inside one. It reports whether the line ends inside a comment,
// and whether it could be read at all; a false ok means the caller must keep
// the line as it is.
func stripLine(line string, inComment bool) (kept string, stillInComment, ok bool) {
	var b strings.Builder
	for i := 0; i < len(line); {
		if inComment {
			j := strings.Index(line[i:], "*/")
			if j < 0 {
				return b.String(), true, true // comment runs past this line
			}
			i += j + 2
			inComment = false
			continue
		}
		switch c := line[i]; {
		case c == '/' && i+1 < len(line) && line[i+1] == '*':
			inComment = true
			i += 2
		case c == '/':
			return "", false, false // a regular expression, or division
		case c == '\'' || c == '"' || c == '`':
			end, closed := endOfString(line, i)
			if !closed {
				return "", false, false // a template literal spanning lines
			}
			b.WriteString(line[i : end+1])
			i = end + 1
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String(), inComment, true
}

// endOfString returns the index of the quote closing the literal that opens at
// line[i], or closed == false when the line ends first.
func endOfString(line string, i int) (end int, closed bool) {
	q := line[i]
	for j := i + 1; j < len(line); j++ {
		switch line[j] {
		case '\\':
			j++ // an escaped character cannot close the literal
		case q:
			return j, true
		}
	}
	return 0, false
}

// asset returns the contents of an embedded file.
func asset(name string) string {
	b, err := assets.ReadFile(name)
	if err != nil {
		panic(err) // embedded at build time, so this cannot fail.
	}
	return string(b)
}

// inline returns an embedded file with its trailing newline removed, so that
// substituting it for a placeholder on a line of its own keeps the layout.
func inline(name string) string {
	return strings.TrimSuffix(asset(name), "\n")
}
