package page

import (
	"bytes"
	"encoding/json"
	"html"
	"strings"
	"sync"

	"github.com/zafnz/jqweb/web"
)

// Options are the parts of the command line that change the page rather than
// where it goes.
type Options struct {
	JQ     bool   // inline the query engine, which --simple turns off
	Theme  string // auto, light or dark
	Query  string // what the search box starts with, if anything
	Served bool   // the page is served, so it holds /alive open
}

// Render embeds the document in the page as compact JSON; the script in
// the template parses it and builds the tree in the browser. opt.JQ selects
// the template that carries the query engine, and opt.Theme is the palette the
// page starts in, which the reader can change afterwards. opt.Query goes in the
// search box, which the page runs once it has built the tree.
func Render(data []byte, title string, opt Options) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, data); err != nil {
		// check has already accepted the document, so this cannot fail.
		buf.Reset()
		buf.Write(data)
	}
	return strings.NewReplacer(
		"{{TITLE}}", html.EscapeString(title),
		"{{PREF}}", opt.Theme,
		"{{SERVED}}", servedAttr(opt.Served),
		"{{QUERY}}", html.EscapeString(boxText(opt.Query)),
		"{{DATA}}", scriptSafe(buf.String()),
	).Replace(pageTemplate(opt.JQ))
}

// servedAttr marks the root element of a page jqweb serves. The page script
// opens /alive only when it is there, so a page written with -o, or published
// from one, makes no request for it.
func servedAttr(served bool) string {
	if served {
		return " data-served"
	}
	return ""
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

// pageTemplate returns the page shell with its stylesheet and script inlined,
// leaving {{TITLE}} and {{DATA}} for Render to fill in. A page with the
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
		"{{HEAD}}", inline("dist/theme.js"),
		"{{SCRIPT}}", script(jq),
	).Replace(asset("page.html"))
}

// style returns the page's CSS. query.css styles what only a page with the
// query engine has, so it goes in only alongside it.
func style(jq bool) string {
	if !jq {
		return inline("styles/page.css")
	}
	return inline("styles/page.css") + "\n" + inline("styles/query.css")
}

// script returns the compiled page JavaScript. The two bundles are built and
// committed separately so a --simple page carries none of the query engine.
func script(jq bool) string {
	if jq {
		return inline("dist/full.js")
	}
	return inline("dist/simple.js")
}

// asset returns the contents of an embedded file.
func asset(name string) string {
	b, err := web.Assets.ReadFile(name)
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
