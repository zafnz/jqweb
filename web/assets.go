// Package web holds the files a rendered page is assembled from. It is a Go
// package because go:embed cannot name a file outside the directory of the
// package that embeds it.
package web

import "embed"

// Assets holds the page shell, both stylesheets and the three compiled
// scripts, at their paths relative to this directory.
//
//go:embed page.html styles/page.css styles/query.css dist/theme.js dist/simple.js dist/full.js
var Assets embed.FS
