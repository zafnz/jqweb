package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// testClient talks to the servers below without keeping connections alive, so
// that an idle connection cannot hold up Shutdown and make the timing wrong.
var testClient = &http.Client{
	Timeout:   5 * time.Second,
	Transport: &http.Transport{DisableKeepAlives: true},
}

const closeTimerSlack = 50 * time.Millisecond

// startServer serves page on a listener of its own, and returns the URL, the
// listener, and a channel carrying what serveOn returned.
func startServer(t *testing.T, page []byte, opt serveOptions) (url string, ln net.Listener, done <-chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ch := make(chan error, 1)
	go func() { ch <- serveOn(ln, page, opt) }()
	return "http://" + ln.Addr().String() + "/", ln, ch
}

// fetch performs one request and reads the body to the end, so the connection
// is not left active behind it.
func fetch(t *testing.T, method, url string) (status int, body string) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	resp, err := testClient.Do(req)
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

// hold opens /alive the way a served page does and keeps the connection until
// the function it returns is called. It is a raw connection so that closing it
// is what the browser does when a tab unloads, with no client pool in between.
// It returns once the status line has arrived, by which point the server has
// counted it.
func hold(t *testing.T, url string) (release func()) {
	t.Helper()
	addr := strings.TrimSuffix(strings.TrimPrefix(url, "http://"), "/")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	fmt.Fprintf(conn, "GET /alive HTTP/1.1\r\nHost: %s\r\n\r\n", addr)
	status, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		conn.Close()
		t.Fatalf("GET /alive: %v", err)
	}
	if !strings.HasPrefix(status, "HTTP/1.1 200 ") {
		conn.Close()
		t.Fatalf("GET /alive = %q, want 200", status)
	}
	return func() { conn.Close() }
}

// stillServing fails the test if serveOn has returned.
func stillServing(t *testing.T, done <-chan error, when string) {
	t.Helper()
	select {
	case err := <-done:
		t.Fatalf("stopped %s (serveOn returned %v)", when, err)
	default:
	}
}

// stopsAfter fails the test unless serveOn returns nil, no sooner than delay
// after since.
func stopsAfter(t *testing.T, done <-chan error, since time.Time, delay time.Duration) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil for a shutdown that was asked for", err)
		}
		if waited := time.Since(since); waited+closeTimerSlack < delay {
			t.Errorf("stopped %s after the last tab closed, before the %s delay", waited, delay)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the last tab closed")
	}
}

func TestServeSendsThePage(t *testing.T) {
	page := []byte("<html>the document</html>")
	url, ln, done := startServer(t, page, serveOptions{})
	defer func() {
		ln.Close()
		<-done
	}()

	status, body := fetch(t, http.MethodGet, url)
	if status != http.StatusOK || body != string(page) {
		t.Errorf("GET / = %d %q, want 200 and the page", status, body)
	}
	if status, _ := fetch(t, http.MethodGet, url+"elsewhere"); status != http.StatusNotFound {
		t.Errorf("GET /elsewhere = %d, want 404", status)
	}
}

func TestServeStopsAfterTheFetch(t *testing.T) {
	const delay = 300 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	start := time.Now()
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", status)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil for a shutdown that was asked for", err)
		}
		if waited := time.Since(start); waited+closeTimerSlack < delay {
			t.Errorf("stopped %s after the fetch, before the %s delay", waited, delay)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the page was fetched")
	}
}

// A reload, a second reader, or a prefetch that beat the reader to it all have
// to keep the server up rather than end it, which is the whole reason for the
// delay. The timings here assume the fetches land within about 150ms of when
// they are asked for.
func TestServeFetchRestartsTheCloseTimer(t *testing.T) {
	const delay = 600 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("first GET / = %d, want 200", status)
	}
	time.Sleep(delay / 2)
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("second GET / = %d, want 200", status)
	}

	// Past one delay since the first fetch: reachable only because the second
	// one restarted the timer.
	time.Sleep(delay * 3 / 4)
	status, _ := fetch(t, http.MethodGet, url)
	last := time.Now()
	if status != http.StatusOK {
		t.Fatalf("third GET / = %d, want 200: the fetches did not restart the close timer", status)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil", err)
		}
		if waited := time.Since(last); waited+closeTimerSlack < delay {
			t.Errorf("stopped %s after the last fetch, before the %s delay", waited, delay)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the last fetch")
	}
}

func TestServeKeepsServingWithoutClose(t *testing.T) {
	const delay = 100 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeDelay: delay})
	defer func() {
		ln.Close()
		<-done
	}()

	fetch(t, http.MethodGet, url)
	hold(t, url)()
	time.Sleep(5 * delay)
	stillServing(t, done, "without -C after a tab closed; a delay alone must not end the server")
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Errorf("GET / = %d after the delay passed, want 200", status)
	}
}

