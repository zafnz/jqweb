package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// updateCheck is left on for upstream builds. Downstream packagers can disable
// the network check with:
// -X main.updateCheck=off
var updateCheck = "on"

const (
	latestReleaseURL   = "https://github.com/zafnz/jqweb/releases/latest"
	updateCheckPeriod  = 24 * time.Hour
	updateCheckTimeout = 1500 * time.Millisecond
	updateCheckStamp   = "update-check"
)

type updateCheckConfig struct {
	enabled        string
	currentVersion string
	stderrTTY      bool
	cacheDir       func() (string, error)
	executable     func() (string, error)
	fileExists     func(string) bool
	getenv         func(string) string
	now            func() time.Time
	client         *http.Client
	latestURL      string
	timeout        time.Duration
}

func defaultUpdateCheckConfig(stderr *os.File) updateCheckConfig {
	return updateCheckConfig{
		enabled:        updateCheck,
		currentVersion: releaseVersion(),
		stderrTTY:      isTTY(stderr),
		cacheDir:       os.UserCacheDir,
		executable:     os.Executable,
		fileExists: func(name string) bool {
			_, err := os.Stat(name)
			return err == nil
		},
		getenv:    os.Getenv,
		now:       time.Now,
		client:    http.DefaultClient,
		latestURL: latestReleaseURL,
		timeout:   updateCheckTimeout,
	}
}

func startUpdateCheck(stderr *os.File, wait bool) func() {
	cfg := defaultUpdateCheckConfig(stderr)
	if !shouldCheckForUpdate(cfg) || !markUpdateCheck(cfg) {
		return func() {}
	}

	ch := make(chan string, 1)
	go func() {
		ch <- updateNotice(cfg)
	}()

	print := func() {
		if msg := <-ch; msg != "" {
			fmt.Fprintln(stderr, msg)
		}
	}
	if wait {
		return print
	}
	go print()
	return func() {}
}

func shouldCheckForUpdate(cfg updateCheckConfig) bool {
	if cfg.enabled == "off" || !cfg.stderrTTY || cfg.currentVersion == "dev" {
		return false
	}
	for _, name := range []string{"CI", "JQWEB_NO_UPDATE_CHECK", "SNAP"} {
		if cfg.getenv(name) != "" {
			return false
		}
	}
	return true
}

func markUpdateCheck(cfg updateCheckConfig) bool {
	cacheRoot, err := cfg.cacheDir()
	if err != nil {
		return false
	}
	dir := filepath.Join(cacheRoot, "jqweb")
	name := filepath.Join(dir, updateCheckStamp)
	if b, err := os.ReadFile(name); err == nil {
		if last, err := time.Parse(time.RFC3339, strings.TrimSpace(string(b))); err == nil {
			if cfg.now().Sub(last) < updateCheckPeriod {
				return false
			}
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	return os.WriteFile(name, []byte(cfg.now().Format(time.RFC3339)+"\n"), 0o644) == nil
}

func updateNotice(cfg updateCheckConfig) string {
	ctx, cancel := context.WithTimeout(context.Background(), cfg.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, cfg.latestURL, nil)
	if err != nil {
		return ""
	}
	client := *cfg.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	latest := releaseFromLocation(resp.Header.Get("Location"))
	if latest == "" || compareVersions(latest, cfg.currentVersion) <= 0 {
		return ""
	}
	exe, err := cfg.executable()
	if err != nil {
		exe = ""
	}
	return fmt.Sprintf("jqweb: %s is available (you have %s); upgrade with: %s",
		latest, strings.TrimPrefix(cfg.currentVersion, "v"), updateHint(exe, cfg))
}

func releaseFromLocation(location string) string {
	_, version, ok := strings.Cut(location, "/releases/tag/")
	if !ok {
		return ""
	}
	version, _, _ = strings.Cut(version, "?")
	version, _, _ = strings.Cut(version, "#")
	return strings.TrimPrefix(version, "v")
}

func compareVersions(a, b string) int {
	ap := versionParts(a)
	bp := versionParts(b)
	for i := 0; i < len(ap) || i < len(bp); i++ {
		var av, bv int
		if i < len(ap) {
			av = ap[i]
		}
		if i < len(bp) {
			bv = bp[i]
		}
		if av > bv {
			return 1
		}
		if av < bv {
			return -1
		}
	}
	return 0
}

func versionParts(v string) []int {
	v = strings.TrimPrefix(v, "v")
	v, _, _ = strings.Cut(v, "-")
	fields := strings.Split(v, ".")
	parts := make([]int, 0, len(fields))
	for _, f := range fields {
		n, err := strconv.Atoi(f)
		if err != nil {
			return nil
		}
		parts = append(parts, n)
	}
	return parts
}

func updateHint(exe string, cfg updateCheckConfig) string {
	path := filepath.ToSlash(strings.ToLower(exe))
	if strings.Contains(path, "/caskroom/jqweb/") || strings.Contains(path, "/homebrew/cellar/jqweb/") {
		return "brew upgrade jqweb"
	}
	if cfg.fileExists("/var/lib/dpkg/info/jqweb.list") {
		return "sudo apt install --only-upgrade jqweb"
	}
	if goInstallPath(exe, cfg) {
		return "go install github.com/zafnz/jqweb@latest"
	}
	return "curl -fsSL https://raw.githubusercontent.com/zafnz/jqweb/main/install.sh | sh"
}

func goInstallPath(exe string, cfg updateCheckConfig) bool {
	dir := filepath.Clean(filepath.Dir(exe))
	if gobin := cfg.getenv("GOBIN"); gobin != "" && samePath(dir, gobin) {
		return true
	}
	gopath := cfg.getenv("GOPATH")
	if gopath == "" {
		home := cfg.getenv("HOME")
		if home == "" {
			home = cfg.getenv("USERPROFILE")
		}
		if home == "" {
			return false
		}
		gopath = filepath.Join(home, "go")
	}
	for _, root := range filepath.SplitList(gopath) {
		if samePath(dir, filepath.Join(root, "bin")) {
			return true
		}
	}
	return false
}

func samePath(a, b string) bool {
	return filepath.Clean(strings.ToLower(a)) == filepath.Clean(strings.ToLower(b))
}
