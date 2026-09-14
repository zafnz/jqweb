package check

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// Each JSON level adds two HTML wrappers; stay below browser DOM limits as
// well as JavaScript stack limits. Keep in sync with web/src/model/nesting.ts.
const maxDepth = 128

var errNesting = fmt.Errorf("JSON nesting exceeds the supported limit of %d", maxDepth)

// Document checks for one well-formed JSON document within the nesting limit.
// The page embeds the document itself and renders it in the browser, so
// nothing is kept from this pass but the error.
func Document(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := checkValue(dec, 0); err != nil {
		if errors.Is(err, errNesting) {
			return err
		}
		return describe(data, err)
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

// checkValue reads one JSON value from dec, recursing into containers, and
// returns the decoder's error if it is not well formed.
func checkValue(dec *json.Decoder, depth int) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return nil
	}
	if (d == '[' || d == '{') && depth >= maxDepth {
		return errNesting
	}
	switch d {
	case '[':
		for dec.More() {
			if err := checkValue(dec, depth+1); err != nil {
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
			if err := checkValue(dec, depth+1); err != nil {
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

// describe turns the decoder's error into the message the user sees: what
// kind of input this is when it is not JSON at all, and the line and column
// of the fault, with a hint for the common near-JSON dialects, when it is.
func describe(data []byte, err error) error {
	if isTruncated(err) {
		if len(bytes.TrimSpace(data)) == 0 {
			return fmt.Errorf("empty input")
		}
		return fmt.Errorf("unexpected end of input; the document is truncated")
	}
	what, binary := sniff(data)
	if binary {
		return fmt.Errorf("input is not JSON; it is %s", what)
	}
	if !startsJSON(data) {
		return notJSON(data, what)
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
		if end := identEnd(data, i); end < len(data) && data[end] == ':' {
			return "object keys must be double-quoted strings"
		}
	}
	return ""
}

// lastNonSpace is the index of the last byte of b that is not JSON
// whitespace, or -1.
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

// isIdentStart reports whether c can begin a JavaScript identifier, which is
// what an unquoted key in near-JSON looks like.
func isIdentStart(c byte) bool {
	return c == '_' || c == '$' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// identEnd is the index just past the identifier starting at data[i].
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
// the format sniff guessed when it made one and quoting the start of the
// input otherwise.
func notJSON(data []byte, what string) error {
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
	if len(head) < len(s) {
		// The cut can land inside a rune, which is at most four bytes; drop
		// the partial one rather than call the input binary for it.
		for n := 0; n < utf8.UTFMax-1 && !utf8.Valid(head); n++ {
			head = head[:len(head)-1]
		}
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

// lineCol is the one-based line and column of the byte at off, with off
// clamped to the end of data. The column counts bytes.
func lineCol(data []byte, off int64) (int, int) {
	if off > int64(len(data)) {
		off = int64(len(data))
	}
	prefix := data[:off]
	line := bytes.Count(prefix, []byte{'\n'}) + 1
	col := int(off) - bytes.LastIndexByte(prefix, '\n')
	return line, col
}
