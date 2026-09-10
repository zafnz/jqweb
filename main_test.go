package main

import (
	"encoding/json"
	"flag"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestReorderArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{"empty", []string{}, nil},
		{"flags already first", []string{"-O", "f.json"}, []string{"-O", "f.json"}},
		{"file before flag", []string{"f.json", "-O"}, []string{"-O", "f.json"}},
		{"flag value stays attached", []string{"f.json", "-p", "8080"}, []string{"-p", "8080", "f.json"}},
		{"long flag value stays attached", []string{"f.json", "--port", "8080"}, []string{"--port", "8080", "f.json"}},
		{"several flags", []string{"f.json", "--host", "0.0.0.0", "-O"}, []string{"--host", "0.0.0.0", "-O", "f.json"}},
		{"value not swallowed by boolean flag", []string{"-O", "f.json", "-v"}, []string{"-O", "-v", "f.json"}},
		{"dash is stdin, not a flag", []string{"-p", "9", "-"}, []string{"-p", "9", "-"}},
		{"flag missing its value", []string{"f.json", "-p"}, []string{"-p", "f.json"}},
		{"terminator makes the rest positional", []string{"--", "-p", "8080"}, []string{"-p", "8080"}},
		{"terminator after a flag", []string{"-O", "--", "-weird.json"}, []string{"-O", "-weird.json"}},
		{"terminator with nothing after it", []string{"-O", "--"}, []string{"-O"}},
		{"close flag value stays attached", []string{"f.json", "--close-delay", "5s"}, []string{"--close-delay", "5s", "f.json"}},
		{"close is boolean and swallows nothing", []string{"-C", "f.json"}, []string{"-C", "f.json"}},
		{"-OC moves like any other flag", []string{"f.json", "-OC"}, []string{"-OC", "f.json"}},
		// One dash and two are the same flag to the flag package, so a value
		// has to follow its flag either way round.
		{"one-dash long flag value stays attached", []string{"f.json", "-host", "0.0.0.0"}, []string{"-host", "0.0.0.0", "f.json"}},
		{"one-dash theme value stays attached", []string{"f.json", "-theme", "light"}, []string{"-theme", "light", "f.json"}},
		{"one-dash close-delay value stays attached", []string{"f.json", "-close-delay", "5s"}, []string{"-close-delay", "5s", "f.json"}},
		{"two-dash short flag value stays attached", []string{"f.json", "--p", "8080"}, []string{"--p", "8080", "f.json"}},
		// An attached value must not pull the next argument along with it.
		{"equals form keeps the file", []string{"-p=8080", "f.json"}, []string{"-p=8080", "f.json"}},
		{"equals form after the file", []string{"f.json", "--theme=dark"}, []string{"--theme=dark", "f.json"}},
		{"equals form before another flag", []string{"f.json", "--host=0.0.0.0", "-O"}, []string{"--host=0.0.0.0", "-O", "f.json"}},
		{"unknown flag swallows nothing", []string{"-Ox", "f.json"}, []string{"-Ox", "f.json"}},
		{"terminator hides a flag-shaped file", []string{"--", "-OC"}, []string{"-OC"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := reorderArgs(tt.args)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("reorderArgs(%q) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestFlagName(t *testing.T) {
	tests := []struct{ arg, want string }{
		{"-p", "p"},
		{"--p", "p"},
		{"-host", "host"},
		{"--host", "host"},
		{"--host=0.0.0.0", "host"},
		{"-close-delay=5s", "close-delay"},
		{"-OC", "OC"},
		{"--theme=", "theme"},
	}
	for _, tt := range tests {
		t.Run(tt.arg, func(t *testing.T) {
			if got := flagName(tt.arg); got != tt.want {
				t.Errorf("flagName(%q) = %q, want %q", tt.arg, got, tt.want)
			}
		})
	}
}

// Every flag that takes a value has to be in valueFlags, under the name the
// flag package knows it by, or reorderArgs leaves its value behind.
func TestValueFlagsCoversTheCommandLine(t *testing.T) {
	fs := flag.NewFlagSet("jqweb", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	if _, err := parseFlags(fs, nil); err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	fs.VisitAll(func(f *flag.Flag) {
		// A boolean flag is the only kind the flag package will accept
		// without a value following it.
		_, boolean := f.Value.(interface{ IsBoolFlag() bool })
		if boolean == valueFlags[f.Name] {
			t.Errorf("flag %q: boolean = %v, but valueFlags[%q] = %v",
				f.Name, boolean, f.Name, valueFlags[f.Name])
		}
	})
	for name := range valueFlags {
		if fs.Lookup(name) == nil {
			t.Errorf("valueFlags has %q, which is not a flag", name)
		}
	}
}

// parse runs the real command line definition over args. The flag package's
// own error handling is turned off so that a rejected command line comes back
// as a value rather than exiting the test binary.
func parse(t *testing.T, args ...string) (cliOptions, error) {
	t.Helper()
	fs := flag.NewFlagSet("jqweb", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return parseFlags(fs, args)
}

func TestParseFlagsDefaults(t *testing.T) {
	opt, err := parse(t)
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if opt.host != "127.0.0.1" || opt.theme != "auto" {
		t.Errorf("host = %q, theme = %q; want 127.0.0.1 and auto", opt.host, opt.theme)
	}
	if opt.closeOnGet {
		t.Error("closeOnGet is on by default; -C has to be asked for")
	}
	if opt.closeDelay != time.Second {
		t.Errorf("closeDelay = %s, want 1s", opt.closeDelay)
	}
	if opt.portSet || opt.outSet || len(opt.args) != 0 {
		t.Errorf("portSet = %v, outSet = %v, args = %q; want false, false, none",
			opt.portSet, opt.outSet, opt.args)
	}
}

func TestParseFlagsClose(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		close     bool
		delay     time.Duration
		open      bool
		leftovers []string
	}{
		{"absent", []string{"f.json"}, false, time.Second, false, []string{"f.json"}},
		{"short", []string{"-C", "f.json"}, true, time.Second, false, []string{"f.json"}},
		{"long", []string{"--close", "f.json"}, true, time.Second, false, []string{"f.json"}},
		{"-OC", []string{"-OC", "f.json"}, true, time.Second, true, []string{"f.json"}},
		{"-CO", []string{"-CO", "f.json"}, true, time.Second, true, []string{"f.json"}},
		{"-OC after the file", []string{"f.json", "-OC"}, true, time.Second, true, []string{"f.json"}},
		{"-OC with a delay", []string{"-OC", "--close-delay", "3s"}, true, 3 * time.Second, true, nil},
		{"-O without -C", []string{"-O", "f.json"}, false, time.Second, true, []string{"f.json"}},
		{"one-dash close", []string{"-close", "f.json"}, true, time.Second, false, []string{"f.json"}},
		{"one-dash delay after the file", []string{"f.json", "-close-delay", "2s"}, true, 2 * time.Second, false, []string{"f.json"}},
		{"delay implies close", []string{"--close-delay", "5s"}, true, 5 * time.Second, false, nil},
		{"delay with an equals sign", []string{"--close-delay=250ms"}, true, 250 * time.Millisecond, false, nil},
		{"delay after the file", []string{"f.json", "--close-delay", "2s"}, true, 2 * time.Second, false, []string{"f.json"}},
		{"delay alongside -C", []string{"-C", "--close-delay", "0s"}, true, 0, false, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opt, err := parse(t, tt.args...)
			if err != nil {
				t.Fatalf("parseFlags(%q): %v", tt.args, err)
			}
			if opt.closeOnGet != tt.close {
				t.Errorf("closeOnGet = %v, want %v", opt.closeOnGet, tt.close)
			}
			if opt.closeDelay != tt.delay {
				t.Errorf("closeDelay = %s, want %s", opt.closeDelay, tt.delay)
			}
			if opt.open != tt.open {
				t.Errorf("open = %v, want %v", opt.open, tt.open)
			}
			if len(opt.args) != len(tt.leftovers) {
				t.Fatalf("args = %q, want %q", opt.args, tt.leftovers)
			}
			for i := range tt.leftovers {
				if opt.args[i] != tt.leftovers[i] {
					t.Errorf("args = %q, want %q", opt.args, tt.leftovers)
					break
				}
			}
		})
	}
}

// The flags that were given are read back off the FlagSet rather than compared
// against their defaults, so a flag given its default value still counts.
func TestParseFlagsRecordsWhichFlagsWereGiven(t *testing.T) {
	opt, err := parse(t, "-p=0", "f.json")
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if !opt.portSet {
		t.Error("portSet is false for -p=0, so an explicit port 0 would fall back to output")
	}
	opt, err = parse(t, "-o", "-")
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if !opt.outSet || opt.portSet {
		t.Errorf("outSet = %v, portSet = %v; want true, false", opt.outSet, opt.portSet)
	}
}

func TestParseFlagsRejects(t *testing.T) {
	bad := [][]string{
		{"-OCx"},                    // -OC is a flag, but -OCx is not
		{"-Op"},                     // only -OC and -CO run two flags together
		{"-vO"},                     // and no other pair does
		{"--close-delay", "banana"}, // not a duration
		{"--close-delay"},           // no value
		{"--nonesuch"},
	}
	for _, args := range bad {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			if _, err := parse(t, args...); err == nil {
				t.Errorf("parseFlags(%q) was accepted, want an error", args)
			}
		})
	}
}

// ---- serving ----

// testClient talks to the servers below without keeping connections alive, so
// that an idle connection cannot hold up Shutdown and make the timing wrong.
var testClient = &http.Client{
	Timeout:   5 * time.Second,
	Transport: &http.Transport{DisableKeepAlives: true},
}

// startServer serves page on a listener of its own, and returns the URL, the
// listener, and a channel carrying what serveOn returned.
func startServer(t *testing.T, page []byte, opt serveOptions) (url string, ln net.Listener, done <-chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ch := make(chan error, 1)
	go func() { ch <- serveOn(ln, page, opt) }()
	return "http://" + ln.Addr().String() + "/", ln, ch
}

// fetch performs one request and reads the body to the end, so the connection
// is not left active behind it.
func fetch(t *testing.T, method, url string) (status int, body string) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	resp, err := testClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading %s: %v", url, err)
	}
	return resp.StatusCode, string(b)
}

