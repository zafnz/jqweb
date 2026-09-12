package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// releaseServer answers the way github.com does: /releases/latest redirects to
// the tag page, and the tag is the whole answer. It counts the requests, so a
// test can tell a check that reached the network from one answered out of the
// state file, and fails the test if the redirect is followed.
func releaseServer(t *testing.T, tag string) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/releases/latest" {
			t.Errorf("followed the redirect to %s; the Location header is the answer", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		hits.Add(1)
		if r.Method != http.MethodHead {
			t.Errorf("asked for the latest release with %s, want HEAD", r.Method)
		}
		http.Redirect(w, r, "/releases/tag/"+tag, http.StatusFound)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// newTestUpdater builds an updater against srv, a state file under a temporary
// directory, and a clock the test moves through the returned pointer.
func newTestUpdater(t *testing.T, version, url string) (*updater, *time.Time) {
	t.Helper()
	clock := time.Date(2026, 9, 12, 10, 0, 0, 0, time.UTC)
	u := &updater{
		version:   version,
		url:       url,
		stateFile: filepath.Join(t.TempDir(), "jqweb", "update-check.json"),
		timeout:   5 * time.Second,
		now:       func() time.Time { return clock },
		getenv:    func(string) string { return "" },
		exe:       func() (string, error) { return "/usr/local/bin/jqweb", nil },
	}
	return u, &clock
}

func TestNewerVersion(t *testing.T) {
	tests := []struct {
		current, latest string
		want            bool
	}{
		{"0.7.0", "0.7.0", false},
		{"0.7.0", "0.7.1", true},
		{"0.7.0", "0.8.0", true},
		{"0.7.0", "1.0.0", true},
		{"0.7.1", "0.7.0", false},
		{"1.0.0", "0.9.9", false},
		{"0.9.0", "0.10.0", true},
		{"0.10.0", "0.9.0", false},
		// The tag carries a "v" and the version the linker sets does not, so
		// both spellings have to compare the same.
		{"0.7.0", "v0.8.0", true},
		{"v0.7.0", "0.7.0", false},
		// A release beats the prerelease of the same number, and loses to the
		// prerelease of a later one.
		{"0.7.0-rc1", "0.7.0", true},
		{"0.7.0", "0.7.0-rc1", false},
		{"0.7.0-rc1", "0.8.0", true},
		// What "go install" at a commit after 0.7.0 records.
		{"0.7.1-0.20260912153000-abcdef123456", "0.7.0", false},
		{"0.7.1-0.20260912153000-abcdef123456", "0.8.0", true},
		// Build metadata orders nothing and marks no prerelease.
		{"0.7.0+build.5", "0.7.0", false},
		{"0.7.0", "0.7.0+build.5", false},
		// Shortened and unreadable versions read as far as they parse rather
		// than announcing an upgrade that is not there.
		{"0.7", "0.7.0", false},
		{"0.7.0", "0.7", false},
		{"0.7.0", "nonsense", false},
		{"nonsense", "0.0.0", false},
		{"", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.current+" -> "+tt.latest, func(t *testing.T) {
			if got := newerVersion(tt.current, tt.latest); got != tt.want {
				t.Errorf("newerVersion(%q, %q) = %v, want %v", tt.current, tt.latest, got, tt.want)
			}
		})
	}
}

func TestWantUpdateCheck(t *testing.T) {
	tests := []struct {
		name    string
		version string
		tty     bool
		ldflag  string
		env     map[string]string
		want    bool
	}{
		{name: "a release on a terminal", version: "0.7.0", tty: true, want: true},
		{name: "a local build", version: "dev", tty: true},
		{name: "stderr is not a terminal", version: "0.7.0"},
		{name: "switched off at build time", version: "0.7.0", tty: true, ldflag: "off"},
		{name: "switched off by the user", version: "0.7.0", tty: true,
			env: map[string]string{"JQWEB_NO_UPDATE_CHECK": "1"}},
		{name: "running under CI", version: "0.7.0", tty: true,
			env: map[string]string{"CI": "true"}},
		{name: "installed as a snap", version: "0.7.0", tty: true,
			env: map[string]string{"SNAP": "/snap/jqweb/12"}},
		// An empty value is not a setting, which is what lets a wrapper script
		// unset the variable by emptying it.
		{name: "the variable is set but empty", version: "0.7.0", tty: true,
			env: map[string]string{"JQWEB_NO_UPDATE_CHECK": ""}, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			saved := updateCheck
			updateCheck = tt.ldflag
			t.Cleanup(func() { updateCheck = saved })

			getenv := func(k string) string { return tt.env[k] }
			if got := wantUpdateCheck(tt.version, tt.tty, getenv); got != tt.want {
				t.Errorf("wantUpdateCheck(%q, tty=%v) = %v, want %v", tt.version, tt.tty, got, tt.want)
			}
		})
	}
}

