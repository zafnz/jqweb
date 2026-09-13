package main

import (
	"os"
	"syscall"
)

// detachedProcessFlag is DETACHED_PROCESS, which the syscall package does not
// name.
const detachedProcessFlag = 0x8

// detachedProcess starts the -C child with no console and in a process group
// of its own, so the console's Ctrl-C does not reach it.
func detachedProcess() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: detachedProcessFlag | syscall.CREATE_NEW_PROCESS_GROUP}
}

// detachOutputs points the -C child's stdout and stderr at null, so nothing
// written after the parent exits goes to a pipe with no reader.
func detachOutputs(null *os.File) {
	os.Stdout = null
	os.Stderr = null
}