func TestServeSendsThePage(t *testing.T) {
	page := []byte("<html>the document</html>")
	url, ln, done := startServer(t, page, serveOptions{})
	defer func() {
		ln.Close()
		<-done
	}()

	status, body := fetch(t, http.MethodGet, url)
	if status != http.StatusOK || body != string(page) {
		t.Errorf("GET / = %d %q, want 200 and the page", status, body)
	}
	if status, _ := fetch(t, http.MethodGet, url+"elsewhere"); status != http.StatusNotFound {
		t.Errorf("GET /elsewhere = %d, want 404", status)
	}
}

func TestServeStopsAfterTheFetch(t *testing.T) {
	const delay = 300 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	start := time.Now()
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", status)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil for a shutdown that was asked for", err)
		}
		if waited := time.Since(start); waited < delay {
			t.Errorf("stopped %s after the fetch, before the %s delay", waited, delay)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the page was fetched")
	}
}

// A reload, a second reader, or a prefetch that beat the reader to it all have
// to keep the server up rather than end it, which is the whole reason for the
// delay. The timings here assume the fetches land within about 150ms of when
// they are asked for.
func TestServeFetchRestartsTheCloseTimer(t *testing.T) {
	const delay = 600 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("first GET / = %d, want 200", status)
	}
	time.Sleep(delay / 2)
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("second GET / = %d, want 200", status)
	}

	// Past one delay since the first fetch: reachable only because the second
	// one restarted the timer.
	time.Sleep(delay * 3 / 4)
	status, _ := fetch(t, http.MethodGet, url)
	last := time.Now()
	if status != http.StatusOK {
		t.Fatalf("third GET / = %d, want 200: the fetches did not restart the close timer", status)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil", err)
		}
		if waited := time.Since(last); waited < delay {
			t.Errorf("stopped %s after the last fetch, before the %s delay", waited, delay)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the last fetch")
	}
}

