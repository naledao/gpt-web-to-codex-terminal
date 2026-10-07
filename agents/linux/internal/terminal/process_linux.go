//go:build linux

package terminal

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"
)

type linuxProcess struct {
	file    *os.File
	command *exec.Cmd
	shell   string
}

func DefaultFactory(size Size) (Process, error) {
	shell := ""
	for _, candidate := range []string{os.Getenv("SHELL"), "/bin/bash", "/bin/sh"} {
		if !filepath.IsAbs(candidate) {
			continue
		}
		stat, err := os.Stat(candidate)
		if err == nil && stat.Mode().IsRegular() && stat.Mode().Perm()&0o111 != 0 {
			shell = candidate
			break
		}
	}
	if shell == "" {
		return nil, errors.New("no usable shell")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return startShell(shell, home, size)
}

func startShell(shell, dir string, size Size) (Process, error) {
	command := exec.Command(shell, "-i")
	command.Dir = dir
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "TERM=") && !strings.HasPrefix(item, "COLUMNS=") && !strings.HasPrefix(item, "LINES=") {
			command.Env = append(command.Env, item)
		}
	}
	command.Env = append(command.Env, "TERM=xterm-256color")
	master, err := pty.StartWithSize(command, &pty.Winsize{Cols: uint16(size.Cols), Rows: uint16(size.Rows)})
	if err != nil {
		return nil, err
	}
	// Re-wrap a duplicate that is already nonblocking so Go's poller can
	// interrupt reads/writes on Close. The old wrapper must never own the new FD.
	syscall.ForkLock.RLock()
	fd, err := syscall.Dup(int(master.Fd()))
	if err == nil {
		syscall.CloseOnExec(fd)
	}
	syscall.ForkLock.RUnlock()
	if err == nil {
		err = syscall.SetNonblock(fd, true)
	}
	if err != nil {
		if fd >= 0 {
			_ = syscall.Close(fd)
		}
		_ = master.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, err
	}
	_ = master.Close()
	file := os.NewFile(uintptr(fd), "web2term-pty")
	return &linuxProcess{file: file, command: command, shell: shell}, nil
}

func (process *linuxProcess) Read(data []byte) (int, error) {
	n, err := process.file.Read(data)
	if errors.Is(err, syscall.EIO) {
		err = io.EOF
	} // Linux PTY slave has closed
	return n, err
}
func (process *linuxProcess) Write(data []byte) (int, error) {
	if err := process.file.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return 0, err
	}
	return process.file.Write(data)
}
func (process *linuxProcess) Close() error  { return process.file.Close() }
func (process *linuxProcess) Shell() string { return process.shell }

func (process *linuxProcess) Resize(size Size) error {
	raw, err := process.file.SyscallConn()
	if err != nil {
		return err
	}
	window := pty.Winsize{Cols: uint16(size.Cols), Rows: uint16(size.Rows)}
	var ioctlErr syscall.Errno
	err = raw.Control(func(fd uintptr) {
		_, _, ioctlErr = syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&window)))
	})
	if err != nil {
		return err
	}
	if ioctlErr != 0 {
		return ioctlErr
	}
	return nil
}

func (process *linuxProcess) Terminate() error {
	// Interrupt the terminal's foreground job as well as the Shell. Closing
	// the PTY next also delivers the normal terminal hangup behavior.
	if raw, err := process.file.SyscallConn(); err == nil {
		_ = raw.Control(func(fd uintptr) {
			var group int32
			_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCGPGRP, uintptr(unsafe.Pointer(&group)))
			if errno == 0 && group > 0 && int(group) != syscall.Getpgrp() {
				_ = syscall.Kill(-int(group), syscall.SIGTERM)
			}
		})
	}
	return process.command.Process.Signal(syscall.SIGTERM)
}
func (process *linuxProcess) Kill() error { return process.command.Process.Kill() }
func (process *linuxProcess) Wait() (Exit, error) {
	err := process.command.Wait()
	state := process.command.ProcessState
	if state == nil {
		return Exit{ExitCode: -1}, err
	}
	exit := Exit{ExitCode: state.ExitCode()}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		exit.Signal = status.Signal().String()
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		err = nil
	} // nonzero exit is a terminal result
	return exit, err
}
