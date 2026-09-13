package main

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
)

// serveOptions are the parts of the command line that change how the server
// behaves rather than what it serves.
type serveOptions struct {
	open       bool          // open the page in the browser once listening
	closeOnGet bool          // stop serving once the last tab has closed
	closeDelay time.Duration // how long after the last tab closes closeOnGet waits
	notice     <-chan string // an update notice, printed whenever it arrives
	background bool          // the -C child: detach from the parent once ready
}

// readyLine starts the line the -C child prints once it is serving. The parent
// watches for it to know the child did not fail.
const readyLine = "jqweb: running in the background"

func serve(host string, port int, page []byte, opt serveOptions) error {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	stops := "Ctrl-C to stop"
	if opt.closeOnGet {
		stops = "until the last tab closes"
	}
	fmt.Fprintf(os.Stderr, "jqweb: serving on http://%s/ (%s)\n", ln.Addr(), stops)
	// After the serving line, and from a goroutine, so that a slow update
	// check cannot hold up the server or the browser.
	if opt.notice != nil {
		printNotice(os.Stderr, opt.notice)
	}
	if opt.open {
		if err := openBrowser(fmt.Sprintf("http://%s/", ln.Addr())); err != nil {
			fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
			os.Exit(1)
		}
	}
	if opt.background {
		null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
		if err != nil {
			fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "%s, pid %d\n", readyLine, os.Getpid())
		// The parent exits once it reads that line, and nothing may be
		// written to its pipes after it. See detachOutputs.
		detachOutputs(null)
		null.Close()
	}
	return serveOn(ln, page, opt)
}

// serveOn serves the page on ln until the process is interrupted, or, with
// opt.closeOnGet, until opt.closeDelay has passed with no tab showing it.
//
// A served page holds a request to /alive open for as long as it exists, and
// the browser drops that connection when the tab unloads. The close timer runs
// while none are open. It starts when the last one closes, or on a GET of "/"
// when none are open, which covers a client that fetches the page and runs no
// script; a new /alive stops it. A reload fetches "/" before the old page
// unloads, and the new page's /alive has to arrive within opt.closeDelay of
// the old one closing.
func serveOn(ln net.Listener, page []byte, opt serveOptions) error {
	srv := &http.Server{}
	if opt.background {
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
	// startTimer is called with mu held.
	startTimer := func() {
		if timer == nil {
			timer = time.AfterFunc(opt.closeDelay, expire)
			return
		}
		timer.Reset(opt.closeDelay)
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
		if opt.closeOnGet && r.Method == http.MethodGet {
			mu.Lock()
			if alive == 0 {
				startTimer()
			}
			mu.Unlock()
		}
	})
	// Every served page opens this, with or without -C, so it is always
	// answered: an EventSource that got a 404 would log an error in the page.
	mux.HandleFunc("/alive", func(w http.ResponseWriter, r *http.Request) {
		if opt.closeOnGet {
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
					startTimer()
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

func openBrowser(url string) error {
	return browserCommand(os.Getenv("BROWSER"), runtime.GOOS, url).Start()
}

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