func TestServeKeepsServingWithoutClose(t *testing.T) {
	const delay = 100 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeDelay: delay})
	defer func() {
		ln.Close()
		<-done
	}()

	fetch(t, http.MethodGet, url)
	time.Sleep(5 * delay)
	select {
	case err := <-done:
		t.Fatalf("stopped without -C (returned %v); a delay alone must not end the server", err)
	default:
	}
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Errorf("GET / = %d after the delay passed, want 200", status)
	}
}

// A HEAD is how a link scanner checks that a URL is there. Nobody has read the
// page, so it must not start the clock.
func TestServeHeadDoesNotStartTheCloseTimer(t *testing.T) {
	const delay = 150 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	fetch(t, http.MethodHead, url)
	time.Sleep(5 * delay)
	select {
	case err := <-done:
		t.Fatalf("stopped after a HEAD (returned %v); only a GET of / counts as a fetch", err)
	default:
	}
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d after a HEAD, want 200", status)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the GET that followed the HEAD")
	}
}

func TestCheckAccepts(t *testing.T) {
	valid := []string{
		`{}`,
		`[]`,
		`null`,
		`true`,
		`0`,
		`-1.5e10`,
		`"a string"`,
		`{"a":[1,2,{"b":null}]}`,
		"\n\t {\"a\": 1}\n",
		`{"big":123456789012345678901234567890}`,
		`{"unicode":"  😀"}`,
	}
	for _, in := range valid {
		if err := check([]byte(in)); err != nil {
			t.Errorf("check(%q) = %v, want nil", in, err)
		}
	}
}

