package main

import (
	"strings"
	"testing"
)

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
