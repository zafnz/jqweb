package serve

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/zafnz/jqweb/internal/update"
)

// Options are the parts of the command line that change how the server
// behaves rather than what it serves.
type Options struct {
	Open       bool          // open the page in the browser once listening
	CloseOnGet bool          // stop serving once the last tab has closed
	CloseDelay time.Duration // how long after the last tab closes CloseOnGet waits
	FirstLoad  time.Duration // how long CloseOnGet waits for a page to open, from startup or a GET of "/"
	Notice     <-chan string // an update notice, printed whenever it arrives
	Background bool          // the -C child: detach from the parent once ready
}

// FirstLoadTimeout is how long -C serves before anything has loaded the page.
// It is longer than --close-delay so there is time to find the link and click
// it, and it ends a run whose link nobody clicked.
const FirstLoadTimeout = 300 * time.Second

// ReadyLine starts the line the -C child prints once it is serving. The parent
// watches for it to know the child did not fail.
const ReadyLine = "jqweb: running in the background"

// Serve listens on host and port, says where on stderr, and serves page there
// until the process is interrupted or, with opt.CloseOnGet, until the last
// tab showing it has closed. With opt.Open it starts the browser on the page
// first, and with opt.Background it prints the ready line and lets go of its
// outputs before serving. It returns nil when the server stopped because
// CloseOnGet asked it to.
func Serve(host string, port int, page []byte, opt Options) error {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	stops := "Ctrl-C to stop"
	if opt.CloseOnGet {
		stops = "until the last tab closes"
	}
	fmt.Fprintf(os.Stderr, "jqweb: serving on http://%s/ (%s)\n", ln.Addr(), stops)
	// After the serving line, and from a goroutine, so that a slow update
	// check cannot hold up the server or the browser.
	if opt.Notice != nil {
		update.PrintNotice(os.Stderr, opt.Notice)
	}
	if opt.Open {
		if err := OpenBrowser(fmt.Sprintf("http://%s/", ln.Addr())); err != nil {
			return err
		}
	}
	if opt.Background {
		null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "%s, pid %d\n", ReadyLine, os.Getpid())
		// The parent exits once it reads that line, and nothing may be
		// written to its pipes after it. detachOutputs owns null from here.
		detachOutputs(null)
	}
	return serveOn(ln, page, opt)
}

// serveOn serves the page on ln until the process is interrupted, or, with
// opt.CloseOnGet, until the timer runs out with no tab showing it.
//
// A served page holds a request to /alive open for as long as it exists, and
// the browser drops that connection when the tab unloads; a new /alive stops
// the timer. While no tab has the page open, the timer waits for one to open
// it, for opt.FirstLoad or opt.CloseDelay if that is longer. That wait starts
// when jqweb starts, which leaves time to click the link, and again on a GET
// of "/", which covers the page arriving and its script running however short
// the close delay is. The last tab closing starts opt.CloseDelay instead. A
// reload fetches "/" while the old page still holds its connection, so the
// new page's /alive has to arrive within opt.CloseDelay of the old one closing.
func serveOn(ln net.Listener, page []byte, opt Options) error {
	srv := &http.Server{}
	if opt.Background {
		// The default logger holds the stderr the process started with, which
		// detachOutputs does not replace on every platform.
		srv.ErrorLog = log.New(io.Discard, "", 0)
	}

	var mu sync.Mutex
	var alive int // /alive requests in progress
	var timer *time.Timer
	// stopping is closed when the timer decides to shut down, so that an
	// /alive request that arrived too late returns rather than holding up
	// Shutdown, which waits for every request to finish.
	stopping := make(chan struct{})
	var stopped bool

	expire := func() {
		mu.Lock()
		if alive > 0 || stopped {
			mu.Unlock()
			return
		}
		stopped = true
		close(stopping)
		mu.Unlock()
		srv.Shutdown(context.Background())
	}
	// startTimer starts the timer, or restarts it, for d. It is called with mu
	// held.
	startTimer := func(d time.Duration) {
		if timer == nil {
			timer = time.AfterFunc(d, expire)
			return
		}
		timer.Reset(d)
	}
	opening := opt.FirstLoad
	if opt.CloseDelay > opening {
		opening = opt.CloseDelay
	}
	if opt.CloseOnGet {
		timer = time.AfterFunc(opening, expire)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(page)
		// A HEAD is a check that the page is there, not a reading of it, and
		// http.Server has discarded the body written above.
		if opt.CloseOnGet && r.Method == http.MethodGet {
			mu.Lock()
			if alive == 0 {
				startTimer(opening)
			}
			mu.Unlock()
		}
	})
	// Every served page opens this, with or without -C, so it is always
	// answered: an EventSource that got a 404 would log an error in the page.
	mux.HandleFunc("/alive", func(w http.ResponseWriter, r *http.Request) {
		if opt.CloseOnGet {
			// Counted before the headers go out, so a client that has read
			// the status line knows it is counted.
			mu.Lock()
			alive++
			if timer != nil {
				timer.Stop()
			}
			mu.Unlock()
			defer func() {
				mu.Lock()
				alive--
				if alive == 0 {
					startTimer(opt.CloseDelay)
				}
				mu.Unlock()
			}()
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		http.NewResponseController(w).Flush()
		select {
		case <-r.Context().Done():
		case <-stopping:
		}
	})
	srv.Handler = mux

	// Shutdown is the only thing that stops Serve here, and it is what the
	// caller asked for rather than a failure.
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// OpenBrowser starts the reader's browser on url: $BROWSER when it is set,
// and the platform's opener otherwise. It returns once the command has
// started, not once the page has opened.
func OpenBrowser(url string) error {
	return browserCommand(os.Getenv("BROWSER"), runtime.GOOS, url).Start()
}

// browserCommand is the command OpenBrowser runs, built apart from running it
// so a test can read the command line.
func browserCommand(browser, goos, url string) *exec.Cmd {
	if browser != "" {
		return exec.Command(browser, url)
	}
	switch goos {
	case "darwin":
		return exec.Command("open", url)
	case "windows":
		return exec.Command("cmd", "/c", "start", "", url)
	default:
		return exec.Command("xdg-open", url)
	}
}
