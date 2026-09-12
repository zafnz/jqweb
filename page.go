package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"html"
	"strings"
	"sync"
)

// options are the parts of the command line that change the page rather than
// where it goes.
type options struct {
	jq    bool   // inline the query engine, which --simple turns off
	theme string // auto, light or dark
	query string // what the search box starts with, if anything
}

// renderPage embeds the document in the page as compact JSON; the script in
// the template parses it and builds the tree in the browser. opt.jq selects
// the template that carries the query engine, and opt.theme is the palette the
// page starts in, which the reader can change afterwards. opt.query goes in the
// search box, which the page runs once it has built the tree.
func renderPage(data []byte, title string, opt options) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, data); err != nil {
		// check has already accepted the document, so this cannot fail.
		buf.Reset()
		buf.Write(data)
	}
	return strings.NewReplacer(
		"{{TITLE}}", html.EscapeString(title),
		"{{PREF}}", opt.theme,
		"{{QUERY}}", html.EscapeString(boxText(opt.query)),
		"{{DATA}}", scriptSafe(buf.String()),
	).Replace(pageTemplate(opt.jq))
}

// scriptSafe escapes "<" as its \u003c escape so that a string containing
// "</script" cannot end the script element holding the JSON. In JSON, "<"
// only ever appears inside a string, where \u003c denotes the same character.
func scriptSafe(s string) string {
	return strings.ReplaceAll(s, "<", `\u003c`)
}

// boxText is the query as the search box can hold it. A text input drops every
// line break from its value, which would join the words either side of one, so
// each becomes a space instead. That keeps a query written over several lines
// working unless it has a "#" comment in it, which then runs to the end.
func boxText(q string) string {
	return strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ").Replace(q)
}

//go:embed web/page.html web/page.css web/query.css web/theme.js web/core.js web/jq.js web/suggest.js web/query.js web/page.js
var assets embed.FS

// pageTemplate returns the page shell with its stylesheet and script inlined,
// leaving {{TITLE}} and {{DATA}} for renderPage to fill in. A page with the
// query engine and one without are two different scripts, so there is a
// template for each, built the first time it is wanted.
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
		"{{STYLE}}", style(jq),
		"{{HEAD}}", stripComments(inline("web/theme.js")),
		"{{SCRIPT}}", script(jq),
	).Replace(asset("web/page.html"))
}

// style returns the page's CSS. query.css styles what only a page with the
// query engine has, so it goes in only alongside it.
func style(jq bool) string {
	if !jq {
		return inline("web/page.css")
	}
	return inline("web/page.css") + "\n" + inline("web/query.css")
}

// script returns the page's JavaScript: the pure core, then the query engine
// and the search box wiring that drives it unless --simple left them out, then
// the rest of the page. query.js has to precede page.js, which calls into it.
//
// The comments in those files are written for someone reading the source, and
// are not worth inlining into every rendered page.
func script(jq bool) string {
	parts := []string{"web/core.js"}
	if jq {
		parts = append(parts, "web/jq.js", "web/suggest.js", "web/query.js")
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
