package auth

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/mail"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
	"unicode"

	"web2term/agent/internal/diagnostic"
)

const maxResponseBytes = 1 << 20

type User struct {
	PublicID  string  `json:"publicId"`
	Email     string  `json:"email"`
	Nickname  string  `json:"nickname"`
	AvatarURL *string `json:"avatarUrl"`
	Role      string  `json:"role"`
}

type LoginResponse struct {
	AccessToken      string `json:"accessToken"`
	TokenType        string `json:"tokenType"`
	ExpiresInSeconds int64  `json:"expiresInSeconds"`
	User             User   `json:"user"`
}

// Error messages are fixed locally: never echo backend bodies or credentials.
type APIError struct {
	StatusCode int
	Code       string
}

func (err *APIError) Error() string {
	messages := map[string]string{
		"INVALID_REQUEST":         "请求参数不完整",
		"INVALID_EMAIL":           "邮箱格式不正确",
		"LOGIN_CODE_TOO_FREQUENT": "验证码发送过于频繁，请稍后重试",
		"LOGIN_CODE_SEND_FAILED":  "验证码邮件发送失败，请稍后重试",
		"INVALID_LOGIN_CODE":      "验证码必须是 6 位数字",
		"LOGIN_CODE_INCORRECT":    "验证码错误或已失效",
		"USER_NOT_AVAILABLE":      "用户不存在或不可用",
		"USER_DISABLED":           "用户已被禁用",
	}
	if message, ok := messages[err.Code]; ok {
		return fmt.Sprintf("%s（HTTP %d，%s）", message, err.StatusCode, err.Code)
	}
	if err.StatusCode >= 300 && err.StatusCode < 400 {
		return "后端返回了重定向，请通过 web2term set server 配置正确的后端基础地址"
	}
	return fmt.Sprintf("后端请求失败（HTTP %d）", err.StatusCode)
}

func NormalizeEmail(value string) (string, error) {
	value = strings.TrimSpace(value)
	address, err := mail.ParseAddress(value)
	if err != nil || address.Address != value || address.Name != "" || strings.ContainsFunc(value, unicode.IsControl) {
		return "", errors.New("请填写有效的邮箱地址，例如 user@example.com")
	}
	return value, nil
}

func NormalizeCode(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) != 6 {
		return "", errors.New("验证码必须是 6 位数字")
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return "", errors.New("验证码必须是 6 位数字")
		}
	}
	return value, nil
}

func (result LoginResponse) Validate() error {
	invalid := errors.New("登录响应缺少有效的 Token、有效期或用户信息，原登录信息未修改")
	if result.AccessToken == "" || strings.ContainsFunc(result.AccessToken, func(r rune) bool {
		return r <= ' ' || r >= 127
	}) || result.TokenType != "Bearer" {
		return invalid
	}
	// Keep conversion to time.Duration safe without imposing an arbitrary token TTL.
	if result.ExpiresInSeconds <= 0 || result.ExpiresInSeconds > int64((1<<63-1)/time.Second) {
		return invalid
	}
	if strings.TrimSpace(result.User.PublicID) == "" || strings.ContainsFunc(result.User.PublicID, unicode.IsControl) || strings.TrimSpace(result.User.Role) == "" {
		return invalid
	}
	if _, err := NormalizeEmail(result.User.Email); err != nil {
		return invalid
	}
	return nil
}

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
	log        *diagnostic.Log
	requestID  atomic.Uint64
}

// SetLogger must be called before making requests.
func (client *Client) SetLogger(log *diagnostic.Log) {
	client.log = log
}

func NewClient(server string) (*Client, error) {
	base, err := url.Parse(server)
	if err != nil || base.Hostname() == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("后端地址无效，请先运行 web2term set server")
	}
	return &Client{
		baseURL: base,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			// A 307/308 redirect could forward the email and one-time code elsewhere.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

func (client *Client) SendCode(ctx context.Context, email string) error {
	email, err := NormalizeEmail(email)
	if err != nil {
		return err
	}
	status, data, err := client.post(ctx, "api/user/login/code", struct {
		Email string `json:"email"`
	}{Email: email})
	if err != nil {
		return err
	}
	if status != http.StatusNoContent {
		client.recordAPIError("send_code", status, data)
		return responseError(status, data)
	}
	return nil
}

func (client *Client) Login(ctx context.Context, email, code string) (LoginResponse, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return LoginResponse{}, err
	}
	code, err = NormalizeCode(code)
	if err != nil {
		return LoginResponse{}, err
	}
	status, data, err := client.post(ctx, "api/user/login", struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}{Email: email, Code: code})
	if err != nil {
		return LoginResponse{}, err
	}
	if status != http.StatusOK {
		client.recordAPIError("login", status, data)
		return LoginResponse{}, responseError(status, data)
	}
	var result LoginResponse
	if err := json.Unmarshal(data, &result); err != nil {
		client.log.Record(diagnostic.Entry{Event: "response_invalid_json", Phase: "login", Error: diagnostic.DescribeError(err)})
		return LoginResponse{}, errors.New("后端登录响应不是预期的 JSON，原登录信息未修改")
	}
	if err := result.Validate(); err != nil {
		client.log.Record(diagnostic.Entry{Event: "response_invalid_fields", Phase: "login"})
		return LoginResponse{}, err
	}
	if !strings.EqualFold(result.User.Email, email) {
		client.log.Record(diagnostic.Entry{Event: "response_account_mismatch", Phase: "login"})
		return LoginResponse{}, errors.New("登录响应的用户邮箱与本次登录不一致，原登录信息未修改")
	}
	client.log.Record(diagnostic.Entry{Event: "login_response_valid", Phase: "login"})
	return result, nil
}