func TestCheckErrors(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string // substring the message must contain
	}{
		{"empty", "", "empty input"},
		{"whitespace only", "  \n\t ", "empty input"},
		{"truncated object", `{"a":`, "truncated"},
		{"truncated array", `[1,2`, "truncated"},
		{"unclosed array", `[`, "truncated"},
		{"unclosed object", `{`, "truncated"},
		{"unclosed nested array", `{"a":[1,`, "truncated"},
		{"complete value, unclosed container", `{"a":1`, "truncated"},
		{"unterminated string", `"abc`, "truncated"},
		{"truncated literal", `tru`, "truncated"},
		{"two documents", `{} {}`, "more than one top-level JSON value"},
		{"json stream", "{\"a\":1}\n{\"a\":2}\n", "jq -s ."},
		{"trailing junk", `{} oops`, "trailing data after top-level value"},
		{"single quotes", `{'a': 1}`, "JSON strings use double quotes"},
		{"comment", `{"a": /* note */ 1}`, "JSON has no comments"},
		{"trailing comma in array", `[1, 2, ]`, "trailing comma"},
		{"trailing comma in object", `{"a": 1, }`, "trailing comma"},
		{"unquoted key", `{a: 1}`, "object keys must be double-quoted"},
		{"NaN", `[NaN]`, "JSON has no NaN, Infinity or undefined"},
		{"undefined", `{"a": undefined}`, "JSON has no NaN, Infinity or undefined"},
		{"html", "<html><body>hi</body></html>", "HTML or XML"},
		{"xml", `<?xml version="1.0"?><a/>`, "it looks like XML"},
		{"yaml", "---\na: 1\n", "YAML"},
		{"script", "#!/bin/sh\necho hi\n", "a script"},
		{"gzip", "\x1f\x8b\x08\x00binary", "gzip-compressed"},
		{"binary", "\x00\x01\x02\x03 not text", "binary data"},
		{"bare word", "hello there", "does not look like JSON"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := check([]byte(tt.in))
			if err == nil {
				t.Fatalf("check(%q) = nil, want an error containing %q", tt.in, tt.want)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("check(%q) = %q, want it to contain %q", tt.in, err, tt.want)
			}
		})
	}
}