// A HEAD is how a link scanner checks that a URL is there. Nobody has read the
// page, so it must not start the clock.
func TestServeHeadDoesNotStartTheCloseTimer(t *testing.T) {
	const delay = 150 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	fetch(t, http.MethodHead, url)
	time.Sleep(5 * delay)
	select {
	case err := <-done:
		t.Fatalf("stopped after a HEAD (returned %v); only a GET of / counts as a fetch", err)
	default:
	}
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d after a HEAD, want 200", status)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the GET that followed the HEAD")
	}
}

func TestBrowserCommandPrefersBrowserEnvironment(t *testing.T) {
	cmd := browserCommand("code-browser", "linux", "http://127.0.0.1:1234/")
	want := []string{"code-browser", "http://127.0.0.1:1234/"}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Errorf("browser command = %#v, want %#v", cmd.Args, want)
	}
}

func TestBrowserCommandFallsBackForOS(t *testing.T) {
	tests := []struct {
		name string
		goos string
		want []string
	}{
		{"macOS", "darwin", []string{"open", "http://127.0.0.1:1234/"}},
		{"Windows", "windows", []string{"cmd", "/c", "start", "", "http://127.0.0.1:1234/"}},
		{"Other", "linux", []string{"xdg-open", "http://127.0.0.1:1234/"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := browserCommand("", tt.goos, "http://127.0.0.1:1234/")
			if !reflect.DeepEqual(cmd.Args, tt.want) {
				t.Errorf("browser command = %#v, want %#v", cmd.Args, tt.want)
			}
		})
	}
}

// An open tab keeps the server up however long it stays open, and closing it
// starts the delay.
func TestServeAliveKeepsServing(t *testing.T) {
	const delay = 150 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	fetch(t, http.MethodGet, url)
	release := hold(t, url)
	time.Sleep(5 * delay)
	stillServing(t, done, "with a tab open")
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d with a tab open, want 200", status)
	}
	time.Sleep(5 * delay)
	stillServing(t, done, "with a tab open after a second fetch")

	release()
	stopsAfter(t, done, time.Now(), delay)
}

func TestServeClosingOneOfTwoTabsKeepsServing(t *testing.T) {
	const delay = 150 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	first := hold(t, url)
	second := hold(t, url)
	first()
	time.Sleep(5 * delay)
	stillServing(t, done, "with one of two tabs still open")

	second()
	stopsAfter(t, done, time.Now(), delay)
}

// A reload fetches the page, then the old page unloads, then the new one opens
// its own connection. The gap between the last two is what the delay covers.
func TestServeReloadKeepsServing(t *testing.T) {
	const delay = 400 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay})
	defer ln.Close()

	old := hold(t, url)
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", status)
	}
	old()
	time.Sleep(delay / 4)
	reloaded := hold(t, url)
	time.Sleep(3 * delay)
	stillServing(t, done, "across a reload")

	reloaded()
	stopsAfter(t, done, time.Now(), delay)
}

// Nothing ever loads the page, so -C gives up once the first-load wait is over,
// and not at the close delay.
func TestServeStopsWhenThePageIsNeverLoaded(t *testing.T) {
	const delay, firstLoad = 50 * time.Millisecond, 400 * time.Millisecond
	start := time.Now()
	_, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay, firstLoad: firstLoad})
	defer ln.Close()
	stopsAfter(t, done, start, firstLoad)
}

// The link is clicked well after the close delay: the page is still there, and
// from the first load on the close delay is what counts.
func TestServeWaitsForTheFirstLoad(t *testing.T) {
	const delay, firstLoad = 150 * time.Millisecond, 5 * time.Second
	start := time.Now()
	url, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay, firstLoad: firstLoad})
	defer ln.Close()

	time.Sleep(5 * delay)
	stillServing(t, done, "before the page was first loaded")
	if status, _ := fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", status)
	}
	hold(t, url)()
	stopsAfter(t, done, time.Now(), delay)
	if took := time.Since(start); took >= firstLoad {
		t.Errorf("stopped %s after starting, which is the first-load wait rather than the close delay", took)
	}
}

// A --close-delay longer than the first-load wait is not cut short by it.
func TestServeFirstLoadWaitIsNoShorterThanTheCloseDelay(t *testing.T) {
	const delay, firstLoad = 400 * time.Millisecond, 100 * time.Millisecond
	start := time.Now()
	_, ln, done := startServer(t, []byte("page"), serveOptions{closeOnGet: true, closeDelay: delay, firstLoad: firstLoad})
	defer ln.Close()
	stopsAfter(t, done, start, delay)
}
