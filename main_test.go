package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
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
	page := renderPage([]byte(`{"a":1}`), "doc.json", false)
	if i := strings.Index(page, "{{"); i >= 0 {
		t.Errorf("page still contains a placeholder at offset %d: %.20q", i, page[i:])
	}
}

func TestRenderPageInlinesAssets(t *testing.T) {
	page := renderPage([]byte(`{}`), "t", false)
	for _, want := range []string{
		"<style>",       // the shell
		"color-scheme",  // from page.css
		"parseJSON",     // from core.js
		"function run(", // from page.js
		`id="tree"`,     // the mount point the script writes into
		`id="results"`,  // where a query's output goes
		`id="q"`,        // the search box
		`id="mode"`,     // what the search box means
		`id="stats"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("page does not contain %q", want)
		}
	}
}

// The query engine is the largest part of the script, so it goes in only when
// --jq asked for it.
func TestRenderPageIncludesTheEngineOnlyWithJQ(t *testing.T) {
	with := renderPage([]byte(`{}`), "t", true)
	without := renderPage([]byte(`{}`), "t", false)

	for _, want := range []string{
		"var jqjs",          // the engine
		"function compile(", // its entry point
		"'sort_by/1'",       // its builtin table
		"var jqui",          // the search box wiring that drives it
		"function showResults(",
	} {
		if !strings.Contains(with, want) {
			t.Errorf("--jq page does not contain %q", want)
		}
		if strings.Contains(without, want) {
			t.Errorf("page built without --jq contains %q", want)
		}
	}
	if len(with) <= len(without) {
		t.Errorf("--jq page is %d bytes, no bigger than the %d without", len(with), len(without))
	}
	// Both are still whole pages, not one with a hole in it.
	for _, page := range []string{with, without} {
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
		block := dataBlock(t, renderPage([]byte(doc), "t", false))
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
	page := renderPage([]byte(doc), "t", false)
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
	page := renderPage([]byte(`{"a":"{{TITLE}}"}`), "t", false)
	if !strings.Contains(dataBlock(t, page), `{{TITLE}}`) {
		t.Error("a document containing {{TITLE}} had it substituted away")
	}

	page = renderPage([]byte(`{"a":1}`), "{{DATA}}", false)
	if strings.Count(page, `{{DATA}}`) != 2 { // the <title> and the header
		t.Error("a title containing {{DATA}} had it substituted away")
	}
}

func TestRenderPageEscapesTitle(t *testing.T) {
	page := renderPage([]byte(`{}`), `<img src=x onerror="alert(1)">`, false)
	if strings.Contains(page, "<img src=x") {
		t.Error("page contains an unescaped title")
	}
	if !strings.Contains(page, "&lt;img src=x") {
		t.Error("page does not contain the escaped title")
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
	for _, name := range []string{"web/core.js", "web/jq.js", "web/query.js", "web/page.js"} {
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
		page := renderPage([]byte(`{"a":1}`), "t", jq)
		if i := strings.Index(page, "/*"); i >= 0 {
			line := 1 + strings.Count(page[:i], "\n")
			t.Errorf("page with jq=%v carries a comment at line %d: %.70q", jq, line, page[i:])
		}
	}
}

// The comments go, the code stays.
func TestPageShipsWithoutComments(t *testing.T) {
	page := renderPage([]byte(`{"a":1}`), "t", false)
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
