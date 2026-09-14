// jqweb renders a JSON document as one self-contained HTML page: a collapsible
// tree with text search, path lookup, jq queries and a copy-path button on
// every line. The page is served locally or written to a file.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/zafnz/jqweb/internal/check"
	"github.com/zafnz/jqweb/internal/page"
	"github.com/zafnz/jqweb/internal/serve"
	"github.com/zafnz/jqweb/internal/update"
	"golang.org/x/term"
)

func fileURL(path string) string {
	path = filepath.ToSlash(path)
	if len(path) >= 3 && path[1] == ':' && path[2] == '/' {
		path = "/" + path
	}
	return (&url.URL{Scheme: "file", Path: path}).String()
}

// versionString is set by the linker at release time:
// -X main.versionString=<tag>
var versionString = ""

// updateCheck is set by the linker to switch the update check off for good:
//
//	-X main.updateCheck=off
//
// It is there for downstream packagers, whose users upgrade through the
// package manager rather than by being told to.
var updateCheck = ""

// releaseVersion reports the release tag when the linker set one, otherwise the
// module version recorded by "go install", otherwise "dev" for a local build.
func releaseVersion() string {
	if versionString != "" {
		return versionString
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		if v := bi.Main.Version; v != "" && v != "(devel)" {
			return strings.TrimPrefix(v, "v")
		}
	}
	return "dev"
}

// usageText is what a bad command line prints. README.md carries the same
// text in its usage section, and TestReadmeCarriesUsage fails when the two
// drift apart.
const usageText = `usage: jqweb [-p|--port <port>] [--host <ip>] [-o|--output <file>] [-O|--open]
             [-C|--close] [--close-delay <d>] [--simple] [--theme <name>]
             [-v|--version] [<query>] [<input-file>]

Reads JSON from <input-file> ("-" or absent: stdin) and renders it as a
self-contained interactive HTML page, which opens with <query> in its search
box. A single argument is the input file if a file by that name exists, and
the query otherwise: "jqweb <query> -" reads stdin, and "jqweb . <input-file>"
reads the file, since "." is no query.

  -p, --port <port>    serve the page on http://<host>:<port>/
      --host <ip>      bind address for -p (default 127.0.0.1)
  -o, --output <file>  write the page to <file>; "-" writes to stdout
  -O, --open           open the page in the default browser
  -C, --close          serve from the background until the last tab closes
      --close-delay <d>  how long after the last tab closes -C waits
                       (default 10s); giving it turns on -C
      --simple         leave out the jq query engine, for a smaller page
      --theme <name>   light, dark, or auto to follow the reader's system
                       (default auto)
  -v, --version        print the version and exit

-OC does both: open the browser and serve from the background.

With no -p and no -o, it listens on a random available port.
`

func usage() {
	fmt.Fprint(os.Stderr, usageText)
}

// cliOptions is a parsed command line: the flag values, which of them were
// given at all, and the positional arguments left over.
type cliOptions struct {
	port       int
	output     string
	host       string
	open       bool
	simple     bool
	theme      string
	version    bool
	closeOnGet bool
	closeDelay time.Duration
	child      bool // this is the -C child that serves in the background

	portSet bool // -p or --port was given, whatever its value
	outSet  bool // -o or --output was given
	hostSet bool // --host was given
	args    []string
}