func TestUpgradeHint(t *testing.T) {
	tests := []struct {
		name string
		exe  string
		env  map[string]string
		want string
	}{
		{
			name: "a Homebrew cask",
			exe:  "/opt/homebrew/Caskroom/jqweb/0.7.0/jqweb",
			want: "brew upgrade jqweb",
		},
		{
			name: "a Homebrew cask on Intel",
			exe:  "/usr/local/Caskroom/jqweb/0.7.0/jqweb",
			want: "brew upgrade jqweb",
		},
		{
			name: "go install with GOBIN set",
			exe:  "/home/nick/bin/jqweb",
			env:  map[string]string{"GOBIN": "/home/nick/bin"},
			want: "go install github.com/zafnz/jqweb@latest",
		},
		{
			name: "go install with GOPATH set",
			exe:  "/srv/go/bin/jqweb",
			env:  map[string]string{"GOPATH": "/srv/go"},
			want: "go install github.com/zafnz/jqweb@latest",
		},
		{
			name: "go install with neither set",
			exe:  "/home/nick/go/bin/jqweb",
			env:  map[string]string{"HOME": "/home/nick"},
			want: "go install github.com/zafnz/jqweb@latest",
		},
		{
			name: "GOBIN set but the binary is elsewhere",
			exe:  "/usr/local/bin/jqweb",
			env:  map[string]string{"GOBIN": "/home/nick/bin", "HOME": "/home/nick"},
			want: installCommand,
		},
		{
			name: "install.sh into ~/.local/bin",
			exe:  "/home/nick/.local/bin/jqweb",
			env:  map[string]string{"HOME": "/home/nick"},
			want: installCommand,
		},
		{
			name: "a release downloaded by hand",
			exe:  "/opt/tools/jqweb",
			want: installCommand,
		},
		{
			name: "the path could not be read",
			exe:  "",
			want: installCommand,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			getenv := func(k string) string { return tt.env[k] }
			if got := upgradeHint(tt.exe, getenv); got != tt.want {
				t.Errorf("upgradeHint(%q) = %q, want %q", tt.exe, got, tt.want)
			}
		})
	}
}

