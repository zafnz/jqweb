package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// updateCheck is set by the linker to switch the check off for good:
//
//	-X main.updateCheck=off
//
// It is there for downstream packagers, whose users upgrade through the
// package manager rather than by being told to.
var updateCheck = ""

const (
	// The latest release redirects to /releases/tag/<tag>. install.sh reads
	// the same redirect: no API call, so no rate limit and no JSON.
	latestReleaseURL = "https://github.com/zafnz/jqweb/releases/latest"

	// How often github.com is asked, and so how often a notice can appear:
	// the run that makes the check is the run that prints.
	updateInterval = 24 * time.Hour

	// How long a tag has to have been known before it is mentioned. Package
	// managers lag a release by up to a day, so a notice sent the moment a tag
	// appears points at something the reader cannot install yet. It is measured
	// from when jqweb first saw the tag, which is at or after publication, so a
	// tag this old has been published at least this long.
	minTagAge = 24 * time.Hour

	// A check that has not answered by then is abandoned.
	updateTimeout = 2 * time.Second

	// How long -o mode waits at exit for an answer. Serving waits for nothing.
	updateWait = time.Second

	installCommand = "curl -fsSL https://raw.githubusercontent.com/zafnz/jqweb/main/install.sh | sh"
)

// updateState is what a check leaves behind for the runs that follow it: when
// github.com was last asked, the tag it answered with, and when that tag was
// first seen.
type updateState struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    string    `json:"latest"`
	FirstSeen time.Time `json:"first_seen"`
}

// updater is one update check. The fields are what the check reaches outside
// the process for -- github.com, the state file, the clock, the environment
// and the path of the running binary -- so that a test can supply all five.
type updater struct {
	version   string
	url       string
	stateFile string
	timeout   time.Duration
	now       func() time.Time
	getenv    func(string) string
	exe       func() (string, error)
}

// checkForUpdate starts the check and returns a channel carrying the line to
// print. The channel is closed with nothing on it when there is nothing to
// say, and closed before it is returned when no check is wanted, so a receive
// never waits on a check that is not happening.
func checkForUpdate() <-chan string {
	ch := make(chan string, 1)
	version := releaseVersion()
	state, err := stateFilePath()
	if err != nil || !wantUpdateCheck(version, isTTY(os.Stderr), os.Getenv) {
		close(ch)
		return ch
	}
	u := &updater{
		version:   version,
		url:       latestReleaseURL,
		stateFile: state,
		timeout:   updateTimeout,
		now:       time.Now,
		getenv:    os.Getenv,
		exe:       executablePath,
	}
	go func() {
		defer close(ch)
		if line := u.notice(); line != "" {
			ch <- line
		}
	}()
	return ch
}

// wantUpdateCheck reports whether to check at all. Each of these is a case
// where the answer would go unread, be unwelcome, or be acted on by something
// other than the person running jqweb.
func wantUpdateCheck(version string, stderrIsTTY bool, getenv func(string) string) bool {
	switch {
	case updateCheck == "off":
		return false
	case version == "dev":
		// A build from a working tree has no release to be behind.
		return false
	case !stderrIsTTY:
		// A pipe, a file or a log: nobody is reading the notice.
		return false
	case getenv("JQWEB_NO_UPDATE_CHECK") != "":
		return false
	case getenv("CI") != "":
		return false
	case getenv("SNAP") != "":
		// snapd refreshes the snap on its own.
		return false
	}
	return true
}

