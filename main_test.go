package main

import (
	"flag"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestReorderArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{"empty", []string{}, nil},
		{"flags already first", []string{"-O", "f.json"}, []string{"-O", "f.json"}},
		{"file before flag", []string{"f.json", "-O"}, []string{"-O", "f.json"}},
		{"flag value stays attached", []string{"f.json", "-p", "8080"}, []string{"-p", "8080", "f.json"}},
		{"long flag value stays attached", []string{"f.json", "--port", "8080"}, []string{"--port", "8080", "f.json"}},
		{"several flags", []string{"f.json", "--host", "0.0.0.0", "-O"}, []string{"--host", "0.0.0.0", "-O", "f.json"}},
		{"value not swallowed by boolean flag", []string{"-O", "f.json", "-v"}, []string{"-O", "-v", "f.json"}},
		{"dash is stdin, not a flag", []string{"-p", "9", "-"}, []string{"-p", "9", "-"}},
		{"flag missing its value", []string{"f.json", "-p"}, []string{"-p", "f.json"}},
		{"terminator makes the rest positional", []string{"--", "-p", "8080"}, []string{"-p", "8080"}},
		{"terminator after a flag", []string{"-O", "--", "-weird.json"}, []string{"-O", "-weird.json"}},
		{"terminator with nothing after it", []string{"-O", "--"}, []string{"-O"}},
		{"close flag value stays attached", []string{"f.json", "--close-delay", "5s"}, []string{"--close-delay", "5s", "f.json"}},
		{"close is boolean and swallows nothing", []string{"-C", "f.json"}, []string{"-C", "f.json"}},
		{"-OC moves like any other flag", []string{"f.json", "-OC"}, []string{"-OC", "f.json"}},
		// One dash and two are the same flag to the flag package, so a value
		// has to follow its flag either way round.
		{"one-dash long flag value stays attached", []string{"f.json", "-host", "0.0.0.0"}, []string{"-host", "0.0.0.0", "f.json"}},
		{"one-dash theme value stays attached", []string{"f.json", "-theme", "light"}, []string{"-theme", "light", "f.json"}},
		{"one-dash close-delay value stays attached", []string{"f.json", "-close-delay", "5s"}, []string{"-close-delay", "5s", "f.json"}},
		{"two-dash short flag value stays attached", []string{"f.json", "--p", "8080"}, []string{"--p", "8080", "f.json"}},
		// An attached value must not pull the next argument along with it.
		{"equals form keeps the file", []string{"-p=8080", "f.json"}, []string{"-p=8080", "f.json"}},
		{"equals form after the file", []string{"f.json", "--theme=dark"}, []string{"--theme=dark", "f.json"}},
		{"equals form before another flag", []string{"f.json", "--host=0.0.0.0", "-O"}, []string{"--host=0.0.0.0", "-O", "f.json"}},
		{"unknown flag swallows nothing", []string{"-Ox", "f.json"}, []string{"-Ox", "f.json"}},
		{"terminator hides a flag-shaped file", []string{"--", "-OC"}, []string{"-OC"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := reorderArgs(tt.args)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("reorderArgs(%q) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestFlagName(t *testing.T) {
	tests := []struct{ arg, want string }{
		{"-p", "p"},
		{"--p", "p"},
		{"-host", "host"},
		{"--host", "host"},
		{"--host=0.0.0.0", "host"},
		{"-close-delay=5s", "close-delay"},
		{"-OC", "OC"},
		{"--theme=", "theme"},
	}
	for _, tt := range tests {
		t.Run(tt.arg, func(t *testing.T) {
			if got := flagName(tt.arg); got != tt.want {
				t.Errorf("flagName(%q) = %q, want %q", tt.arg, got, tt.want)
			}
		})
	}
}

// Every flag that takes a value has to be in valueFlags, under the name the
// flag package knows it by, or reorderArgs leaves its value behind.
func TestValueFlagsCoversTheCommandLine(t *testing.T) {
	fs := flag.NewFlagSet("jqweb", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	if _, err := parseFlags(fs, nil); err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	fs.VisitAll(func(f *flag.Flag) {
		// A boolean flag is the only kind the flag package will accept
		// without a value following it.
		_, boolean := f.Value.(interface{ IsBoolFlag() bool })
		if boolean == valueFlags[f.Name] {
			t.Errorf("flag %q: boolean = %v, but valueFlags[%q] = %v",
				f.Name, boolean, f.Name, valueFlags[f.Name])
		}
	})
	for name := range valueFlags {
		if fs.Lookup(name) == nil {
			t.Errorf("valueFlags has %q, which is not a flag", name)
		}
	}
}

// parse runs the real command line definition over args. The flag package's
// own error handling is turned off so that a rejected command line comes back
// as a value rather than exiting the test binary.
func parse(t *testing.T, args ...string) (cliOptions, error) {
	t.Helper()
	fs := flag.NewFlagSet("jqweb", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return parseFlags(fs, args)
}

func TestParseFlagsDefaults(t *testing.T) {
	opt, err := parse(t)
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if opt.host != "127.0.0.1" || opt.theme != "auto" {
		t.Errorf("host = %q, theme = %q; want 127.0.0.1 and auto", opt.host, opt.theme)
	}
	if opt.closeOnGet {
		t.Error("closeOnGet is on by default; -C has to be asked for")
	}
	if opt.closeDelay != time.Second {
		t.Errorf("closeDelay = %s, want 1s", opt.closeDelay)
	}
	if opt.portSet || opt.outSet || len(opt.args) != 0 {
		t.Errorf("portSet = %v, outSet = %v, args = %q; want false, false, none",
			opt.portSet, opt.outSet, opt.args)
	}
}

func TestParseFlagsClose(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		close     bool
		delay     time.Duration
		open      bool
		leftovers []string
	}{
		{"absent", []string{"f.json"}, false, time.Second, false, []string{"f.json"}},
		{"short", []string{"-C", "f.json"}, true, time.Second, false, []string{"f.json"}},
		{"long", []string{"--close", "f.json"}, true, time.Second, false, []string{"f.json"}},
		{"-OC", []string{"-OC", "f.json"}, true, time.Second, true, []string{"f.json"}},
		{"-CO", []string{"-CO", "f.json"}, true, time.Second, true, []string{"f.json"}},
		{"-OC after the file", []string{"f.json", "-OC"}, true, time.Second, true, []string{"f.json"}},
		{"-OC with a delay", []string{"-OC", "--close-delay", "3s"}, true, 3 * time.Second, true, nil},
		{"-O without -C", []string{"-O", "f.json"}, false, time.Second, true, []string{"f.json"}},
		{"one-dash close", []string{"-close", "f.json"}, true, time.Second, false, []string{"f.json"}},
		{"one-dash delay after the file", []string{"f.json", "-close-delay", "2s"}, true, 2 * time.Second, false, []string{"f.json"}},
		{"delay implies close", []string{"--close-delay", "5s"}, true, 5 * time.Second, false, nil},
		{"delay with an equals sign", []string{"--close-delay=250ms"}, true, 250 * time.Millisecond, false, nil},
		{"delay after the file", []string{"f.json", "--close-delay", "2s"}, true, 2 * time.Second, false, []string{"f.json"}},
		{"delay alongside -C", []string{"-C", "--close-delay", "0s"}, true, 0, false, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opt, err := parse(t, tt.args...)
			if err != nil {
				t.Fatalf("parseFlags(%q): %v", tt.args, err)
			}
			if opt.closeOnGet != tt.close {
				t.Errorf("closeOnGet = %v, want %v", opt.closeOnGet, tt.close)
			}
			if opt.closeDelay != tt.delay {
				t.Errorf("closeDelay = %s, want %s", opt.closeDelay, tt.delay)
			}
			if opt.open != tt.open {
				t.Errorf("open = %v, want %v", opt.open, tt.open)
			}
			if len(opt.args) != len(tt.leftovers) {
				t.Fatalf("args = %q, want %q", opt.args, tt.leftovers)
			}
			for i := range tt.leftovers {
				if opt.args[i] != tt.leftovers[i] {
					t.Errorf("args = %q, want %q", opt.args, tt.leftovers)
					break
				}
			}
		})
	}
}

// The flags that were given are read back off the FlagSet rather than compared
// against their defaults, so a flag given its default value still counts.
func TestParseFlagsRecordsWhichFlagsWereGiven(t *testing.T) {
	opt, err := parse(t, "-p=0", "f.json")
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if !opt.portSet {
		t.Error("portSet is false for -p=0, so an explicit port 0 would fall back to output")
	}
	opt, err = parse(t, "-o", "-")
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if !opt.outSet || opt.portSet {
		t.Errorf("outSet = %v, portSet = %v; want true, false", opt.outSet, opt.portSet)
	}
}

func TestParseFlagsRejects(t *testing.T) {
	bad := [][]string{
		{"-OCx"},                    // -OC is a flag, but -OCx is not
		{"-Op"},                     // only -OC and -CO run two flags together
		{"-vO"},                     // and no other pair does
		{"--close-delay", "banana"}, // not a duration
		{"--close-delay"},           // no value
		{"--nonesuch"},
	}
	for _, args := range bad {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			if _, err := parse(t, args...); err == nil {
				t.Errorf("parseFlags(%q) was accepted, want an error", args)
			}
		})
	}
}
