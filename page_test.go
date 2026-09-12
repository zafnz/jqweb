package main

import (
	"encoding/json"
	"html"
	"reflect"
	"strings"
	"testing"
)

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
		"<style>",      // the shell
		"color-scheme", // from page.css
		`id="tree"`,    // the mount point the script writes into
		`id="results"`, // where a query's output goes
		`id="q"`,       // the search box
		`id="suggest"`, // the list of queries a line could mean
		`id="mode"`,    // what the search box means
		`id="stats"`,
		inline("web/dist/theme.js"),
		inline("web/dist/simple.js"),
	} {
		if !strings.Contains(page, want) {
			t.Errorf("page does not contain %q", want)
		}
	}
}

// The query engine is the largest part of the script, and the two committed
// bundles keep it wholly out of a --simple page.
func TestRenderPageSelectsTheCompiledScript(t *testing.T) {
	full := renderPage([]byte(`{}`), "t", options{jq: true})
	simple := renderPage([]byte(`{}`), "t", options{jq: false})
	fullScript := inline("web/dist/full.js")
	simpleScript := inline("web/dist/simple.js")

	if !strings.Contains(full, fullScript) {
		t.Error("default page does not carry the full bundle")
	}
	if strings.Contains(full, simpleScript) {
		t.Error("default page carries the simple bundle")
	}
	if !strings.Contains(simple, simpleScript) {
		t.Error("--simple page does not carry the simple bundle")
	}
	if strings.Contains(simple, fullScript) {
		t.Error("--simple page carries the full bundle")
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

// The compiled scripts and stylesheets are inlined as written, so neither may
// carry a comment into every rendered page.
func TestPageCarriesNoComments(t *testing.T) {
	for _, jq := range []bool{false, true} {
		page := renderPage([]byte(`{"a":1}`), "t", options{jq: jq})
		if i := strings.Index(page, "/*"); i >= 0 {
			line := 1 + strings.Count(page[:i], "\n")
			t.Errorf("page with jq=%v carries a comment at line %d: %.70q", jq, line, page[i:])
		}
	}
}

func TestCompiledScriptsCannotCloseTheirElements(t *testing.T) {
	for _, name := range []string{"web/dist/theme.js", "web/dist/simple.js", "web/dist/full.js"} {
		if strings.Contains(strings.ToLower(asset(name)), "</script") {
			t.Errorf("%s contains a closing script tag", name)
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

// boxValue returns the search box's value attribute, unescaped, which is where
// renderPage puts the query.
func boxValue(t *testing.T, page string) string {
	t.Helper()
	const open = `<input id="q" type="search" value="`
	i := strings.Index(page, open)
	if i < 0 {
		t.Fatal("page has no search box with a value")
	}
	rest := page[i+len(open):]
	j := strings.IndexByte(rest, '"')
	if j < 0 {
		t.Fatal("the search box value is not closed")
	}
	return html.UnescapeString(rest[:j])
}

// The query goes in the box's value attribute. A quote in it has to stay
// inside the attribute, or the query could close the element and add markup
// of its own.
func TestRenderPageStartsWithTheQuery(t *testing.T) {
	tests := []struct{ query, want string }{
		{"", ""},
		{".items[] | .metadata.name", ".items[] | .metadata.name"},
		{`select(.kind == "Pod")`, `select(.kind == "Pod")`},
		{`"><script>alert(1)</script>`, `"><script>alert(1)</script>`},
		{"a & b", "a & b"},
		// A text input drops line breaks from its value, so each is a space.
		{".a\n| .b", ".a | .b"},
		{".a\r\nand .b", ".a and .b"},
	}
	for _, jq := range []bool{true, false} {
		for _, tt := range tests {
			page := renderPage([]byte(`{}`), "t", options{jq: jq, query: tt.query})
			if got := boxValue(t, page); got != tt.want {
				t.Errorf("jq=%v: box value for %q = %q, want %q", jq, tt.query, got, tt.want)
			}
			if strings.Contains(page, "<script>alert(1)") {
				t.Errorf("jq=%v: page carries the query's script element unescaped", jq)
			}
		}
	}
}

func TestRenderPageDoesNotRescanTheQuery(t *testing.T) {
	page := renderPage([]byte(`{"a":1}`), "t", options{query: "{{DATA}}"})
	if got := boxValue(t, page); got != "{{DATA}}" {
		t.Errorf("box value = %q, want {{DATA}} as written", got)
	}
}
