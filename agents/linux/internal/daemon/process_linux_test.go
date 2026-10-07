//go:build linux

package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestClosingParentDescriptorRetainsWorkerLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daemon.lock")
	parent, err := acquireLock(path, true)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	fd, err := syscall.Dup(int(parent.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	worker := os.NewFile(uintptr(fd), "inherited-lock")
	defer worker.Close()
	_ = parent.Close()
	other, err := acquireLock(path, false)
	if other != nil {
		_ = other.Close()
	}
	if !errors.Is(err, errRunning) {
		t.Fatal("closing the parent descriptor released the worker's lock")
	}
	_ = worker.Close()
	other, err = acquireLock(path, false)
	if err != nil {
		t.Fatal("worker exit did not release the lock")
	}
	_ = other.Close()
}

func TestStalePIDIsNotUsedForStatusOrStop(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	files, _ := runtimePaths(path)
	lock, err := acquireLock(files.lock, true)
	if err != nil {
		t.Fatal(err)
	}
	_ = lock.Close()
	if err := writeInfo(files.state, Info{PID: os.Getpid(), State: StateOnline, LogPath: "/tmp/previous-run.log"}); err != nil {
		t.Fatal(err)
	}
	info, err := Inspect(path)
	if err != nil || info.PID != 0 || info.State != StateStopped || info.LogPath == "" {
		t.Fatal("stale PID was treated as a live worker")
	}
	stopped, err := Stop(path)
	if err != nil || stopped {
		t.Fatal("stop attempted to signal a stale PID")
	}
}

func TestIdleStatusAndStopDoNotCreateConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent", "config.json")
	info, err := Inspect(path)
	if err != nil || info.State != StateStopped {
		t.Fatal("idle status failed")
	}
	if stopped, err := Stop(path); err != nil || stopped {
		t.Fatal("idle stop failed")
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("idle query created a configuration directory")
	}
}