// $GOBIN can name a directory reached through a symlink, while the path of the
// running binary has had its links resolved already. The two still name the
// same directory, and the hint has to say so.
func TestUpgradeHintMatchesASymlinkedGoBin(t *testing.T) {
	root := t.TempDir()
	gobin := filepath.Join(root, "go", "bin")
	if err := os.MkdirAll(gobin, 0o755); err != nil {
		t.Fatalf("making the bin directory: %v", err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(filepath.Join(root, "go"), link); err != nil {
		t.Fatalf("making the symlink: %v", err)
	}

	getenv := func(k string) string {
		if k == "GOBIN" {
			return filepath.Join(link, "bin")
		}
		return ""
	}
	exe := filepath.Join(gobin, "jqweb")
	const want = "go install github.com/zafnz/jqweb@latest"
	if got := upgradeHint(exe, getenv); got != want {
		t.Errorf("upgradeHint(%q) with GOBIN=%q = %q, want %q", exe, getenv("GOBIN"), got, want)
	}
}

func TestNoticeReportsANewerRelease(t *testing.T) {
	srv, hits := releaseServer(t, "v0.9.0")
	u, _ := newTestUpdater(t, "0.7.0", srv.URL+"/releases/latest")

	line := u.notice()
	if !strings.Contains(line, "0.9.0") || !strings.Contains(line, "0.7.0") {
		t.Errorf("notice = %q, want both 0.9.0 and 0.7.0 in it", line)
	}
	if !strings.Contains(line, installCommand) {
		t.Errorf("notice = %q, want the command to upgrade with", line)
	}
	if !strings.HasPrefix(line, "jqweb: ") {
		t.Errorf("notice = %q, want the jqweb: prefix every other message carries", line)
	}
	if strings.Contains(line, "\n") {
		t.Errorf("notice = %q, want one line", line)
	}
	if n := hits.Load(); n != 1 {
		t.Errorf("asked github.com %d times, want 1", n)
	}
}

func TestNoticeSaysNothingWhenCurrent(t *testing.T) {
	srv, _ := releaseServer(t, "v0.7.0")
	u, _ := newTestUpdater(t, "0.7.0", srv.URL+"/releases/latest")

	if line := u.notice(); line != "" {
		t.Errorf("notice = %q on the latest release, want nothing", line)
	}
}

// The run that asks github.com is the run that prints, so a release is
// mentioned at most once a day however often jqweb is run.
func TestNoticeAppearsAtMostOnceADay(t *testing.T) {
	srv, hits := releaseServer(t, "v0.9.0")
	u, clock := newTestUpdater(t, "0.7.0", srv.URL+"/releases/latest")

	first := u.notice()
	if first == "" {
		t.Fatal("no notice for 0.9.0 against 0.7.0")
	}

	var state updateState
	b, err := os.ReadFile(u.stateFile)
	if err != nil {
		t.Fatalf("reading the state file: %v", err)
	}
	if err := json.Unmarshal(b, &state); err != nil {
		t.Fatalf("the state file is not JSON: %v", err)
	}
	if !state.CheckedAt.Equal(u.now()) {
		t.Errorf("state = %+v, want the check recorded at %s", state, u.now())
	}

	*clock = clock.Add(updateInterval - time.Minute)
	if again := u.notice(); again != "" {
		t.Errorf("notice %q just under a day after the last one, want nothing", again)
	}
	if n := hits.Load(); n != 1 {
		t.Errorf("asked github.com %d times within the day, want 1", n)
	}

	*clock = clock.Add(2 * time.Minute)
	if again := u.notice(); again != first {
		t.Errorf("notice a day later = %q, want %q", again, first)
	}
	if n := hits.Load(); n != 2 {
		t.Errorf("asked github.com %d times over a day and a bit, want 2", n)
	}
}

// A release that lands while the state file still holds the old answer is
// announced on the next check rather than remembered wrongly for ever.
func TestNoticeFollowsANewReleaseAfterADay(t *testing.T) {
	tag := "v0.8.0"
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(w, r, "/releases/tag/"+tag, http.StatusFound)
	}))
	defer srv.Close()

	u, clock := newTestUpdater(t, "0.7.0", srv.URL+"/releases/latest")
	if line := u.notice(); !strings.Contains(line, "0.8.0") {
		t.Fatalf("notice = %q, want 0.8.0", line)
	}
	tag = "v0.9.0"
	*clock = clock.Add(updateInterval)
	if line := u.notice(); !strings.Contains(line, "0.9.0") {
		t.Errorf("notice after a day = %q, want 0.9.0", line)
	}
}

func TestNoticeSurvivesAGarbledStateFile(t *testing.T) {
	srv, hits := releaseServer(t, "v0.9.0")
	u, _ := newTestUpdater(t, "0.7.0", srv.URL+"/releases/latest")
	if err := os.MkdirAll(filepath.Dir(u.stateFile), 0o755); err != nil {
		t.Fatalf("making the state directory: %v", err)
	}
	if err := os.WriteFile(u.stateFile, []byte("{not json"), 0o644); err != nil {
		t.Fatalf("writing the state file: %v", err)
	}

	if line := u.notice(); !strings.Contains(line, "0.9.0") {
		t.Errorf("notice = %q, want 0.9.0: a state file that will not parse has to read as no check", line)
	}
	if n := hits.Load(); n != 1 {
		t.Errorf("asked github.com %d times, want 1", n)
	}
}