func (client *Client) post(ctx context.Context, endpoint string, payload any) (int, []byte, error) {
	phase := "login"
	if endpoint == "api/user/login/code" {
		phase = "send_code"
	}
	started := time.Now()
	id := client.requestID.Add(1)
	record := func(entry diagnostic.Entry) {
		entry.Phase, entry.RequestID = phase, id
		entry.ElapsedMS = time.Since(started).Milliseconds()
		client.log.Record(entry)
	}
	data, err := json.Marshal(payload)
	if err != nil {
		record(diagnostic.Entry{Event: "request_build_failed", Error: diagnostic.DescribeError(err)})
		return 0, nil, errors.New("无法生成登录请求")
	}
	address := client.baseURL.JoinPath(endpoint).String()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, address, bytes.NewReader(data))
	if err != nil {
		record(diagnostic.Entry{Event: "request_build_failed", Error: diagnostic.DescribeError(err)})
		return 0, nil, errors.New("无法创建登录请求，请检查后端地址")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	// Log the configured request URL without credentials, query, or fragment.
	safeURL := &url.URL{Scheme: request.URL.Scheme, Host: request.URL.Host, Path: request.URL.Path}
	proxy := "direct"
	transport := client.httpClient.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	if transport, ok := transport.(*http.Transport); ok && transport.Proxy != nil {
		proxyURL, proxyErr := transport.Proxy(request)
		if proxyErr != nil {
			proxy = "configuration_error"
		} else if proxyURL != nil {
			proxy = (&url.URL{Scheme: proxyURL.Scheme, Host: proxyURL.Host}).String()
		}
	}
	record(diagnostic.Entry{Event: "request_started", Method: request.Method, URL: safeURL.String(), Proxy: proxy, TimeoutMS: client.httpClient.Timeout.Milliseconds()})
	if client.log != nil {
		trace := &httptrace.ClientTrace{
			DNSStart: func(httptrace.DNSStartInfo) { record(diagnostic.Entry{Event: "dns_started"}) },
			DNSDone: func(info httptrace.DNSDoneInfo) {
				record(diagnostic.Entry{Event: "dns_finished", Addresses: len(info.Addrs), Error: diagnostic.DescribeError(info.Err)})
			},
			ConnectStart: func(network, address string) {
				record(diagnostic.Entry{Event: "connect_started", Network: network, Peer: address})
			},
			ConnectDone: func(network, address string, err error) {
				record(diagnostic.Entry{Event: "connect_finished", Network: network, Peer: address, Error: diagnostic.DescribeError(err)})
			},
			TLSHandshakeStart: func() { record(diagnostic.Entry{Event: "tls_started"}) },
			TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
				record(diagnostic.Entry{Event: "tls_finished", Error: diagnostic.DescribeError(err)})
			},
			GotConn: func(info httptrace.GotConnInfo) {
				record(diagnostic.Entry{Event: "connection_acquired", Peer: info.Conn.RemoteAddr().String(), Reused: &info.Reused})
			},
			WroteRequest: func(info httptrace.WroteRequestInfo) {
				record(diagnostic.Entry{Event: "request_sent", Error: diagnostic.DescribeError(info.Err)})
			},
			GotFirstResponseByte: func() { record(diagnostic.Entry{Event: "response_started"}) },
		}
		request = request.WithContext(httptrace.WithClientTrace(request.Context(), trace))
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		failure := diagnostic.DescribeError(err)
		record(diagnostic.Entry{Event: "request_failed", Error: failure})
		if failure.Kind == "unclassified" {
			return 0, nil, errors.New("HTTP 请求失败，请查看诊断日志中的错误类型")
		}
		return 0, nil, fmt.Errorf("HTTP 请求失败：%s", failure.Detail)
	}
	defer response.Body.Close()
	record(diagnostic.Entry{Event: "response_headers", Status: response.StatusCode, Protocol: response.Proto})
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		failure := diagnostic.DescribeError(err)
		record(diagnostic.Entry{Event: "response_read_failed", Status: response.StatusCode, Bytes: len(body), Error: failure})
		return 0, nil, fmt.Errorf("读取后端响应失败：%s，原登录信息未修改", failure.Detail)
	}
	if len(body) > maxResponseBytes {
		record(diagnostic.Entry{Event: "response_too_large", Status: response.StatusCode, Bytes: len(body)})
		return 0, nil, errors.New("后端响应超过允许大小，原登录信息未修改")
	}
	record(diagnostic.Entry{Event: "request_finished", Status: response.StatusCode, Bytes: len(body)})
	return response.StatusCode, body, nil
}

func (client *Client) recordAPIError(phase string, status int, data []byte) {
	apiError := responseError(status, data)
	code := "UNKNOWN"
	switch apiError.Code {
	case "INVALID_REQUEST", "INVALID_EMAIL", "LOGIN_CODE_TOO_FREQUENT", "LOGIN_CODE_SEND_FAILED", "INVALID_LOGIN_CODE", "LOGIN_CODE_INCORRECT", "USER_NOT_AVAILABLE", "USER_DISABLED":
		code = apiError.Code
	}
	client.log.Record(diagnostic.Entry{Event: "api_error", Phase: phase, Status: status, Code: code})
}

func responseError(status int, data []byte) *APIError {
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(data, &body)
	return &APIError{StatusCode: status, Code: body.Code}
}
