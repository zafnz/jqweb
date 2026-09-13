//go:build unix

package main

import (
	"os"
	"syscall"
)

// detachedProcess starts the -C child in a session of its own, with no
// controlling terminal, so the terminal's Ctrl-C and hangup do not reach it.
func detachedProcess() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// detachOutputs puts null in place of the -C child's stdout and stderr. Once
// the parent exits they are pipes with no reader, and the Go runtime exits a
// process on its first write to a broken pipe on fd 1 or 2.
func detachOutputs(null *os.File) {
	fd := int(null.Fd())
	dup2(fd, 1)
	dup2(fd, 2)
}
