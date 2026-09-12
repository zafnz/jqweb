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

//go:embed web/page.html web/page.css web/query.css web/dist/theme.js web/dist/simple.js web/dist/normal.js
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
		"{{HEAD}}", inline("web/dist/theme.js"),
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

// script returns the compiled page JavaScript. The two bundles are built and
// committed separately so a --simple page carries none of the query engine.
func script(jq bool) string {
	if jq {
		return inline("web/dist/normal.js")
	}
	return inline("web/dist/simple.js")
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
