//go:build unix && !linux

package serve

import "syscall"

// dup2 makes to a copy of the descriptor from, closing what to held. Linux
// goes through Dup3 instead, in dup2_linux.go.
func dup2(from, to int) error {
	return syscall.Dup2(from, to)
}