// notice is the line to print, or "" when the running version is the latest
// one, the tag is too new to mention, or the check could not be made.
//
// Only the run that asks github.com prints. A run inside updateInterval of the
// last check leaves the notice to the run that made it, so a release is
// mentioned at most once a day however often jqweb is run.
//
// Every failure along the way is silent: a version check is not what anyone
// ran jqweb for.
func (u *updater) notice() string {
	state := u.readState()
	if u.now().Sub(state.CheckedAt) < updateInterval {
		return ""
	}
	latest, err := u.latestVersion()
	if err != nil {
		// The day is spent whether or not the answer came. Leaving CheckedAt
		// alone would mean a request on every run for as long as github.com is
		// unreachable, which is more than a version notice is worth; the cost
		// is that a run of failures delays the notice by a day each.
		state.CheckedAt = u.now()
		u.writeState(state)
		return ""
	}
	if latest != state.Latest {
		state.Latest, state.FirstSeen = latest, u.now()
	}
	state.CheckedAt = u.now()
	u.writeState(state)

	if !newerVersion(u.version, latest) {
		return ""
	}
	if u.now().Sub(state.FirstSeen) < minTagAge {
		return ""
	}
	return fmt.Sprintf("jqweb: %s is available (running %s): %s",
		latest, u.version, u.upgradeHint())
}

// latestVersion asks github.com for the latest release tag by reading where
// /releases/latest redirects to, without following it. Following it would
// download a release page nobody reads to learn what the Location header has
// already said.
func (u *updater) latestVersion() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), u.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, u.url, nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{
		Timeout: u.timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 300 || resp.StatusCode >= 400 {
		return "", fmt.Errorf("%s: %s", u.url, resp.Status)
	}
	location := resp.Header.Get("Location")
	_, tag, found := strings.Cut(location, "/releases/tag/")
	// A query string or a fragment on the end is not part of the tag.
	tag, _, _ = strings.Cut(tag, "?")
	tag, _, _ = strings.Cut(tag, "#")
	if !found || tag == "" {
		return "", fmt.Errorf("%s: redirects to %q, which names no tag", u.url, location)
	}
	return strings.TrimPrefix(tag, "v"), nil
}

// readState reads what the last check recorded. Anything unreadable or
// unparseable reads as a check that never happened, which costs one request.
func (u *updater) readState() updateState {
	b, err := os.ReadFile(u.stateFile)
	if err != nil {
		return updateState{}
	}
	var state updateState
	if err := json.Unmarshal(b, &state); err != nil {
		return updateState{}
	}
	return state
}

// writeState records the answer for the runs over the next day. It writes a
// temporary file and renames it, so two jqweb runs at once cannot leave a
// half-written one for the next to read. A failure is ignored: the cost is
// asking github.com again.
func (u *updater) writeState(state updateState) {
	b, err := json.Marshal(state)
	if err != nil {
		return
	}
	dir := filepath.Dir(u.stateFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	f, err := os.CreateTemp(dir, "update-check-*.json")
	if err != nil {
		return
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(f.Name())
		return
	}
	if err := f.Close(); err != nil {
		os.Remove(f.Name())
		return
	}
	if err := os.Rename(f.Name(), u.stateFile); err != nil {
		os.Remove(f.Name())
	}
}

// upgradeHint is the command that fetches the new release. GoReleaser wraps
// the same binary for every channel, so there is no ldflag to tell them apart
// and where the binary sits is the only thing left to read.
func (u *updater) upgradeHint() string {
	exe, err := u.exe()
	if err != nil {
		exe = ""
	}
	return upgradeHint(exe, u.getenv)
}

func upgradeHint(exe string, getenv func(string) string) string {
	// A Homebrew cask keeps the binary in the Caskroom and links it onto the
	// path; executablePath resolves the link, which is the only way the
	// Caskroom shows up here. Homebrew runs on macOS and Linux, so the
	// separator is "/" either way.
	if strings.Contains(filepath.ToSlash(exe), "/Caskroom/") {
		return "brew upgrade jqweb"
	}
	if inGoBin(filepath.Dir(exe), getenv) {
		return "go install github.com/zafnz/jqweb@latest"
	}
	return installCommand
}

// inGoBin reports whether dir is where "go install" puts a binary: $GOBIN, or
// bin under each entry of $GOPATH, or ~/go/bin when neither is set.
//
// The path of the running binary has been through EvalSymlinks by the time it
// arrives here, so the directories named by the environment are resolved too.
// Without that, a $GOBIN reached through a link -- /tmp is one on macOS, and a
// home directory often is -- would fail to match the directory it names.
func inGoBin(dir string, getenv func(string) string) bool {
	var bins []string
	if gobin := getenv("GOBIN"); gobin != "" {
		bins = append(bins, gobin)
	}
	if gopath := getenv("GOPATH"); gopath != "" {
		for _, p := range filepath.SplitList(gopath) {
			bins = append(bins, filepath.Join(p, "bin"))
		}
	} else {
		home := getenv("HOME")
		if home == "" {
			home = getenv("USERPROFILE")
		}
		if home != "" {
			bins = append(bins, filepath.Join(home, "go", "bin"))
		}
	}
	for _, b := range bins {
		if sameDir(dir, b) {
			return true
		}
	}
	return false
}

// sameDir reports whether two paths name the same directory. Paths that do not
// exist are compared as text, which is all the comparison there is for them.
func sameDir(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ra, err := filepath.EvalSymlinks(a)
	if err != nil {
		return false
	}
	rb, err := filepath.EvalSymlinks(b)
	if err != nil {
		return false
	}
	return ra == rb
}

// executablePath is where the running binary lives, with symlinks resolved.
// A Homebrew cask is reached through a link on the path and os.Executable
// reports that link on macOS, so without this the Caskroom is never seen.
func executablePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		return resolved, nil
	}
	return exe, nil
}

