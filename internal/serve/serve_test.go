package serve

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/zafnz/jqweb/internal/testutil"
)

// startServer serves page on a listener of its own, and returns the URL, the
// listener, and a channel carrying what serveOn returned.
func startServer(t *testing.T, page []byte, opt Options) (url string, ln net.Listener, done <-chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ch := make(chan error, 1)
	go func() { ch <- serveOn(ln, page, opt) }()
	return "http://" + ln.Addr().String() + "/", ln, ch
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
		if waited := time.Since(since); waited+testutil.TimerSlack < delay {
			t.Errorf("stopped %s after the last tab closed, before the %s delay", waited, delay)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the last tab closed")
	}
}

func TestServeSendsThePage(t *testing.T) {
	page := []byte("<html>the document</html>")
	url, ln, done := startServer(t, page, Options{})
	defer func() {
		ln.Close()
		<-done
	}()

	status, body := testutil.Fetch(t, http.MethodGet, url)
	if status != http.StatusOK || body != string(page) {
		t.Errorf("GET / = %d %q, want 200 and the page", status, body)
	}
	if status, _ := testutil.Fetch(t, http.MethodGet, url+"elsewhere"); status != http.StatusNotFound {
		t.Errorf("GET /elsewhere = %d, want 404", status)
	}
}

func TestServeStopsAfterTheFetch(t *testing.T) {
	const delay = 300 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: delay, FirstLoad: delay})
	defer ln.Close()

	start := time.Now()
	if status, _ := testutil.Fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", status)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil for a shutdown that was asked for", err)
		}
		if waited := time.Since(start); waited+testutil.TimerSlack < delay {
			t.Errorf("stopped %s after the fetch, before the %s delay", waited, delay)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the page was fetched")
	}
}

// A second reader, or a prefetch that beat the reader to the page, restarts
// the wait for a page to open rather than ending it. The timings here assume
// the fetches land within about 150ms of when they are asked for.
func TestServeFetchRestartsTheWait(t *testing.T) {
	const delay = 600 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: delay, FirstLoad: delay})
	defer ln.Close()

	if status, _ := testutil.Fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("first GET / = %d, want 200", status)
	}
	time.Sleep(delay / 2)
	if status, _ := testutil.Fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("second GET / = %d, want 200", status)
	}

	// Past one delay since the first fetch: reachable only because the second
	// one restarted the timer.
	time.Sleep(delay * 3 / 4)
	status, _ := testutil.Fetch(t, http.MethodGet, url)
	last := time.Now()
	if status != http.StatusOK {
		t.Fatalf("third GET / = %d, want 200: the fetches did not restart the wait", status)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveOn returned %v, want nil", err)
		}
		if waited := time.Since(last); waited+testutil.TimerSlack < delay {
			t.Errorf("stopped %s after the last fetch, before the %s delay", waited, delay)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving 10s after the last fetch")
	}
}

func TestServeKeepsServingWithoutClose(t *testing.T) {
	const delay = 100 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), Options{CloseDelay: delay})
	defer func() {
		ln.Close()
		<-done
	}()

	testutil.Fetch(t, http.MethodGet, url)
	hold(t, url)()
	time.Sleep(5 * delay)
	stillServing(t, done, "without -C after a tab closed; a delay alone must not end the server")
	if status, _ := testutil.Fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Errorf("GET / = %d after the delay passed, want 200", status)
	}
}

// A HEAD is how a link scanner checks that a URL is there. Nobody is opening
// the page, so it must not restart the wait for one.
func TestServeHeadDoesNotRestartTheWait(t *testing.T) {
	const firstLoad = 400 * time.Millisecond
	start := time.Now()
	url, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: 50 * time.Millisecond, FirstLoad: firstLoad})
	defer ln.Close()

	time.Sleep(firstLoad / 2)
	testutil.Fetch(t, http.MethodHead, url)
	stopsAfter(t, done, start, firstLoad)
	// Restarted by the HEAD, the wait would have run to 600ms.
	if took := time.Since(start); took > firstLoad+firstLoad/3 {
		t.Errorf("stopped %s after starting; the HEAD at %s restarted the %s wait", took, firstLoad/2, firstLoad)
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
	url, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: delay, FirstLoad: delay})
	defer ln.Close()

	testutil.Fetch(t, http.MethodGet, url)
	release := hold(t, url)
	time.Sleep(5 * delay)
	stillServing(t, done, "with a tab open")
	if status, _ := testutil.Fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d with a tab open, want 200", status)
	}
	time.Sleep(5 * delay)
	stillServing(t, done, "with a tab open after a second fetch")

	release()
	stopsAfter(t, done, time.Now(), delay)
}

func TestServeClosingOneOfTwoTabsKeepsServing(t *testing.T) {
	const delay = 150 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: delay, FirstLoad: delay})
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
	url, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: delay, FirstLoad: delay})
	defer ln.Close()

	old := hold(t, url)
	if status, _ := testutil.Fetch(t, http.MethodGet, url); status != http.StatusOK {
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
	_, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: delay, FirstLoad: firstLoad})
	defer ln.Close()
	stopsAfter(t, done, start, firstLoad)
}

// The link is clicked well after the close delay: the page is still there, and
// from the first load on the close delay is what counts.
func TestServeWaitsForTheFirstLoad(t *testing.T) {
	const delay, firstLoad = 150 * time.Millisecond, 5 * time.Second
	start := time.Now()
	url, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: delay, FirstLoad: firstLoad})
	defer ln.Close()

	time.Sleep(5 * delay)
	stillServing(t, done, "before the page was first loaded")
	if status, _ := testutil.Fetch(t, http.MethodGet, url); status != http.StatusOK {
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
	_, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: delay, FirstLoad: firstLoad})
	defer ln.Close()
	stopsAfter(t, done, start, delay)
}

// With no close delay, a fetched page still gets the wait for it to open, so
// the /alive its head script sends arrives before anything stops.
func TestServeZeroCloseDelayLetsThePageOpen(t *testing.T) {
	const firstLoad = 400 * time.Millisecond
	url, ln, done := startServer(t, []byte("page"), Options{CloseOnGet: true, CloseDelay: 0, FirstLoad: firstLoad})
	defer ln.Close()

	if status, _ := testutil.Fetch(t, http.MethodGet, url); status != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", status)
	}
	time.Sleep(firstLoad / 4)
	stillServing(t, done, "between the page arriving and its /alive")
	hold(t, url)()
	stopsAfter(t, done, time.Now(), 0)
}
