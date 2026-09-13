//go:build unix && !linux

package serve

import "syscall"

func dup2(from, to int) error {
	return syscall.Dup2(from, to)
}
