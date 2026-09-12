package main

import (
	"context"
	"errors"
	"fmt"
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
	closeOnGet bool          // stop serving once the page has been fetched
	closeDelay time.Duration // how long after the last fetch closeOnGet waits
	notice     <-chan string // an update notice, printed whenever it arrives
}

func serve(host string, port int, page []byte, opt serveOptions) error {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	stops := "Ctrl-C to stop"
	if opt.closeOnGet {
		stops = fmt.Sprintf("stopping %s after the page is fetched", opt.closeDelay)
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
	return serveOn(ln, page, opt)
}

// serveOn serves the page on ln until the process is interrupted, or, with
// opt.closeOnGet, until opt.closeDelay has passed with no further fetch of "/".
//
// The delay is what makes the rule usable. Exiting on the first GET would end
// the server before anyone had read the page whenever a prefetcher, a link
// scanner or a proxy got there first, and would leave a reload with nothing to
// talk to. Every GET of "/" restarts the timer, so any of those extends the
// server's life rather than ending it, and only a run of opt.closeDelay with
// nobody asking for the page stops it.
func serveOn(ln net.Listener, page []byte, opt serveOptions) error {
	srv := &http.Server{}

	var mu sync.Mutex
	var timer *time.Timer
	fetched := func() {
		mu.Lock()
		defer mu.Unlock()
		if timer == nil {
			timer = time.AfterFunc(opt.closeDelay, func() {
				srv.Shutdown(context.Background())
			})
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
			fetched()
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
