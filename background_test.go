package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/zafnz/jqweb/internal/serve"
	"github.com/zafnz/jqweb/internal/testutil"
)

// TestMain runs jqweb's main instead of the tests when JQWEB_TEST_MAIN is set.
// The tests below start the test binary that way, as jqweb, and the -C parent
// it runs as starts its child from os.Executable, which is the test binary
// again with the variable still set.
func TestMain(m *testing.M) {
	if os.Getenv("JQWEB_TEST_MAIN") != "" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// jqweb returns a command running the test binary as jqweb with args, which
// the test fails if it has not finished within 10 seconds.
func jqweb(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, os.Args[0], args...)
	cmd.Env = append(os.Environ(), "JQWEB_TEST_MAIN=1", "JQWEB_NO_UPDATE_CHECK=1")
	return cmd
}

func TestBackgroundReportsABadDocument(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`{"a":`), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := jqweb(t, "-C", bad)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()

	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 {
		t.Errorf("exit = %v, want status 1", err)
	}
	if got := stderr.String(); !strings.Contains(got, "jqweb: "+bad+": ") {
		t.Errorf("stderr = %q, want the error naming %s", got, bad)
	}
	if strings.Contains(stderr.String(), serve.ReadyLine) {
		t.Errorf("stderr = %q, which says it is running for a document it rejected", stderr.String())
	}
}

func TestDeepDocumentRejectedBeforeOutput(t *testing.T) {
	for _, mode := range []string{"stdout", "file", "serve", "background"} {
		t.Run(mode, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "page.html")
			if err := os.WriteFile(file, []byte("existing page"), 0o644); err != nil {
				t.Fatal(err)
			}
			args := map[string][]string{
				"stdout":     {"-o", "-"},
				"file":       {"-o", file},
				"serve":      {"-p", "0"},
				"background": {"-C", "-p", "0"},
			}[mode]
			cmd := jqweb(t, args...)
			cmd.Stdin = strings.NewReader(strings.Repeat("[", 10001) + "0" + strings.Repeat("]", 10001))
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			err := cmd.Run()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 {
				t.Fatalf("exit = %v, want status 1; stderr: %s", err, stderr.String())
			}
			if stdout.Len() != 0 || !strings.Contains(stderr.String(), "JSON nesting exceeds the supported limit of 128") || strings.Contains(stderr.String(), "serving on") || strings.Contains(stderr.String(), serve.ReadyLine) {
				t.Fatalf("stdout = %q, stderr = %q", stdout.String(), stderr.String())
			}
			if got, err := os.ReadFile(file); err != nil || string(got) != "existing page" {
				t.Fatalf("output changed: %q, %v", got, err)
			}
		})
	}
}

func TestBackgroundOutlivesTheParentUntilTheTabCloses(t *testing.T) {
	const delay = 300 * time.Millisecond
	doc := filepath.Join(t.TempDir(), "doc.json")
	if err := os.WriteFile(doc, []byte(`{"a":1}`), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := jqweb(t, "-C", "--close-delay", delay.String(), doc)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	start := time.Now()
	if err := cmd.Run(); err != nil {
		t.Fatalf("parent: %v, stderr %q", err, stderr.String())
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("parent took %s to return, want under a second", took)
	}

	addr := regexp.MustCompile(`serving on http://(\S+)/`).FindStringSubmatch(stderr.String())
	pid := regexp.MustCompile(regexp.QuoteMeta(serve.ReadyLine) + `, pid (\d+)\n`).FindStringSubmatch(stderr.String())
	if addr == nil || pid == nil {
		t.Fatalf("stderr = %q, want the serving line and the ready line", stderr.String())
	}
	exited := false
	t.Cleanup(func() {
		if n, err := strconv.Atoi(pid[1]); err == nil && !exited {
			if p, err := os.FindProcess(n); err == nil {
				p.Kill()
			}
		}
	})

	url := "http://" + addr[1] + "/"
	if status, _ := testutil.Fetch(t, "GET", url); status != 200 {
		t.Fatalf("GET / after the parent returned = %d, want 200", status)
	}

	// A raw connection, closed the way a tab closes it.
	conn, err := net.Dial("tcp", addr[1])
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	fmt.Fprintf(conn, "GET /alive HTTP/1.1\r\nHost: %s\r\n\r\n", addr[1])
	if status, err := bufio.NewReader(conn).ReadString('\n'); err != nil || !strings.HasPrefix(status, "HTTP/1.1 200 ") {
		t.Fatalf("GET /alive = %q, %v; want 200", status, err)
	}
	time.Sleep(3 * delay)
	if status, _ := testutil.Fetch(t, "GET", url); status != 200 {
		t.Fatalf("GET / with /alive held = %d, want 200", status)
	}
	time.Sleep(3 * delay)

	conn.Close()
	closed := time.Now()
	for {
		c, err := net.DialTimeout("tcp", addr[1], time.Second)
		if err != nil {
			exited = true
			break
		}
		c.Close()
		if time.Since(closed) > 10*time.Second {
			t.Fatal("still accepting connections 10s after /alive closed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if waited := time.Since(closed); waited+testutil.TimerSlack < delay {
		t.Errorf("exited %s after /alive closed, before the %s delay", waited, delay)
	}
}
