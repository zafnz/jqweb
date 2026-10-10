package check

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestNestingLimit(t *testing.T) {
	for _, shape := range []string{"array", "object", "mixed"} {
		for _, depth := range []int{127, 128, 129, 4000, 9000, 10001} {
			t.Run(fmt.Sprintf("%s/%d", shape, depth), func(t *testing.T) {
				var opens, closes strings.Builder
				for i := 0; i < depth; i++ {
					if shape == "object" || (shape == "mixed" && i%2 != 0) {
						opens.WriteString(`{"a":`)
						closes.WriteByte('}')
					} else {
						opens.WriteByte('[')
						closes.WriteByte(']')
					}
				}
				end := []byte(closes.String())
				for i, j := 0, len(end)-1; i < j; i, j = i+1, j-1 {
					end[i], end[j] = end[j], end[i]
				}
				_, err := Normalize([]byte(opens.String() + `"[{\""` + string(end)))
				if depth <= 128 {
					if err != nil {
						t.Fatal(err)
					}
				} else if err == nil || !strings.Contains(err.Error(), "JSON nesting exceeds the supported limit of 128") {
					t.Fatalf("got %v, want nesting limit error", err)
				}
			})
		}
	}
}

func TestNestingCountsEmptyContainersAndResetsForSiblings(t *testing.T) {
	child := strings.Repeat("[", 127) + strings.Repeat("]", 127)
	if _, err := Normalize([]byte("[" + child + "," + child + "]")); err != nil {
		t.Fatal(err)
	}
	if _, err := Normalize([]byte("[[" + child + "]]")); err == nil {
		t.Fatal("accepted an empty container at depth 129")
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
		if _, err := Normalize([]byte(in)); err != nil {
			t.Errorf("Normalize(%q) = %v, want nil", in, err)
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
		{"invalid UTF-8 in a string", "{\"a\":\"\xff\"}", "not valid UTF-8 (line 1, column 7)"},
		{"Latin-1 on a later line", "{\n  \"name\": \"caf\xe9\"\n}", "not valid UTF-8 (line 2, column 15)"},
		{"truncated sequence in a key", "{\"\xc3\":1}", "not valid UTF-8 (line 1, column 3)"},
		{"encoded surrogate", "[\"\xed\xa0\x80\"]", "not valid UTF-8 (line 1, column 3)"},
		{"bare word", "hello there", "does not look like JSON"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Normalize([]byte(tt.in))
			if err == nil {
				t.Fatalf("Normalize(%q) = nil, want an error containing %q", tt.in, tt.want)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("Normalize(%q) = %q, want it to contain %q", tt.in, err, tt.want)
			}
		})
	}
}

// A syntax error should be reported at the line and column of the offending
// byte, not at the end of the last token the decoder consumed.
func TestCheckReportsPosition(t *testing.T) {
	_, err := Normalize([]byte("{\n  \"a\": 1,\n  \"b\": oops\n}"))
	if err == nil {
		t.Fatal("Normalize() = nil, want an error")
	}
	if !strings.Contains(err.Error(), "line 3") {
		t.Errorf("Normalize() = %q, want it to report line 3", err)
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
		// sniff recognizes Python repr output, but Normalize() never asks: the
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

func TestNormalizeSingleDocumentKeepsOriginalBytes(t *testing.T) {
	for _, in := range []string{`{}`, `[]`, `null`, `false`, `1.50`, `"hello"`, " \n{\"z\":1e3,\"a\":123456789012345678901234567890}\t\n"} {
		data := []byte(in)
		got, err := Normalize(data)
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("Normalize(%q) = %q, %v; want unchanged input", in, got, err)
		}
		if &got[0] != &data[0] {
			t.Fatal("single document was copied")
		}
	}
}

func TestNormalizeStreams(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"objects", "{\"a\":1}\n{\"a\":2}\n", `[{"a":1},{"a":2}]`},
		{"arrays", "[1,2]\n[]", `[[1,2],[]]`},
		{"scalars", "true\nfalse\nnull\n42\n-1.50e+2\n\"text\"", `[true,false,null,42,-1.50e+2,"text"]`},
		{"whitespace", " \n{}\r\n\t\n[] \t null\n\n", "[ \n{},[],null]"},
		{"pretty printed", "{\n\"a\":1\n}\n[\n2\n]", "[{\n\"a\":1\n},[\n2\n]]"},
		{"adjacent values", `{}[]"x"true`, `[{},[],"x",true]`},
		{"numbers and key order", "{\"z\":1.50,\"a\":123456789012345678901234567890}\n-0.0", `[{"z":1.50,"a":123456789012345678901234567890},-0.0]`},
		{"escaped strings", `"a\nb" "\u0041"`, `["a\nb","\u0041"]`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Normalize([]byte(tt.in))
			if err != nil || string(got) != tt.want {
				t.Fatalf("Normalize(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
			}
			if _, err := Normalize(got); err != nil {
				t.Fatalf("wrapped document is invalid: %v", err)
			}
		})
	}
}

