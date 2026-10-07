package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func agentConfigFixture(t *testing.T) (string, time.Time) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	if err := SaveServer(path, "https://example.com/backend"); err != nil {
		t.Fatal(err)
	}
	if err := SaveLogin(path, "https://example.com/backend", loginFixture(), now); err != nil {
		t.Fatal(err)
	}
	return path, now
}

func TestAgentDeviceIdentityPersists(t *testing.T) {
	path, now := agentConfigFixture(t)
	first, err := AgentConfig(path, now, "test-host")
	if err != nil {
		t.Fatal(err)
	}
	if !validUUID(first.DeviceID) || first.DeviceID[14] != '4' || first.DeviceName != "test-host" {
		t.Fatal("device identity was not generated correctly")
	}
	before, _ := os.ReadFile(path)
	second, err := AgentConfig(path, now, "different-host")
	if err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if second.DeviceID != first.DeviceID || second.DeviceName != first.DeviceName || string(before) != string(after) {
		t.Fatal("restarting changed device identity or rewrote configuration")
	}
	if second.Login.AccessToken != "fixture-access-token" || second.ServerURL != "https://example.com/backend" {
		t.Fatal("device creation lost login or server settings")
	}
}

func TestAgentConfigRejectsInvalidOrExpiredLoginWithoutWriting(t *testing.T) {
	for _, mode := range []string{"missing", "expired", "wrong-server", "invalid-device", "extra-hyphens", "invalid-name"} {
		t.Run(mode, func(t *testing.T) {
			path, now := agentConfigFixture(t)
			fields, _ := readFields(path)
			switch mode {
			case "missing":
				delete(fields, "login")
			case "expired":
				now = now.Add(24 * time.Hour)
			case "wrong-server":
				fields["server_url"] = json.RawMessage(`"https://other.example.com"`)
			case "invalid-device":
				fields["device_id"] = json.RawMessage(`"invalid"`)
			case "extra-hyphens":
				fields["device_id"] = json.RawMessage(`"--a5ddcc-43a8-4d91-b956-75d00e4e3112"`)
			case "invalid-name":
				fields["device_name"] = json.RawMessage(`"fixture\r\nInjected: value"`)
			}
			if err := writeFields(path, fields); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			if _, err := AgentConfig(path, now, "test-host"); err == nil {
				t.Fatal("invalid run configuration was accepted")
			}
			after, _ := os.ReadFile(path)
			if string(before) != string(after) {
				t.Fatal("rejected startup modified configuration")
			}
		})
	}
}

func TestAgentHostnameFallbackAndUUIDNormalization(t *testing.T) {
	path, now := agentConfigFixture(t)
	fields, _ := readFields(path)
	fields["device_id"] = json.RawMessage(`"F2A5DDCC-43A8-4D91-B956-75D00E4E3112"`)
	if err := writeFields(path, fields); err != nil {
		t.Fatal(err)
	}
	settings, err := AgentConfig(path, now, "主机名称")
	if err != nil {
		t.Fatal(err)
	}
	if settings.DeviceID != "f2a5ddcc-43a8-4d91-b956-75d00e4e3112" || settings.DeviceName != "agent-f2a5ddcc" {
		t.Fatal("UUID normalization or safe hostname fallback failed")
	}
}
