// Package testutil holds what the tests that drive a jqweb server over HTTP
// share: the client, one request, and the slack a timer is allowed.
package testutil

import (
	"io"
	"net/http"
	"testing"
	"time"
)

// Client talks to a server under test without keeping connections alive, so
// that an idle connection cannot hold up Shutdown and make the timing wrong.
var Client = &http.Client{
	Timeout:   5 * time.Second,
	Transport: &http.Transport{DisableKeepAlives: true},
}

// TimerSlack is how far ahead of its delay a timer can appear to fire when it
// is timed from outside.
const TimerSlack = 50 * time.Millisecond

// Fetch performs one request and reads the body to the end, so the connection
// is not left active behind it.
func Fetch(t *testing.T, method, url string) (status int, body string) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	resp, err := Client.Do(req)
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