// A syntax error should be reported at the line and column of the offending
// byte, not at the end of the last token the decoder consumed.
func TestCheckReportsPosition(t *testing.T) {
	err := check([]byte("{\n  \"a\": 1,\n  \"b\": oops\n}"))
	if err == nil {
		t.Fatal("check() = nil, want an error")
	}
	if !strings.Contains(err.Error(), "line 3") {
		t.Errorf("check() = %q, want it to report line 3", err)
	}
}

func TestLineCol(t *testing.T) {
	data := []byte("ab\ncde\n\nx")
	tests := []struct {
		off       int64
		line, col int
	}{
		{0, 1, 1},
		{1, 1, 2},
		{2, 1, 3}, // the newline itself ends line 1
		{3, 2, 1}, // first byte of line 2
		{5, 2, 3},
		{7, 3, 1}, // the empty line
		{8, 4, 1},
		{99, 4, 2}, // clamped to the end of the input
	}
	for _, tt := range tests {
		line, col := lineCol(data, tt.off)
		if line != tt.line || col != tt.col {
			t.Errorf("lineCol(off=%d) = (%d, %d), want (%d, %d)", tt.off, line, col, tt.line, tt.col)
		}
	}
}

func TestStartsJSON(t *testing.T) {
	yes := []string{`{`, `[`, `"`, `0`, `9x`, `-1`, `true`, `false`, `null`, "  \n\t{", "\xef\xbb\xbf{"}
	no := []string{``, `   `, `x`, `-`, `-x`, `tru`, `<html>`, `'a'`, `#`, `+1`, `.5`}
	for _, in := range yes {
		if !startsJSON([]byte(in)) {
			t.Errorf("startsJSON(%q) = false, want true", in)
		}
	}
	for _, in := range no {
		if startsJSON([]byte(in)) {
			t.Errorf("startsJSON(%q) = true, want false", in)
		}
	}
}

func TestSniff(t *testing.T) {
	tests := []struct {
		name, in, what string
		binary         bool
	}{
		{"no guess", "hello there", "", false},
		{"empty", "", "", false},
		{"html", "<html>", "HTML or XML", false},
		{"xml", `<?xml version="1.0"?>`, "XML", false},
		{"xml uppercase", `<?XML version="1.0"?>`, "XML", false},
		{"yaml", "---\na: 1", "YAML", false},
		{"script", "#!/usr/bin/env bash", "a script", false},
		{"hash comment", "# a note", "a comment; JSON has no comments", false},
		{"gzip", "\x1f\x8b\x08", "gzip-compressed data; decompress it first, e.g. with gunzip or curl --compressed", true},
		{"nul byte", "ab\x00cd", "binary data", true},
		{"invalid utf-8", "\xff\xfe\xfd", "binary data", true},
		{"valid utf-8 is not binary", "héllo 😀", "", false},
		// sniff recognizes Python repr output, but check() never asks: the
		// input starts with "{", so startsJSON accepts it and the parser's
		// single-quote hint is what a user actually sees.
		{"python repr", "{'a': 1}", "Python repr output; JSON strings need double quotes", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			what, binary := sniff([]byte(tt.in))
			if what != tt.what || binary != tt.binary {
				t.Errorf("sniff(%q) = (%q, %v), want (%q, %v)", tt.in, what, binary, tt.what, tt.binary)
			}
		})
	}
}

