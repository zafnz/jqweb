package serve

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

// detachOutputs points the -C child's stdout and stderr at null, which it
// keeps open, and closes the pipe handles they held. The parent reads those
// pipes until they close, so replacing the variables alone would leave it
// waiting.
func detachOutputs(null *os.File) {
	stdout, stderr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = null, null
	stdout.Close()
	stderr.Close()
}
