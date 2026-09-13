package serve

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"

	"github.com/zafnz/jqweb/internal/update"
)

// RunInBackground is -C as the terminal sees it. Go cannot fork once the
// runtime has started, so jqweb starts itself again with --child, and the
// child reads the document, serves it and outlives this process. This one
// relays what the child prints until the child has detached or failed, and
// returns the exit status to leave with.
func RunInBackground(notice <-chan string) int {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		return 1
	}
	// First, so that a "--" in the arguments cannot make it positional.
	cmd := exec.Command(exe, append([]string{"--child"}, os.Args[1:]...)...)
	// The child reads the terminal or the pipe itself; nothing here reads it.
	cmd.Stdin = os.Stdin
	cmd.SysProcAttr = detachedProcess()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		return 1
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		return 1
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		return 1
	}

	// The child is in a session or process group of its own, so the
	// terminal's Ctrl-C reaches only this process.
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	go func() {
		<-interrupt
		cmd.Process.Kill()
		os.Exit(130)
	}()

	// Both pipes reach end of file when the child exits or detaches its
	// outputs, whichever comes first.
	var ready bool
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		io.Copy(os.Stdout, stdout)
	}()
	go func() {
		defer wg.Done()
		ready = relayLines(os.Stderr, stderr, ReadyLine)
	}()
	wg.Wait()
	signal.Stop(interrupt)

	update.WaitNotice(os.Stderr, notice, update.ExitWait)
	if ready {
		return 0
	}
	err = cmd.Wait()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() > 0 {
		return exit.ExitCode()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		return 1
	}
	// A child that exited 0 without saying it was serving did not serve.
	return 1
}

// relayLines copies r to w a line at a time until r ends, and reports whether
// any line began with prefix.
func relayLines(w io.Writer, r io.Reader, prefix string) bool {
	seen := false
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			io.WriteString(w, line)
			if strings.HasPrefix(line, prefix) {
				seen = true
			}
		}
		if err != nil {
			return seen
		}
	}
}
