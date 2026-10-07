package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"os"
	"strings"
	"testing"

	"web2term/agent/internal/diagnostic"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func fakeResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func validResponse() LoginResponse {
	avatar := "https://cdn.example.invalid/avatar.png"
	return LoginResponse{
		AccessToken: "fixture-access-token", TokenType: "Bearer", ExpiresInSeconds: 86400,
		User: User{PublicID: "usr_fixture", Email: "user@example.com", Nickname: "fixture", AvatarURL: &avatar, Role: "USER"},
	}
}

func TestLoginAPIContractAndContextPath(t *testing.T) {
	client, err := NewClient("https://backend.example.invalid/backend/")
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	client.httpClient.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Method != http.MethodPost || request.Header.Get("Content-Type") != "application/json" || request.Header.Get("Authorization") != "" {
			t.Fatal("unexpected request method or authentication headers")
		}
		var payload map[string]string
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal("invalid JSON request")
		}
		if payload["email"] != "user@example.com" {
			t.Fatal("unexpected email in request")
		}
		switch requests {
		case 1:
			if request.URL.Path != "/backend/api/user/login/code" || len(payload) != 1 {
				t.Fatal("incorrect verification-code endpoint or fields")
			}
			return fakeResponse(204, ""), nil
		case 2:
			if request.URL.Path != "/backend/api/user/login" || payload["code"] != "001234" || len(payload) != 2 {
				t.Fatal("incorrect login endpoint or code serialization")
			}
			body, _ := json.Marshal(validResponse())
			return fakeResponse(200, string(body)), nil
		default:
			t.Fatal("unexpected automatic retry")
			return nil, errors.New("unexpected request")
		}
	})
	if err := client.SendCode(context.Background(), "user@example.com"); err != nil {
		t.Fatal(err)
	}
	result, err := client.Login(context.Background(), "user@example.com", "001234")
	if err != nil || result.User.PublicID != "usr_fixture" || result.ExpiresInSeconds != 86400 || result.User.AvatarURL == nil {
		t.Fatal("documented login response was not decoded correctly")
	}
	if requests != 2 {
		t.Fatal("incorrect request count")
	}
}

func TestAPIErrorDoesNotExposeResponseBody(t *testing.T) {
	client, _ := NewClient("https://backend.example.invalid")
	client.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return fakeResponse(429, `{"code":"LOGIN_CODE_TOO_FREQUENT","message":"fixture-sensitive-body"}`), nil
	})
	err := client.SendCode(context.Background(), "user@example.com")
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.StatusCode != 429 || apiError.Code != "LOGIN_CODE_TOO_FREQUENT" {
		t.Fatal("documented API error was not classified")
	}
	if strings.Contains(err.Error(), "fixture-sensitive-body") {
		t.Fatal("backend response body leaked into an error")
	}
}

func TestLoginDoesNotFollowRedirect(t *testing.T) {
	client, _ := NewClient("https://backend.example.invalid")
	requests := 0
	client.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		requests++
		response := fakeResponse(307, "")
		response.Header.Set("Location", "https://other.example.invalid/login")
		return response, nil
	})
	if _, err := client.Login(context.Background(), "user@example.com", "001234"); err == nil || requests != 1 {
		t.Fatal("login redirect was accepted or followed")
	}
}

func TestInvalidLoginResponsesAreRejected(t *testing.T) {
	for _, kind := range []string{"missing-token", "invalid-ttl", "overflow-ttl", "wrong-account", "invalid-json", "oversized-body"} {
		t.Run(kind, func(t *testing.T) {
			result := validResponse()
			switch kind {
			case "missing-token":
				result.AccessToken = ""
			case "invalid-ttl":
				result.ExpiresInSeconds = 0
			case "overflow-ttl":
				result.ExpiresInSeconds = 1 << 62
			case "wrong-account":
				result.User.Email = "other@example.com"
			}
			data, _ := json.Marshal(result)
			body := string(data)
			if kind == "invalid-json" {
				body = "not JSON"
			}
			if kind == "oversized-body" {
				body = strings.Repeat("x", maxResponseBytes+1)
			}
			client, _ := NewClient("https://backend.example.invalid")
			client.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return fakeResponse(200, body), nil
			})
			if _, err := client.Login(context.Background(), "user@example.com", "001234"); err == nil {
				t.Fatal("invalid or mismatched login response was accepted")
			}
		})
	}
}