// Nothing about jqweb depends on the check, so an unreachable github.com is
// silent and leaves no state behind, which lets the next run try again.
func TestNoticeSaysNothingWhenGitHubIsUnreachable(t *testing.T) {
	srv, _ := releaseServer(t, "v0.9.0")
	url := srv.URL + "/releases/latest"
	srv.Close()

	u, _ := newTestUpdater(t, "0.7.0", url)
	if line := u.notice(); line != "" {
		t.Errorf("notice = %q with github.com unreachable, want nothing", line)
	}
	if _, err := os.Stat(u.stateFile); !os.IsNotExist(err) {
		t.Errorf("a failed check wrote a state file, which would hold off the retry for a day")
	}
}

func TestLatestVersionStripsWhatFollowsTheTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "https://github.com/zafnz/jqweb/releases/tag/v0.9.0?from=feed#top")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	u, _ := newTestUpdater(t, "0.7.0", srv.URL+"/releases/latest")
	got, err := u.latestVersion()
	if err != nil {
		t.Fatalf("latestVersion: %v", err)
	}
	if got != "0.9.0" {
		t.Errorf("latestVersion = %q, want 0.9.0", got)
	}
}

func TestLatestVersionRejectsWhatNamesNoTag(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"no redirect", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}},
		{"the repository is gone", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		}},
		{"a redirect naming no tag", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/login", http.StatusFound)
		}},
		{"a redirect with an empty tag", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/releases/tag/", http.StatusFound)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(tt.handler)
			defer srv.Close()
			u, _ := newTestUpdater(t, "0.7.0", srv.URL+"/releases/latest")
			if got, err := u.latestVersion(); err == nil {
				t.Errorf("latestVersion = %q, want an error", got)
			}
		})
	}
}

// The check runs in a goroutine of its own, so a build from a working tree has
// to be turned away before that goroutine starts rather than by it.
func TestCheckForUpdateSkipsADevBuild(t *testing.T) {
	if v := releaseVersion(); v != "dev" {
		t.Skipf("this test binary reports version %q, not dev", v)
	}
	ch := checkForUpdate()
	select {
	case line, ok := <-ch:
		if ok {
			t.Errorf("a dev build was told %q, want no check at all", line)
		}
	case <-time.After(time.Second):
		t.Error("the channel from a skipped check never closed; -o mode would wait on it")
	}
}

// lineWriter hands each write to a channel, so a test can wait for the
// goroutine behind printNotice rather than sleeping and hoping.
type lineWriter chan string

func (w lineWriter) Write(p []byte) (int, error) {
	w <- string(p)
	return len(p), nil
}

func TestPrintNoticePrintsTheLine(t *testing.T) {
	ch := make(chan string, 1)
	w := make(lineWriter, 1)
	printNotice(w, ch)
	ch <- "jqweb: 0.9.0 is available"
	select {
	case got := <-w:
		if got != "jqweb: 0.9.0 is available\n" {
			t.Errorf("printed %q, want the line and a newline", got)
		}
	case <-time.After(5 * time.Second):
		t.Error("printNotice printed nothing")
	}
}

func TestPrintNoticeIsSilentWithNoAnswer(t *testing.T) {
	ch := make(chan string, 1)
	w := make(lineWriter, 1)
	printNotice(w, ch)
	close(ch)
	select {
	case got := <-w:
		t.Errorf("printed %q when there was nothing to say", got)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestWaitNoticeGivesUpAfterTheDelay(t *testing.T) {
	const delay = 150 * time.Millisecond
	ch := make(chan string) // never answered
	w := make(lineWriter, 1)

	start := time.Now()
	waitNotice(w, ch, delay)
	if waited := time.Since(start); waited+closeTimerSlack < delay {
		t.Errorf("gave up after %s, before the %s delay", waited, delay)
	}
	select {
	case got := <-w:
		t.Errorf("printed %q for a check that never answered", got)
	default:
	}
}

func TestWaitNoticePrintsAnAnswerThatArrives(t *testing.T) {
	ch := make(chan string, 1)
	ch <- "jqweb: 0.9.0 is available"
	w := make(lineWriter, 1)

	waitNotice(w, ch, 5*time.Second)
	select {
	case got := <-w:
		if got != "jqweb: 0.9.0 is available\n" {
			t.Errorf("printed %q, want the line and a newline", got)
		}
	default:
		t.Error("waitNotice printed nothing for an answer that was already there")
	}
}
