package cli

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"web2term/agent/internal/config"
	"web2term/agent/internal/daemon"
)

func TestInteractiveRetriesThenSaves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "web2term", "config.json")
	var output bytes.Buffer
	input := strings.NewReader("\nnot-a-url\n  http://127.0.0.1:8080/backend/  \r\n")
	if err := Run([]string{"set", "server"}, input, &output, path); err != nil {
		t.Fatal(err)
	}
	server, err := config.Server(path)
	if err != nil || server != "http://127.0.0.1:8080/backend/" {
		t.Fatalf("saved server = %q, %v", server, err)
	}
	if strings.Count(output.String(), "请输入后端请求地址") != 3 || !strings.Contains(output.String(), "已保存") {
		t.Fatalf("unexpected interaction: %s", &output)
	}
}

func TestBlankAndEOFLeaveConfigUntouched(t *testing.T) {
	for _, input := range []string{"  \r\n", "", "invalid\n"} {
		t.Run(input, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			initial := `{"server_url":"https://example.com","device_id":"fixture-device"}`
			if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			if err := Run([]string{"set", "server"}, strings.NewReader(input), &output, path); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != initial {
				t.Fatal("cancel or blank input changed the existing file")
			}
			if !strings.Contains(output.String(), "当前后端请求地址：https://example.com") {
				t.Fatal("current server was not shown")
			}
		})
	}
}

func TestCancelledFirstSetupDoesNotCreateConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "web2term", "config.json")
	var output bytes.Buffer
	if err := Run([]string{"set", "server"}, strings.NewReader(""), &output, path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled setup created configuration: %v", err)
	}
}

func TestNonInteractiveArgumentIsRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	var output bytes.Buffer
	err := Run([]string{"set", "server", "https://example.com"}, strings.NewReader(""), &output, path)
	if err == nil {
		t.Fatal("an address argument should be rejected in interactive mode")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid command changed configuration")
	}
}

func TestRunRequiresConfiguredLogin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	var output bytes.Buffer
	if err := Run([]string{"run"}, strings.NewReader(""), &output, path); err == nil {
		t.Fatal("run without settings was allowed")
	}
	if output.Len() != 0 {
		t.Fatal("run prompted before validating settings")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed run created configuration")
	}
}

func TestBackgroundStatusOutput(t *testing.T) {
	var output bytes.Buffer
	info := daemon.Info{PID: 1234, State: daemon.StateReconnecting, LastError: "网络连接中断", LogPath: "/tmp/run-fixture.log", OutputPath: "/tmp/daemon-fixture.log", TerminalCount: 2, MaxTerminals: 3}
	if err := printAgentInfo(&output, info); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"等待重新连接", "1234", "网络连接中断", "/tmp/run-fixture.log", "/tmp/daemon-fixture.log", "终端会话：2/3"} {
		if !strings.Contains(output.String(), text) {
			t.Fatal("background status omits process or diagnostic information")
		}
	}
	output.Reset()
	if err := printAgentInfo(&output, daemon.Info{State: daemon.StateStopped}); err != nil || !strings.Contains(output.String(), "未运行") || strings.Contains(output.String(), "进程 PID") {
		t.Fatal("idle status suggests a running process")
	}
}
