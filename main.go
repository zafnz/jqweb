// jqweb renders a JSON document as a self-contained interactive HTML page:
// a collapsible tree with jq-style coloring, text filtering, path lookup, and
// per-key copy-path buttons.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"
)

// versionString is set by the linker at release time:
// -X main.versionString=<tag>
var versionString = ""

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

func usage() {
	fmt.Fprint(os.Stderr, `usage: jqweb [-p|--port <port>] [--host <ip>] [-o|--output <file>] [<query>] [<input-file>]

Reads JSON from <input-file> ("-" or absent: stdin) and renders it as a
self-contained interactive HTML page, which opens with <query> in its search
box. A single argument is the input file if a file by that name exists, and
the query otherwise: "jqweb <query> -" reads stdin, and "jqweb . <input-file>"
reads the file, since "." is no query.

  -p, --port <port>    serve the page on http://<host>:<port>/
      --host <ip>      bind address for -p (default 127.0.0.1)
  -o, --output <file>  write the page to <file>; "-" writes to stdout
  -O, --open           open the page in the default browser
  -C, --close          stop serving once the page has been fetched
      --close-delay <d>  how long after the last fetch -C waits, such as
                       500ms or 5s (default 1s); giving it turns on -C
      --simple         leave out the jq query engine, for a smaller page
      --theme <name>   light, dark, or auto to follow the reader's system
                       (default auto)

-OC does both: open the browser and stop once it has the page.

With no -p and no -o, it listens on a random available port.
`)
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

	portSet bool // -p or --port was given, whatever its value
	outSet  bool // -o or --output was given
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
	fs.DurationVar(&o.closeDelay, "close-delay", time.Second, "")
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
	o.open = o.open || openClose
	// Asking for a delay is asking to close, so --close-delay does not also
	// need -C. Without this the flag on its own would do nothing at all.
	o.closeOnGet = o.closeOnGet || openClose || set["close-delay"]
	o.args = fs.Args()
	return o, nil
}

func main() {
	flag.Usage = usage
	// flag.CommandLine exits on a parse error itself, having reported it.
	opt, err := parseFlags(flag.CommandLine, os.Args[1:])
	if err != nil {
		os.Exit(2)
	}
	port, output, host := opt.port, opt.output, opt.host
	open, simple, theme := opt.open, opt.simple, opt.theme
	portSet, outSet := opt.portSet, opt.outSet

	if opt.version {
		fmt.Fprintf(os.Stdout, "jqweb %s\n", releaseVersion())
		os.Exit(0)
	}

	switch theme {
	case "auto", "light", "dark":
	default:
		fmt.Fprintf(os.Stderr, "jqweb: --theme must be auto, light or dark, not %q\n", theme)
		usage()
		os.Exit(2)
	}

	if opt.closeDelay < 0 {
		fmt.Fprintf(os.Stderr, "jqweb: --close-delay cannot be negative, got %s\n", opt.closeDelay)
		usage()
		os.Exit(2)
	}

	query, inName, err := inputArgs(opt.args, isFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
		usage()
		os.Exit(2)
	}

	// Started once the command line is known to be good and before the
	// document is read, so the request runs alongside the work that follows.
	// Only the exit below ever waits on it.
	notice := checkForUpdate()

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
	if !portSet && !outSet {
		port = 0
		portSet = true
	}

	displayName := inName
	title := "stdin"
	if inName == "-" {
		displayName = "stdin"
	} else {
		title = filepath.Base(inName)
	}

	if err := check(data); err != nil {
		fmt.Fprintf(os.Stderr, "jqweb: %s: %s\n", displayName, err)
		os.Exit(1)
	}

	// The page assembly asks for what to put in rather than what to leave out,
	// so the flag is turned round here and nowhere else.
	page := []byte(renderPage(data, title, options{jq: !simple, theme: theme, query: query}))

	if outSet {
		if output == "-" {
			os.Stdout.Write(page)
		} else {
			if err := os.WriteFile(output, page, 0o644); err != nil {
				fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
				os.Exit(1)
			}
			if open {
				// The filepath must be the absolute path, otherwise the browser will not be able to find the file.
				output, err := filepath.Abs(output)
				if err != nil {
					fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
					os.Exit(1)
				}
				url := "file://" + output
				if err := openBrowser(url); err != nil {
					fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
					os.Exit(1)
				}
			}
		}
	}
	if portSet {
		err := serve(host, port, page, serveOptions{
			open:       open,
			closeOnGet: opt.closeOnGet,
			closeDelay: opt.closeDelay,
			notice:     notice,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "jqweb: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if !outSet {
		os.Stdout.Write(page) // stdout is not a tty here
	}
	// Nothing follows but the exit, so this is the last chance to print an
	// update notice, and the wait is what a check still in flight costs.
	waitNotice(os.Stderr, notice, updateWait)
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
			pos = append(pos, args[i+1:]...)
			break
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

func isTTY(f *os.File) bool {
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
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
