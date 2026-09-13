package serve

import (
	"bytes"
	"strings"
	"testing"
)

func TestRelayLinesSeesTheReadyLine(t *testing.T) {
	var out bytes.Buffer
	in := "jqweb: serving on http://127.0.0.1:1/ (until the last tab closes)\n" +
		ReadyLine + ", pid 12\n"
	if !relayLines(&out, strings.NewReader(in), ReadyLine) {
		t.Error("relayLines did not report the ready line")
	}
	if out.String() != in {
		t.Errorf("relayed %q, want %q", out.String(), in)
	}

	out.Reset()
	in = "jqweb: bad.json: unexpected end of input" // no trailing newline
	if relayLines(&out, strings.NewReader(in), ReadyLine) {
		t.Error("relayLines reported a ready line that was not there")
	}
	if out.String() != in {
		t.Errorf("relayed %q, want %q", out.String(), in)
	}
}
