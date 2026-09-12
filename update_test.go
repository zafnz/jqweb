package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testUpdateConfig(t *testing.T) updateCheckConfig {
	t.Helper()
	return updateCheckConfig{
		enabled:        "on",
		currentVersion: "0.7.0",
		stderrTTY:      true,
		cacheDir: func() (string, error) {
			return t.TempDir(), nil
		},
		executable: func() (string, error) {
			return "/usr/local/bin/jqweb", nil
		},
		fileExists: func(string) bool {
			return false
		},
		getenv: func(string) string {
			return ""
		},
		now: func() time.Time {
			return time.Date(2026, 9, 12, 9, 0, 0, 0, time.UTC)
		},
		client:    http.DefaultClient,
		latestURL: "http://127.0.0.1/latest",
		timeout:   time.Second,
	}
}

func TestShouldCheckForUpdateSkipsOptOuts(t *testing.T) {
	tests := []struct {
		name   string
		change func(*updateCheckConfig)
	}{
		{"packager ldflag", func(c *updateCheckConfig) { c.enabled = "off" }},
		{"stderr is not a tty", func(c *updateCheckConfig) { c.stderrTTY = false }},
		{"development version", func(c *updateCheckConfig) { c.currentVersion = "dev" }},
		{"CI", func(c *updateCheckConfig) { c.getenv = envWith("CI", "true") }},
		{"user opt out", func(c *updateCheckConfig) { c.getenv = envWith("JQWEB_NO_UPDATE_CHECK", "1") }},
		{"snap package", func(c *updateCheckConfig) { c.getenv = envWith("SNAP", "/snap/jqweb/current") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testUpdateConfig(t)
			tt.change(&cfg)
			if shouldCheckForUpdate(cfg) {
				t.Fatal("shouldCheckForUpdate = true, want false")
			}
		})
	}
}

func TestMarkUpdateCheckAllowsOneCheckPerDay(t *testing.T) {
	cache := t.TempDir()
	now := time.Date(2026, 9, 12, 9, 0, 0, 0, time.UTC)
	cfg := testUpdateConfig(t)
	cfg.cacheDir = func() (string, error) { return cache, nil }
	cfg.now = func() time.Time { return now }

	if !markUpdateCheck(cfg) {
		t.Fatal("first markUpdateCheck = false, want true")
	}
	if _, err := os.Stat(filepath.Join(cache, "jqweb", updateCheckStamp)); err != nil {
		t.Fatalf("cache stamp was not written under UserCacheDir()/jqweb/: %v", err)
	}
	if markUpdateCheck(cfg) {
		t.Fatal("second markUpdateCheck = true, want false inside 24 hours")
	}

	cfg.now = func() time.Time { return now.Add(25 * time.Hour) }
	if !markUpdateCheck(cfg) {
		t.Fatal("stale markUpdateCheck = false, want true")
	}
}

func TestUpdateNoticeUsesHeadWithoutFollowingRedirect(t *testing.T) {
	var gotMethod string
	followed := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			gotMethod = r.Method
			w.Header().Set("Location", srvURL(t, r)+"/releases/tag/v0.8.0")
			w.WriteHeader(http.StatusFound)
		case "/releases/tag/v0.8.0":
			followed = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	cfg := testUpdateConfig(t)
	cfg.latestURL = srv.URL + "/latest"
	cfg.getenv = envWith("HOME", os.Getenv("HOME"))
	cfg.executable = func() (string, error) {
		return filepath.Join(os.Getenv("HOME"), "go", "bin", "jqweb"), nil
	}
	msg := updateNotice(cfg)

	if gotMethod != http.MethodHead {
		t.Fatalf("method = %q, want HEAD", gotMethod)
	}
	if followed {
		t.Fatal("client followed the release redirect")
	}
	want := "jqweb: 0.8.0 is available (you have 0.7.0); upgrade with: go install github.com/zafnz/jqweb@latest"
	if msg != want {
		t.Fatalf("notice = %q, want %q", msg, want)
	}
}

func TestUpdateNoticeStaysQuietWhenCurrentIsLatest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", srvURL(t, r)+"/releases/tag/v0.7.0")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	cfg := testUpdateConfig(t)
	cfg.latestURL = srv.URL
	if msg := updateNotice(cfg); msg != "" {
		t.Fatalf("notice = %q, want none", msg)
	}
}

func TestUpdateHintMatchesInstallSource(t *testing.T) {
	tests := []struct {
		name       string
		exe        string
		env        func(string) string
		fileExists func(string) bool
		want       string
	}{
		{
			name: "homebrew cask",
			exe:  "/opt/homebrew/Caskroom/jqweb/0.8.0/jqweb",
			want: "brew upgrade jqweb",
		},
		{
			name: "debian package",
			exe:  "/usr/bin/jqweb",
			fileExists: func(name string) bool {
				return name == "/var/lib/dpkg/info/jqweb.list"
			},
			want: "sudo apt install --only-upgrade jqweb",
		},
		{
			name: "gobin",
			exe:  "/opt/go-tools/jqweb",
			env:  envWith("GOBIN", "/opt/go-tools"),
			want: "go install github.com/zafnz/jqweb@latest",
		},
		{
			name: "default gopath",
			exe:  "/home/nick/go/bin/jqweb",
			env:  envWith("HOME", "/home/nick"),
			want: "go install github.com/zafnz/jqweb@latest",
		},
		{
			name: "install script",
			exe:  "/home/nick/.local/bin/jqweb",
			env:  envWith("HOME", "/home/nick"),
			want: "curl -fsSL https://raw.githubusercontent.com/zafnz/jqweb/main/install.sh | sh",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testUpdateConfig(t)
			if tt.env != nil {
				cfg.getenv = tt.env
			}
			if tt.fileExists != nil {
				cfg.fileExists = tt.fileExists
			}
			if got := updateHint(tt.exe, cfg); got != tt.want {
				t.Fatalf("updateHint = %q, want %q", got, tt.want)
			}
		})
	}
}

func envWith(name, value string) func(string) string {
	return func(got string) string {
		if got == name {
			return value
		}
		return ""
	}
}

func srvURL(t *testing.T, r *http.Request) string {
	t.Helper()
	return "http://" + r.Host
}

func TestReleaseFromLocation(t *testing.T) {
	got := releaseFromLocation("https://github.com/zafnz/jqweb/releases/tag/v0.8.0?x=y")
	if got != "0.8.0" {
		t.Fatalf("releaseFromLocation = %q, want 0.8.0", got)
	}
}

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"0.8.0", "0.7.0", 1},
		{"0.7.0", "v0.7.0", 0},
		{"0.7.0", "0.7.1", -1},
	}
	for _, tt := range tests {
		if got := compareVersions(tt.a, tt.b); got != tt.want {
			t.Fatalf("compareVersions(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}

func TestGoInstallPathHonoursPathList(t *testing.T) {
	cfg := testUpdateConfig(t)
	cfg.getenv = envWith("GOPATH", strings.Join([]string{"/one", "/two"}, string(os.PathListSeparator)))
	if !goInstallPath("/two/bin/jqweb", cfg) {
		t.Fatal("goInstallPath = false, want true for second GOPATH entry")
	}
}