func TestNormalizeMalformedStreams(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"junk in second value", "{}\noops", "line 2, column 1"},
		{"junk after valid values", "{}\n[]\noops", "line 3, column 1"},
		{"invalid later object", "{}\n{\"a\":1}\n{\"b\":oops}", "line 3, column 6"},
		{"later trailing comma", "{}\n{\"a\":1,}", "trailing comma"},
		{"later comment", "{}\n[/*oops*/]", "JSON has no comments"},
		{"later single quotes", "{}\n{'a':1}", "JSON strings use double quotes"},
		{"unclosed later object", "{}\n[]\n{", "truncated"},
		{"unclosed later string", "null\n\"oops", "truncated"},
		{"incomplete number", "0\n1e", "truncated"},
		{"extra closing array", `[]]`, "line 1, column 3"},
		{"extra closing object", `{}}`, "line 1, column 3"},
		{"comma separated", `{}, {}`, "line 1, column 3"},
		{"non JSON whitespace", "{}\u00a0{}", "line 1, column 3"},
		{"later invalid UTF-8", "{}\n\"\xff\"", "not valid UTF-8 (line 2, column 2)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Normalize([]byte(tt.in))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Normalize(%q) = %q, %v; want error containing %q", tt.in, got, err, tt.want)
			}
			if got != nil {
				t.Fatalf("malformed stream returned partial data: %q", got)
			}
		})
	}
}

func TestNormalizeStreamNestingLimit(t *testing.T) {
	for _, depth := range []int{127, 128, 129, 10001} {
		deep := strings.Repeat("[", depth) + "0" + strings.Repeat("]", depth)
		for _, in := range []string{deep + "\n0", "0\n" + deep, "0\n[]\n" + deep} {
			got, err := Normalize([]byte(in))
			if depth == 127 {
				if err != nil {
					t.Fatalf("depth %d: %v", depth, err)
				}
				if _, err := Normalize(got); err != nil {
					t.Fatalf("wrapped depth %d: %v", depth, err)
				}
			} else if !errors.Is(err, errNesting) || got != nil {
				t.Fatalf("depth %d: got %q, %v; want nesting error", depth, got, err)
			}
		}
	}
}

func TestNormalizeDistinguishesTrailingDataFromMalformedStreams(t *testing.T) {
	for _, tt := range []struct{ in, prefix string }{
		{"{}\noops", "trailing data after top-level value:"},
		{"{}\n{\"a\":oops}", "trailing data after top-level value:"},
		{"{}\n{", "trailing data after top-level value:"},
		{"{}\n[]\noops", "invalid JSON value in stream:"},
		{"{}\n[]\n{", "invalid JSON value in stream:"},
	} {
		_, err := Normalize([]byte(tt.in))
		if err == nil || !strings.HasPrefix(err.Error(), tt.prefix) {
			t.Errorf("Normalize(%q) = %v; want prefix %q", tt.in, err, tt.prefix)
		}
	}
}

func TestNormalizeStreamCountsEmptyFirstContainer(t *testing.T) {
	for _, depth := range []int{127, 128} {
		empty := strings.Repeat("[", depth) + strings.Repeat("]", depth)
		_, err := Normalize([]byte(empty + "\n0"))
		if depth == 127 && err != nil {
			t.Fatalf("empty depth %d: %v", depth, err)
		}
		if depth == 128 && !errors.Is(err, errNesting) {
			t.Fatalf("empty depth %d: got %v; want nesting error", depth, err)
		}
	}
}
