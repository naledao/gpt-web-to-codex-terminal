package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestServerURLValidation(t *testing.T) {
	valid := []struct{ input, want string }{
		{" https://example.com:8443/api/ ", "https://example.com:8443/api/"},
		{"http://127.0.0.1:8080", "http://127.0.0.1:8080"},
		{"http://[::1]:8080/backend", "http://[::1]:8080/backend"},
	}
	for _, test := range valid {
		got, err := NormalizeServerURL(test.input)
		if err != nil || got != test.want {
			t.Errorf("NormalizeServerURL(%q) = %q, %v; want %q", test.input, got, err, test.want)
		}
	}
	invalid := []string{
		"", "example.com:8080", "wss://example.com", "https:///api",
		"https://:8443", "http://localhost:0", "http://localhost:65536",
		"http://localhost:", "http://[not-an-ip]:8080", "http://::1:8080",
		"https://user:password@example.com", "https://example.com?token=example",
		"https://example.com?", "https://example.com#", "https://example.com/a b",
	}
	for _, input := range invalid {
		if _, err := NormalizeServerURL(input); err == nil {
			t.Errorf("accepted invalid address %q", input)
		}
	}
}

func TestSavePreservesOtherSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	initial := `{"server_url":"http://localhost:8080","device_id":"fixture-device","future":{"enabled":true}}`
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveServer(path, "https://example.com:8443/backend/"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	var device string
	if err := json.Unmarshal(fields["device_id"], &device); err != nil || device != "fixture-device" {
		t.Fatal("device_id was lost or changed")
	}
	var future struct{ Enabled bool }
	if err := json.Unmarshal(fields["future"], &future); err != nil || !future.Enabled {
		t.Fatal("unrecognized configuration was lost or changed")
	}
	server, err := Server(path)
	if err != nil || server != "https://example.com:8443/backend/" {
		t.Fatalf("saved server = %q, %v", server, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("config permissions are not 0600: %v", err)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v, %v", entries, err)
	}
}

func TestInvalidConfigIsNotOverwritten(t *testing.T) {
	for _, contents := range []string{`{"device_id":`, `null`, `[]`, ""} {
		t.Run(contents, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := SaveServer(path, "https://example.com"); err == nil {
				t.Fatal("invalid configuration should be rejected")
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != contents {
				t.Fatal("existing configuration was modified")
			}
		})
	}
}