// parseFlags defines the command line on fs and parses args into a cliOptions.
// The arguments are reordered first so that flags may follow the input file,
// and the settings that depend on whether a flag was given at all, rather than
// on its value, are resolved here.
func parseFlags(fs *flag.FlagSet, args []string) (cliOptions, error) {
	var o cliOptions
	fs.IntVar(&o.port, "p", 0, "")
	fs.IntVar(&o.port, "port", 0, "")
	fs.StringVar(&o.output, "o", "", "")
	fs.StringVar(&o.output, "output", "", "")
	fs.StringVar(&o.host, "host", "127.0.0.1", "")
	fs.BoolVar(&o.open, "open", false, "")
	fs.BoolVar(&o.open, "O", false, "")
	fs.BoolVar(&o.closeOnGet, "close", false, "")
	fs.BoolVar(&o.closeOnGet, "C", false, "")
	fs.DurationVar(&o.closeDelay, "close-delay", 10*time.Second, "")
	fs.BoolVar(&o.child, "child", false, "")
	// The flag package has no notion of bundling, so the one combination worth
	// writing as a bundle is spelled out as a flag of its own.
	var openClose bool
	fs.BoolVar(&openClose, "OC", false, "")
	fs.BoolVar(&openClose, "CO", false, "")
	fs.BoolVar(&o.simple, "simple", false, "")
	fs.StringVar(&o.theme, "theme", "auto", "")
	fs.BoolVar(&o.version, "version", false, "")
	fs.BoolVar(&o.version, "v", false, "")

	if err := fs.Parse(reorderArgs(args)); err != nil {
		return o, err
	}

	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	o.portSet = set["p"] || set["port"]
	o.outSet = set["o"] || set["output"]
	o.hostSet = set["host"]
	o.open = o.open || openClose
	// Asking for a delay is asking to close, so --close-delay does not also
	// need -C. Without this the flag on its own would do nothing at all.
	o.closeOnGet = o.closeOnGet || openClose || set["close-delay"]
	o.args = fs.Args()
	return o, nil
}

// flagConflict reports a flag that the rest of the command line leaves with
// nothing to do. Each case is -o without -p, since -p serves the page as well
// as writing the file.
func flagConflict(o cliOptions) error {
	if !o.outSet || o.portSet {
		return nil
	}
	switch {
	case o.closeOnGet:
		return errors.New("-C and --close-delay close a served page, and -o without -p serves nothing")
	case o.hostSet:
		return errors.New("--host sets where the page is served, and -o without -p serves nothing")
	case o.open && o.output == "-":
		return errors.New("-O has nothing to open when -o - writes the page to stdout")
	}
	return nil
}

func main() {
	flag.Usage = usage
	// flag.CommandLine exits on a parse error itself, having reported it.
	opt, err := parseFlags(flag.CommandLine, os.Args[1:])
	if err != nil {
		os.Exit(2)
	}

	if opt.version {
		fmt.Fprintf(os.Stdout, "jqweb %s\n", releaseVersion())
		os.Exit(0)
	}

	switch opt.theme {
	case "auto", "light", "dark":
	default:
		fmt.Fprintf(os.Stderr, "jqweb: --theme must be auto, light or dark, not %q\n", opt.theme)
		usage()
		os.Exit(2)
	}

	if opt.closeDelay < 0 {
		fmt.Fprintf(os.Stderr, "jqweb: --close-delay cannot be negative, got %s\n", opt.closeDelay)
		usage()
		os.Exit(2)
	}

	if err := flagConflict(opt); err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		usage()
		os.Exit(2)
	}

	query, inName, err := inputArgs(opt.args, isFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		usage()
		os.Exit(2)
	}

	// -p serves and -o writes a file; given neither, the page is served on a
	// random port, and given both it is served and written.
	serving := opt.portSet || !opt.outSet

	// Started once the command line is known to be good and before the
	// document is read, so the request runs alongside the work that follows.
	// Only an exit ever waits on it. The -C parent keeps the terminal, so it
	// checks and the child does not.
	var notice <-chan string
	if !opt.child {
		notice = update.Check(releaseVersion(), updateCheck == "off", isTTY(os.Stderr))
	}
	if opt.closeOnGet && !opt.child && serving {
		os.Exit(serve.RunInBackground(notice))
	}

	var data []byte
	if inName == "-" {
		if isTTY(os.Stdin) {
			// A lone argument naming no file was taken for a query, but with
			// nothing on stdin to run it on it is as likely a mistyped file
			// name, so the message has to make sense read either way.
			if len(opt.args) == 1 && query != "" {
				fmt.Fprintf(os.Stderr, "jqweb: no file named %q, and stdin is a terminal\n", query)
			} else {
				fmt.Fprintln(os.Stderr, "jqweb: no input file and stdin is a terminal")
			}
			usage()
			os.Exit(2)
		}
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(inName)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		os.Exit(1)
	}

	displayName, title := inName, filepath.Base(inName)
	if inName == "-" {
		displayName, title = "stdin", "stdin"
	}

	if err := check.Document(data); err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %s: %s\n", displayName, err)
		os.Exit(1)
	}

	// The page assembly asks for what to put in rather than what to leave out,
	// so the flag is turned round here and nowhere else.
	pageOpt := page.Options{JQ: !opt.simple, Theme: opt.theme, Query: query}

	if opt.outSet {
		rendered := []byte(page.Render(data, title, pageOpt))
		if opt.output == "-" {
			os.Stdout.Write(rendered)
		} else {
			if err := os.WriteFile(opt.output, rendered, 0o644); err != nil {
				fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
				os.Exit(1)
			}
			if opt.open {
				// A file: URL needs the absolute path; the browser has no
				// working directory to resolve a relative one against.
				abs, err := filepath.Abs(opt.output)
				if err != nil {
					fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
					os.Exit(1)
				}
				if err := serve.OpenBrowser(fileURL(abs)); err != nil {
					fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
					os.Exit(1)
				}
			}
		}
	}
	if serving {
		// Only a served page holds /alive open, so -o and -p together render
		// it twice.
		pageOpt.Served = true
		err := serve.Serve(opt.host, opt.port, []byte(page.Render(data, title, pageOpt)), serve.Options{
			Open:       opt.open,
			CloseOnGet: opt.closeOnGet,
			CloseDelay: opt.closeDelay,
			FirstLoad:  serve.FirstLoadTimeout,
			Notice:     notice,
			Background: opt.child,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
			os.Exit(1)
		}
		return
	}
	// Nothing follows but the exit, so this is the last chance to print an
	// update notice, and the wait is what a check still in flight costs.
	update.WaitNotice(os.Stderr, notice, update.ExitWait)
}

