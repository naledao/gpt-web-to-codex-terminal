package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"web2term/agent/internal/auth"
)

func loginFixture() auth.LoginResponse {
	return auth.LoginResponse{
		AccessToken: "fixture-access-token", TokenType: "Bearer", ExpiresInSeconds: 86400,
		User: auth.User{PublicID: "usr_fixture", Email: "user@example.com", Nickname: "fixture", Role: "USER"},
	}
}

func TestSaveLoginPreservesConfigAndExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	initial := `{"server_url":"https://example.com/backend","device_id":"fixture-device","future":{"enabled":true}}`
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.FixedZone("test", 8*3600))
	if err := SaveLogin(path, "https://example.com/backend", loginFixture(), now); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal("saved configuration is not valid JSON")
	}
	var login LoginInfo
	if err := json.Unmarshal(fields["login"], &login); err != nil {
		t.Fatal("saved login is not valid JSON")
	}
	if login.AccessToken != "fixture-access-token" || login.TokenType != "Bearer" || login.ServerURL != "https://example.com/backend" || login.User.PublicID != "usr_fixture" || login.User.AvatarURL != nil {
		t.Fatal("login fields were not preserved correctly")
	}
	if !login.LoggedInAt.Equal(now) || !login.ExpiresAt.Equal(now.Add(24*time.Hour)) || login.LoggedInAt.Location() != time.UTC {
		t.Fatal("UTC login timestamps or expiry were incorrect")
	}
	if string(fields["device_id"]) != `"fixture-device"` || fields["future"] == nil {
		t.Fatal("unrelated settings were lost")
	}
}

func TestServerChangesClearLogin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := SaveServer(path, "https://example.com"); err != nil {
		t.Fatal(err)
	}
	if err := SaveLogin(path, "https://example.com", loginFixture(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := SaveServer(path, " https://example.com "); err != nil {
		t.Fatal(err)
	}
	fields, err := readFields(path)
	if err != nil || fields["login"] == nil {
		t.Fatal("unchanged server cleared the login")
	}
	if err := SaveServer(path, "https://other.example.com"); err != nil {
		t.Fatal(err)
	}
	fields, err = readFields(path)
	if err != nil || fields["login"] != nil {
		t.Fatal("different server retained old credentials")
	}
	before, _ := os.ReadFile(path)
	if err := SaveLogin(path, "https://example.com", loginFixture(), time.Now()); err == nil {
		t.Fatal("login to an old backend should not be saved")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("rejected login changed the configuration")
	}
}
