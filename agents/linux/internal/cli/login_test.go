package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"web2term/agent/internal/auth"
	"web2term/agent/internal/config"
	"web2term/agent/internal/diagnostic"
)

type fakeLoginAPI struct {
	sendError   error
	loginError  error
	sendCount   int
	loginCount  int
	rejectFirst bool
}

func (api *fakeLoginAPI) SendCode(context.Context, string) error {
	api.sendCount++
	return api.sendError
}

func (api *fakeLoginAPI) Login(_ context.Context, _, _ string) (auth.LoginResponse, error) {
	api.loginCount++
	if api.rejectFirst && api.loginCount == 1 {
		return auth.LoginResponse{}, &auth.APIError{StatusCode: 401, Code: "LOGIN_CODE_INCORRECT"}
	}
	return cliLoginFixture(), api.loginError
}

func cliLoginFixture() auth.LoginResponse {
	return auth.LoginResponse{
		AccessToken: "fixture-access-token", TokenType: "Bearer", ExpiresInSeconds: 86400,
		User: auth.User{PublicID: "usr_fixture", Email: "user@example.com", Nickname: "fixture", Role: "USER"},
	}
}

func TestInteractiveLoginRetriesAndSaves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	server := "https://example.com"
	if err := config.SaveServer(path, server); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 7, 4, 0, 0, 0, time.UTC)
	var output bytes.Buffer
	api := &fakeLoginAPI{rejectFirst: true}
	input := strings.NewReader("invalid\nuser@example.com\nabc\n001234\n002345\n")
	if err := loginWithClient(input, &output, path, server, api, func() time.Time { return now }, nil); err != nil {
		t.Fatal(err)
	}
	if api.sendCount != 1 || api.loginCount != 2 {
		t.Fatal("validation or incorrect-code retry generated unexpected requests")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved struct{ Login config.LoginInfo }
	if err := json.Unmarshal(data, &saved); err != nil || saved.Login.User.PublicID != "usr_fixture" || !saved.Login.ExpiresAt.Equal(now.Add(24*time.Hour)) {
		t.Fatal("successful login was not saved correctly")
	}
	if !strings.Contains(output.String(), "登录成功") || strings.Contains(output.String(), "fixture-access-token") || strings.Contains(output.String(), "001234") || strings.Contains(output.String(), "002345") {
		t.Fatal("success output is missing or exposes a token/code")
	}
}

func TestFailedOrCancelledLoginPreservesExistingLogin(t *testing.T) {
	tests := []struct {
		name, input string
		api         fakeLoginAPI
		wantError   bool
	}{
		{name: "cancel-email", input: ""},
		{name: "cancel-code", input: "user@example.com\n"},
		{name: "send-failed", input: "user@example.com\n", api: fakeLoginAPI{sendError: &auth.APIError{StatusCode: 429, Code: "LOGIN_CODE_TOO_FREQUENT"}}, wantError: true},
		{name: "login-failed", input: "user@example.com\n001234\n", api: fakeLoginAPI{loginError: &auth.APIError{StatusCode: 403, Code: "USER_DISABLED"}}, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			server := "https://example.com"
			if err := config.SaveServer(path, server); err != nil {
				t.Fatal(err)
			}
			if err := config.SaveLogin(path, server, cliLoginFixture(), time.Now()); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			var output bytes.Buffer
			err := loginWithClient(strings.NewReader(test.input), &output, path, server, &test.api, time.Now, nil)
			if (err != nil) != test.wantError {
				t.Fatal("incorrect cancellation/error behavior")
			}
			after, _ := os.ReadFile(path)
			if string(before) != string(after) {
				t.Fatal("failed or cancelled login changed existing credentials")
			}
		})
	}
}

func TestLoginRequiresServerBeforePrompting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	var output bytes.Buffer
	if err := Run([]string{"login"}, strings.NewReader("user@example.com\n"), &output, path); err == nil {
		t.Fatal("login without a configured server was allowed")
	}
	if output.Len() != 0 {
		t.Fatal("login prompted before checking the server")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("login without a server created configuration")
	}
}

func TestLoginDisplaysLogPathAndRecordsSave(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	server := "https://example.com"
	if err := config.SaveServer(path, server); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	log, err := diagnostic.Open(t.TempDir(), &output)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	if err := loginWithClient(strings.NewReader("user@example.com\n001234\n"), &output, path, server, &fakeLoginAPI{}, time.Now, log); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "诊断日志："+log.Path()) {
		t.Fatal("log path was not displayed")
	}
	data, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{`"event":"config_saved"`, `"event":"login_finished"`, `"outcome":"success"`} {
		if !strings.Contains(string(data), expected) {
			t.Fatal("successful save or final login outcome was not recorded")
		}
	}
	for _, secret := range []string{"user@example.com", "001234", "fixture-access-token"} {
		if strings.Contains(string(data), secret) {
			t.Fatal("CLI diagnostics contain login credentials")
		}
	}
}