// valueFlags are the flags that take a value, by the name the flag package
// knows them by. reorderArgs needs them to keep a value with its flag; a flag
// missing from here has its value left where it was written, which for
// "jqweb file.json --theme light" means "light" becomes a second input file.
var valueFlags = map[string]bool{
	"p": true, "port": true,
	"o": true, "output": true,
	"theme":       true,
	"host":        true,
	"close-delay": true,
}

// reorderArgs moves flags ahead of positional arguments so that
// "jqweb data.json -p 8080" works; the flag package stops parsing at the
// first non-flag argument.
func reorderArgs(args []string) []string {
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			// The terminator goes on to the flag package as well, which
			// otherwise reads a positional argument such as "-dash.json" as a
			// flag.
			return append(append(flags, a), append(pos, args[i+1:]...)...)
		}
		if strings.HasPrefix(a, "-") && a != "-" {
			flags = append(flags, a)
			// "--theme=dark" carries its own value; only the separated form
			// takes the next argument with it.
			if !strings.Contains(a, "=") && valueFlags[flagName(a)] && i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
		} else {
			pos = append(pos, a)
		}
	}
	return append(flags, pos...)
}

// flagName is the name the flag package reads out of an argument: the leading
// dashes removed, and anything from an "=" onwards dropped. One dash and two
// mean the same thing there, so "-theme" and "--theme" are one flag and this
// is what keeps them one entry in valueFlags.
func flagName(a string) string {
	name, _, _ := strings.Cut(strings.TrimLeft(a, "-"), "=")
	return name
}

// isTTY reports whether f is a terminal, which decides whether stdin can be
// read for the document and whether anyone is watching stderr for a notice.
func isTTY(f *os.File) bool {
	return term.IsTerminal(int(f.Fd()))
}

// inputArgs splits the positional arguments into a query and the name of the
// input file, "-" meaning stdin. With two arguments the first is the query.
// With one, it is the input file if isFile reports a file by that name, and
// the query otherwise; "jqweb <query> -" and "jqweb . <file>" are the ways to
// say which without that test. A query of "." applies no filter, so it comes
// back as no query at all.
func inputArgs(args []string, isFile func(string) bool) (query, inName string, err error) {
	switch len(args) {
	case 0:
		inName = "-"
	case 1:
		if args[0] == "-" || isFile(args[0]) {
			inName = args[0]
		} else {
			query, inName = args[0], "-"
		}
	case 2:
		query, inName = args[0], args[1]
	default:
		return "", "", errors.New("at most one query and one input file")
	}
	if strings.TrimSpace(query) == "." {
		query = ""
	}
	return query, inName, nil
}

// isFile reports whether name is something to read input from: anything that
// exists and is not a directory. A named pipe or /dev/stdin counts, and "."
// and ".." are queries rather than directories.
func isFile(name string) bool {
	fi, err := os.Stat(name)
	return err == nil && !fi.IsDir()
}
