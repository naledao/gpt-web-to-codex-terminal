//go:build linux

package terminal

import (
	"bytes"
	"io"
	"os"
	"testing"
	"time"
)

// Explicit user opt-in only. Ordinary offline tests never launch a real Shell.
func TestLinuxPTYIntegration(t *testing.T) {
	if os.Getenv("WEB2TERM_PTY_INTEGRATION") != "1" {
		t.Skip("user-run only: node tools/diag/web2term-server-check.cjs --pty on Linux")
	}
	p, err := startShell("/bin/sh", t.TempDir(), Size{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	waited := make(chan Exit, 1)
	go func() { exit, _ := p.Wait(); waited <- exit }()
	defer func() {
		_ = p.Close()
		_ = p.Kill()
		select {
		case <-waited:
		case <-time.After(3 * time.Second):
			t.Error("Shell did not exit")
		}
	}()
	chunks := make(chan []byte, 32)
	readDone := make(chan error, 1)
	go func() {
		buffer := make([]byte, 1024)
		for {
			n, err := p.Read(buffer)
			if n > 0 {
				chunks <- append([]byte(nil), buffer[:n]...)
			}
			if err != nil {
				readDone <- err
				return
			}
		}
	}()
	if err := p.Resize(Size{Cols: 132, Rows: 43}); err != nil {
		t.Fatal(err)
	}
	// Split the marker so terminal echo cannot satisfy the output assertion.
	if _, err := p.Write([]byte("printf 'web2term-%s\\n' 'pty-ready'; stty size\n")); err != nil {
		t.Fatal(err)
	}
	var output []byte
	deadline := time.After(5 * time.Second)
	for !bytes.Contains(output, []byte("web2term-pty-ready")) || !bytes.Contains(output, []byte("43 132")) {
		select {
		case chunk := <-chunks:
			output = append(output, chunk...)
		case err := <-readDone:
			t.Fatalf("PTY closed early: %v", err)
		case <-deadline:
			t.Fatal("PTY output or window size missing")
		}
	}
	_ = p.Terminate()
	_ = p.Close()
	select {
	case err := <-readDone:
		if err != nil && err != io.EOF && !bytes.Contains([]byte(err.Error()), []byte("closed")) {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not unblock PTY Read")
	}
}