// stateFilePath is where the last check is remembered. A system with no cache
// directory gets no check at all rather than one on every run.
func stateFilePath() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "jqweb", "update-check.json"), nil
}

// newerVersion reports whether latest is a later release than current. Both
// are release numbers without the leading "v": "0.7.0", or "0.7.0-rc1" for a
// prerelease.
//
// The three numbers are compared, and a release beats the prerelease of the
// same number, so 0.7.0 is newer than 0.7.0-rc1. Two prereleases never meet
// here: /releases/latest skips every release GitHub has marked as one.
func newerVersion(current, latest string) bool {
	c, cPre := parseVersion(current)
	l, lPre := parseVersion(latest)
	for i := range c {
		if c[i] != l[i] {
			return l[i] > c[i]
		}
	}
	return cPre && !lPre
}

// parseVersion reads the major, minor and patch numbers out of a version, and
// reports whether a prerelease suffix followed them. A field that is not a
// number reads as 0, which makes an unreadable version the oldest there is
// rather than a reason to fail.
func parseVersion(v string) (nums [3]int, prerelease bool) {
	v = strings.TrimPrefix(v, "v")
	// Build metadata is not part of the ordering and does not make a version
	// a prerelease, so it goes before the "-" is looked for.
	if i := strings.Index(v, "+"); i >= 0 {
		v = v[:i]
	}
	if i := strings.Index(v, "-"); i >= 0 {
		v, prerelease = v[:i], true
	}
	fields := strings.Split(v, ".")
	for i := 0; i < len(nums) && i < len(fields); i++ {
		n, err := strconv.Atoi(fields[i])
		if err != nil || n < 0 {
			return nums, prerelease
		}
		nums[i] = n
	}
	return nums, prerelease
}

// printNotice prints the line from ch when it arrives, and nothing when ch
// closes without one. It returns at once: the waiting is done in a goroutine,
// so a slow check never holds up the server.
func printNotice(w io.Writer, ch <-chan string) {
	go func() {
		if line := <-ch; line != "" {
			fmt.Fprintln(w, line)
		}
	}()
}

// waitNotice prints the line if it arrives within d. Nothing is behind this
// but the process exiting, so a check that has not answered is dropped.
func waitNotice(w io.Writer, ch <-chan string, d time.Duration) {
	select {
	case line := <-ch:
		if line != "" {
			fmt.Fprintln(w, line)
		}
	case <-time.After(d):
	}
}
