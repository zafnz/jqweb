package serve

import "syscall"

// dup2 is Dup3 on Linux, where arm64 has no dup2 system call.
func dup2(from, to int) error {
	return syscall.Dup3(from, to, 0)
}
