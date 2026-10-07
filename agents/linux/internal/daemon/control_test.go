package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestStatusAndStopUseDifferentMethods(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	control := &control{info: Info{PID: 1234, State: StateConnecting, LogPath: "/tmp/fixture.log"}, cancel: cancel}
	status := httptest.NewRecorder()
	control.ServeHTTP(status, httptest.NewRequest(http.MethodGet, "/status", nil))
	var info Info
	if status.Code != http.StatusOK || json.Unmarshal(status.Body.Bytes(), &info) != nil || info.PID != 1234 || info.State != StateConnecting || ctx.Err() != nil {
		t.Fatal("status query modified the running worker")
	}
	wrongMethod := httptest.NewRecorder()
	control.ServeHTTP(wrongMethod, httptest.NewRequest(http.MethodGet, "/stop", nil))
	if wrongMethod.Code != http.StatusNotFound || ctx.Err() != nil {
		t.Fatal("GET request stopped the worker")
	}
	stop := httptest.NewRecorder()
	control.ServeHTTP(stop, httptest.NewRequest(http.MethodPost, "/stop", nil))
	if stop.Code != http.StatusOK || ctx.Err() == nil {
		t.Fatal("stop did not cancel the worker context")
	}
}

func TestStoppedStatusRetainsLogsAndSafeError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daemon-state.json")
	control := &control{statePath: path, info: Info{PID: 1234, LogPath: "/tmp/fixture.log"}}
	control.update(StateOnline, "")
	control.update(StateStopped, "登录已过期，请重新运行 web2term login")
	info, err := readInfo(path)
	if err != nil || info.PID != 0 || info.State != StateStopped || info.LogPath == "" || !strings.Contains(info.LastError, "登录已过期") || info.UpdatedAt.IsZero() {
		t.Fatal("stopped worker lost diagnostics or retained a live PID")
	}
	data, err := os.ReadFile(path)
	if err != nil || strings.Contains(string(data), "access_token") || strings.Contains(string(data), "Authorization") {
		t.Fatal("status contains credential fields")
	}
	files, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".daemon-state-*.tmp"))
	if len(files) != 0 {
		t.Fatal("status write left temporary files behind")
	}
	if runtime.GOOS != "windows" {
		stat, err := os.Stat(path)
		if err != nil || stat.Mode().Perm() != 0o600 {
			t.Fatal("state file is not private")
		}
	}
}

func TestTerminalCountsPersistAndResetOnStop(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daemon-state.json")
	control := &control{statePath: path, info: Info{State: StateOnline, MaxTerminals: 3}}
	control.updateTerminals(3)
	info, err := readInfo(path)
	if err != nil || info.TerminalCount != 3 || info.MaxTerminals != 3 {
		t.Fatal("terminal capacity was not persisted")
	}
	control.update(StateStopped, "")
	info, err = readInfo(path)
	if err != nil || info.TerminalCount != 0 || info.MaxTerminals != 3 {
		t.Fatal("stopped state retained active terminals or lost capacity")
	}
}