func TestLoginDiagnosticLogCapturesTransportFailureWithoutCredentials(t *testing.T) {
	log, err := diagnostic.Open(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	client, _ := NewClient("http://backend.example.invalid:8080")
	client.SetLogger(log)
	client.httpClient.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		trace := httptrace.ContextClientTrace(request.Context())
		if trace == nil {
			t.Fatal("request has no HTTP diagnostics")
		}
		trace.ConnectStart("tcp", "backend.example.invalid:8080")
		trace.ConnectDone("tcp", "backend.example.invalid:8080", nil)
		trace.WroteRequest(httptrace.WroteRequestInfo{})
		if request.URL.Path == "/api/user/login/code" {
			return fakeResponse(204, ""), nil
		}
		return nil, io.EOF
	})
	if err := client.SendCode(context.Background(), "fixture-secret-email@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Login(context.Background(), "fixture-secret-email@example.com", "001234"); err == nil || !strings.Contains(err.Error(), "EOF") {
		t.Fatal("transport failure was not explained")
	}
	data, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"fixture-secret-email@example.com", "001234", "fixture-access-token"} {
		if strings.Contains(string(data), secret) {
			t.Fatal("diagnostic log contains login credentials")
		}
	}
	var sawCodeSuccess, sawLoginEOF, sawSent bool
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var entry diagnostic.Entry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal("diagnostic record is not JSON")
		}
		if entry.Event == "request_finished" && entry.Phase == "send_code" && entry.Status == 204 && entry.RequestID == 1 {
			sawCodeSuccess = true
		}
		if entry.Event == "request_sent" && entry.RequestID == 2 {
			sawSent = true
		}
		if entry.Event == "request_failed" && entry.Phase == "login" && entry.RequestID == 2 && entry.Error != nil && entry.Error.Kind == "eof" {
			sawLoginEOF = true
		}
	}
	if !sawCodeSuccess || !sawSent || !sawLoginEOF {
		t.Fatal("log does not distinguish code delivery, request sending, and login failure")
	}
}

func TestDiagnosticLogOmitsBodiesAndUntrustedErrorCodes(t *testing.T) {
	for _, mode := range []string{"success", "business-error", "invalid-header"} {
		t.Run(mode, func(t *testing.T) {
			log, err := diagnostic.Open(t.TempDir(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer log.Close()
			client, _ := NewClient("https://backend.example.invalid")
			client.SetLogger(log)
			client.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				switch mode {
				case "success":
					body, _ := json.Marshal(validResponse())
					return fakeResponse(200, string(body)), nil
				case "business-error":
					return fakeResponse(500, `{"code":"fixture-access-token","message":"fixture-private-body"}`), nil
				default:
					return nil, errors.New("malformed MIME header line: fixture-access-token")
				}
			})
			_, loginErr := client.Login(context.Background(), "user@example.com", "001234")
			if (loginErr == nil) != (mode == "success") {
				t.Fatal("unexpected login outcome")
			}
			data, err := os.ReadFile(log.Path())
			if err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{"fixture-access-token", "fixture-private-body", "user@example.com", "001234"} {
				if strings.Contains(string(data), secret) || (loginErr != nil && strings.Contains(loginErr.Error(), secret)) {
					t.Fatal("body, token, code, or email leaked into logs or errors")
				}
			}
			if mode == "business-error" && !strings.Contains(string(data), `"api_code":"UNKNOWN"`) {
				t.Fatal("untrusted backend error code was not redacted")
			}
		})
	}
}