func TestPreview(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"trimmed", "  hello  ", "hello"},
		{"first line only", "one\ntwo\nthree", "one"},
		{"first line of crlf", "one\r\ntwo", "one"},
		{"tabs become spaces", "a\tb", "a b"},
		{"control characters dropped", "a\x00\x01b\x7f", "ab"},
		{"long line truncated", strings.Repeat("a", 70), strings.Repeat("a", 60) + "..."},
		{"truncation counts runes", strings.Repeat("é", 70), strings.Repeat("é", 60) + "..."},
		{"short multibyte kept whole", "héllo", "héllo"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := preview([]byte(tt.in)); got != tt.want {
				t.Errorf("preview(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestScriptSafe(t *testing.T) {
	tests := []struct{ in, want string }{
		{`{"a":1}`, `{"a":1}`},
		{`{"a":"</script>"}`, `{"a":"\u003c/script>"}`},
		{`{"a":"<b>"}`, `{"a":"\u003cb>"}`},
	}
	for _, tt := range tests {
		if got := scriptSafe(tt.in); got != tt.want {
			t.Errorf("scriptSafe(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// ---- render invariants ----
//
// The page is assembled by substituting into a template, so these check the
// properties that substitution must preserve rather than pinning the exact
// bytes of a page whose styling changes often.

// dataBlock returns the contents of the <script id="data"> element, which is
// where renderPage puts the document.
func dataBlock(t *testing.T, page string) string {
	t.Helper()
	const open = `<script id="data" type="application/json">`
	i := strings.Index(page, open)
	if i < 0 {
		t.Fatal("page has no data block")
	}
	rest := page[i+len(open):]
	j := strings.Index(rest, "</script>")
	if j < 0 {
		t.Fatal("data block is not closed")
	}
	return rest[:j]
}

func TestRenderPageSubstitutesEveryPlaceholder(t *testing.T) {
	page := renderPage([]byte(`{"a":1}`), "doc.json", options{jq: false})
	if i := strings.Index(page, "{{"); i >= 0 {
		t.Errorf("page still contains a placeholder at offset %d: %.20q", i, page[i:])
	}
}

func TestRenderPageInlinesAssets(t *testing.T) {
	page := renderPage([]byte(`{}`), "t", options{jq: false})
	for _, want := range []string{
		"<style>",       // the shell
		"color-scheme",  // from page.css
		"parseJSON",     // from core.js
		"function run(", // from page.js
		`id="tree"`,     // the mount point the script writes into
		`id="results"`,  // where a query's output goes
		`id="q"`,        // the search box
		`id="suggest"`,  // the list of queries a line could mean
		`id="mode"`,     // what the search box means
		`id="stats"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("page does not contain %q", want)
		}
	}
}

// The query engine is the largest part of the script, and --simple is the only
// thing that leaves it out.
func TestRenderPageLeavesTheEngineOutOnlyForSimple(t *testing.T) {
	full := renderPage([]byte(`{}`), "t", options{jq: true})
	simple := renderPage([]byte(`{}`), "t", options{jq: false})

	for _, want := range []string{
		"var jqjs",          // the engine
		"function compile(", // its entry point
		"'sort_by/1'",       // its builtin table
		"var jqsuggest",     // the queries it offers for a line
		"var jqui",          // the search box wiring that drives both
		"function showResults(",
	} {
		if !strings.Contains(full, want) {
			t.Errorf("page does not contain %q", want)
		}
		if strings.Contains(simple, want) {
			t.Errorf("--simple page contains %q", want)
		}
	}
	if len(simple) >= len(full) {
		t.Errorf("--simple page is %d bytes, no smaller than the %d without it",
			len(simple), len(full))
	}
	// Both are still whole pages, not one with a hole in it.
	for _, page := range []string{full, simple} {
		if i := strings.Index(page, "{{"); i >= 0 {
			t.Errorf("page still contains a placeholder at offset %d", i)
		}
	}
}

func TestRenderPageRoundTripsTheDocument(t *testing.T) {
	docs := []string{
		`{"a":[1,2,{"b":null}],"c":"x"}`,
		`[]`,
		`"just a string"`,
		`{"unicode":"héllo   😀","tab":"\t"}`,
		`{"big":123456789012345678901234567890}`,
	}
	for _, doc := range docs {
		block := dataBlock(t, renderPage([]byte(doc), "t", options{jq: false}))
		var got, want any
		if err := json.Unmarshal([]byte(block), &got); err != nil {
			t.Errorf("data block for %s does not parse: %v", doc, err)
			continue
		}
		if err := json.Unmarshal([]byte(doc), &want); err != nil {
			t.Fatalf("test input %s is not valid JSON: %v", doc, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("data block for %s parsed as %#v, want %#v", doc, got, want)
		}
	}
}

// A string value containing "</script" must not be able to close the element
// holding the document.
func TestRenderPageDataCannotEscapeItsElement(t *testing.T) {
	doc := `{"payload":"</script><script>alert(1)</script>"}`
	page := renderPage([]byte(doc), "t", options{jq: false})
	block := dataBlock(t, page)
	if strings.Contains(block, "</script") {
		t.Errorf("data block contains a literal </script: %s", block)
	}
	if strings.Contains(page, "alert(1)</script>") {
		t.Error("page contains an unescaped injected script element")
	}
	var got map[string]string
	if err := json.Unmarshal([]byte(block), &got); err != nil {
		t.Fatalf("escaped data block does not parse: %v", err)
	}
	if want := "</script><script>alert(1)</script>"; got["payload"] != want {
		t.Errorf("payload = %q, want %q", got["payload"], want)
	}
}

// Substitution is a single pass, so placeholder text inside the document or
// the title is data, not a placeholder to expand.
func TestRenderPageDoesNotRescanSubstitutions(t *testing.T) {
	page := renderPage([]byte(`{"a":"{{TITLE}}"}`), "t", options{jq: false})
	if !strings.Contains(dataBlock(t, page), `{{TITLE}}`) {
		t.Error("a document containing {{TITLE}} had it substituted away")
	}

	page = renderPage([]byte(`{"a":1}`), "{{DATA}}", options{jq: false})
	if strings.Count(page, `{{DATA}}`) != 2 { // the <title> and the header
		t.Error("a title containing {{DATA}} had it substituted away")
	}
}

func TestRenderPageEscapesTitle(t *testing.T) {
	page := renderPage([]byte(`{}`), `<img src=x onerror="alert(1)">`, options{jq: false})
	if strings.Contains(page, "<img src=x") {
		t.Error("page contains an unescaped title")
	}
	if !strings.Contains(page, "&lt;img src=x") {
		t.Error("page does not contain the escaped title")
	}
}

func TestRenderPageStartsInTheThemeAskedFor(t *testing.T) {
	for _, want := range []string{"auto", "light", "dark"} {
		page := renderPage([]byte(`{}`), "t", options{theme: want})
		if got := `<html lang="en" data-pref="` + want + `">`; !strings.Contains(page, got) {
			t.Errorf("page for --theme %s does not carry %q", want, got)
		}
	}
	// The palette itself is settled before the body is parsed, so that a page
	// never shows one theme and then swaps to the other.
	page := renderPage([]byte(`{}`), "t", options{theme: "auto"})
	head := page[:strings.Index(page, "</head>")]
	if !strings.Contains(head, "prefers-color-scheme") {
		t.Error("the theme is not settled in the head")
	}
	if !strings.Contains(page, `--theme="light"`) && !strings.Contains(page, `[data-theme="light"]`) {
		t.Error("the page has no light palette")
	}
}

func TestStripComments(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"whole line", "a();\n/* note */\nb();", "a();\nb();"},
		{"trailing", "a(); /* note */", "a();"},
		{"leading", "/* note */ a();", " a();"},
		{"multi-line", "a();\n/* one\n   two */\nb();", "a();\nb();"},
		{"code either side of a multi-line comment", "a(); /* one\n   two */ b();", "a();\n b();"},
		{"two on one line", "a(); /* x */ b(); /* y */", "a();  b();"},
		{"blank lines go too", "a();\n\n\nb();", "a();\nb();"},
		{"nothing to do", "a();\nb();", "a();\nb();"},

		// A "/*" that is not a comment must survive.
		{"in a single-quoted string", `var s = '/* not a comment */';`, `var s = '/* not a comment */';`},
		{"in a double-quoted string", `var s = "/* no */";`, `var s = "/* no */";`},
		{"in a template literal", "var s = `/* no */`;", "var s = `/* no */`;"},
		{"after an escaped quote", `var s = 'it\'s /* no */';`, `var s = 'it\'s /* no */';`},
		{"a real comment after a string", `var s = 'x'; /* note */`, `var s = 'x';`},

		// Lines the reader gives up on are emitted exactly as written.
		{"regular expression", `var re = /[/*]/;`, `var re = /[/*]/;`},
		{"regular expression with a comment", `var re = /a/; /* note */`, `var re = /a/; /* note */`},
		{"division", `var x = a / b; /* note */`, `var x = a / b; /* note */`},
		{"unterminated template literal", "var s = `open; /* note */", "var s = `open; /* note */"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := stripComments(tt.in); got != tt.want {
				t.Errorf("stripComments(%q)\n got %q\nwant %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestStripCommentsIsIdempotent(t *testing.T) {
	for _, name := range []string{"web/theme.js", "web/core.js", "web/jq.js", "web/suggest.js", "web/query.js", "web/page.js"} {
		once := stripComments(asset(name))
		if twice := stripComments(once); twice != once {
			t.Errorf("%s: stripping twice differs from stripping once", name)
		}
	}
}

// stripComments gives up on any line where a "/" turns up outside a string
// without a "*" after it, and emits that line as written -- comment and all.
// A regular expression or a division in the scripts can trip that, so no page
// should carry a comment opener at all. The stylesheet is inlined as written,
// so this covers it too.
func TestPageCarriesNoComments(t *testing.T) {
	for _, jq := range []bool{false, true} {
		page := renderPage([]byte(`{"a":1}`), "t", options{jq: jq})
		if i := strings.Index(page, "/*"); i >= 0 {
			line := 1 + strings.Count(page[:i], "\n")
			t.Errorf("page with jq=%v carries a comment at line %d: %.70q", jq, line, page[i:])
		}
	}
}

// The comments go, the code stays.
func TestPageShipsWithoutComments(t *testing.T) {
	page := renderPage([]byte(`{"a":1}`), "t", options{jq: false})
	for _, gone := range []string{
		"Pure helpers shared by the page", // core.js file comment
		"recursive-descent scanner",       // inside parseJSON
		"the reader's, not the search's",  // inside page.js
	} {
		if strings.Contains(page, gone) {
			t.Errorf("page still contains the comment %q", gone)
		}
	}
	for _, want := range []string{
		"function parseJSON(src)",
		"return segs.length ? segs : null;",
		`var escMap = { '&': '&amp;',`,
		"function textFilter(needle)",
		`var pathChar = /[^.[\]"'\s]/;`, // a line the stripper leaves alone
	} {
		if !strings.Contains(page, want) {
			t.Errorf("page is missing the code %q", want)
		}
	}
}

func TestInlineTrimsOnlyTheTrailingNewline(t *testing.T) {
	css := asset("web/page.css")
	if !strings.HasSuffix(css, "\n") {
		t.Fatal("web/page.css does not end with a newline")
	}
	if got, want := inline("web/page.css"), strings.TrimSuffix(css, "\n"); got != want {
		t.Error("inline() did not trim exactly one trailing newline")
	}
}
