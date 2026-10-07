package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"web2term/agent/internal/config"
	"web2term/agent/internal/diagnostic"
)

func settingsFixture() config.AgentSettings {
	return config.AgentSettings{ServerURL: "https://example.com/backend", DeviceID: "f2a5ddcc-43a8-4d91-b956-75d00e4e3112", DeviceName: "fixture-host", Login: config.LoginInfo{AccessToken: "fixture-private-token", ExpiresAt: time.Now().Add(time.Hour)}}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func TestWebSocketURL(t *testing.T) {
	for _, test := range []struct{ server, want string }{
		{"https://example.com/backend/", "wss://example.com/backend/ws/agent"},
		{"http://127.0.0.1:8080", "ws://127.0.0.1:8080/ws/agent"},
		{"http://[::1]:8080/app", "ws://[::1]:8080/app/ws/agent"},
	} {
		got, err := WebSocketURL(test.server)
		if err != nil || got != test.want {
			t.Fatal("incorrect agent WebSocket URL")
		}
	}
}

func TestHandshakeHeadersRedirectAndErrorPrivacy(t *testing.T) {
	for _, status := range []int{401, 403, 307, 503} {
		client := HTTPClient()
		if client.Timeout != 0 {
			t.Fatal("upgraded connection has a total HTTP timeout")
		}
		calls := 0
		client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
			calls++
			if request.Method != "GET" || request.URL.Path != "/backend/ws/agent" || request.Header.Get("Authorization") != "Bearer fixture-private-token" || request.Header.Get("X-Device-Id") != settingsFixture().DeviceID || request.Header.Get("X-Device-Name") != "fixture-host" {
				t.Fatal("agent handshake does not match backend contract")
			}
			headers := http.Header{"Location": []string{"https://other.example.invalid/ws/agent"}}
			return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader("fixture-private-response"))}, nil
		})
		conn, failure := DialWithClient(client)(context.Background(), settingsFixture())
		if conn != nil || failure == nil || failure.Status != status || calls != 1 {
			t.Fatal("handshake status was lost or redirect followed")
		}
		if failure.Retry != (status == 503) {
			t.Fatal("authentication failures and server failures have incorrect retry policies")
		}
		encoded, _ := json.Marshal(diagnostic.DescribeError(failure))
		if strings.Contains(failure.Error(), "fixture-private") || strings.Contains(string(encoded), "fixture-private") {
			t.Fatal("handshake error exposes credentials or body")
		}
	}
}

type fakeMessage struct {
	data []byte
	err  error
}
type fakeConnection struct {
	messages chan fakeMessage
	closed   chan struct{}
	onWrite  func(int)
	count    int
	graceful bool
	once     sync.Once
	t        *testing.T
}

func newFakeConnection(t *testing.T) *fakeConnection {
	return &fakeConnection{messages: make(chan fakeMessage, 4), closed: make(chan struct{}), t: t}
}
func (conn *fakeConnection) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	select {
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	case <-conn.closed:
		return 0, nil, io.EOF
	case message := <-conn.messages:
		return websocket.MessageText, message.data, message.err
	}
}
func (conn *fakeConnection) Write(_ context.Context, typ websocket.MessageType, data []byte) error {
	var message struct {
		Type string `json:"type"`
	}
	if typ != websocket.MessageText || json.Unmarshal(data, &message) != nil {
		return errors.New("incorrect heartbeat protocol")
	}
	if message.Type == "agent_hello" {
		return nil
	}
	if string(data) != `{"type":"heartbeat"}` {
		return errors.New("incorrect heartbeat protocol")
	}
	conn.count++
	if conn.onWrite != nil {
		conn.onWrite(conn.count)
	}
	return nil
}
func (conn *fakeConnection) Close(websocket.StatusCode, string) error {
	conn.graceful = true
	return conn.CloseNow()
}
func (conn *fakeConnection) CloseNow() error { conn.once.Do(func() { close(conn.closed) }); return nil }

func testRunner(output io.Writer) *Runner {
	runner := New(output, nil)
	runner.Jitter = func(delay time.Duration) time.Duration { return delay }
	runner.Options.HeartbeatInterval = time.Millisecond
	runner.Options.AckTimeout = 100 * time.Millisecond
	return runner
}

func TestImmediateHeartbeatRepeatedAckAndGracefulStop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := newFakeConnection(t)
	conn.onWrite = func(count int) {
		if count == 2 {
			cancel()
			return
		}
		conn.messages <- fakeMessage{data: []byte(`{"type":"heartbeat_ack"}`)}
	}
	var output bytes.Buffer
	log, err := diagnostic.OpenRun(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	runner := testRunner(&output)
	runner.Log = log
	var states []string
	runner.OnState = func(state, _ string) { states = append(states, state) }
	runner.Dial = func(context.Context, config.AgentSettings) (Connection, *Failure) { return conn, nil }
	if err := runner.Run(ctx, settingsFixture()); err != nil {
		t.Fatal(err)
	}
	if conn.count != 2 || !conn.graceful || !strings.Contains(output.String(), "设备已在线") {
		t.Fatal("heartbeat or graceful shutdown did not complete")
	}
	if len(states) != 2 || states[0] != "connecting" || states[1] != "online" {
		t.Fatal("online status was not driven by confirmed heartbeat")
	}
	data, _ := os.ReadFile(log.Path())
	if !strings.Contains(string(data), `"event":"heartbeat_ack"`) || strings.Contains(string(data), "fixture-private-token") {
		t.Fatal("ack log is missing or exposes credentials")
	}
}

func TestTransientHandshakeRetriesThenAuthenticationStops(t *testing.T) {
	runner := testRunner(io.Discard)
	calls, sleeps := 0, 0
	runner.Dial = func(_ context.Context, settings config.AgentSettings) (Connection, *Failure) {
		calls++
		if settings.DeviceID != settingsFixture().DeviceID {
			t.Fatal("reconnect changed device identity")
		}
		if calls < 3 {
			return nil, handshakeFailure(503, errors.New("fixture-private-response"))
		}
		return nil, handshakeFailure(401, errors.New("fixture-private-response"))
	}
	runner.Sleep = func(_ context.Context, wait time.Duration) error {
		sleeps++
		if wait != time.Duration(sleeps)*time.Second {
			t.Fatal("incorrect exponential retry delay")
		}
		return nil
	}
	if err := runner.Run(context.Background(), settingsFixture()); err == nil || calls != 3 || sleeps != 2 {
		t.Fatal("retry/authentication stop policy failed")
	}
}

func TestReplacedConnectionStopsWithoutReconnect(t *testing.T) {
	conn := newFakeConnection(t)
	conn.onWrite = func(int) {
		conn.messages <- fakeMessage{err: websocket.CloseError{Code: websocket.StatusNormalClosure, Reason: "fixture-private-reason"}}
	}
	runner := testRunner(io.Discard)
	calls := 0
	runner.Dial = func(context.Context, config.AgentSettings) (Connection, *Failure) { calls++; return conn, nil }
	if err := runner.Run(context.Background(), settingsFixture()); err == nil || calls != 1 || strings.Contains(err.Error(), "fixture-private") {
		t.Fatal("replaced connection retried or leaked close reason")
	}
}

func TestMissingHeartbeatAckReconnectsAndReleasesReader(t *testing.T) {
	conn := newFakeConnection(t)
	runner := testRunner(io.Discard)
	runner.Options.AckTimeout = time.Millisecond
	calls := 0
	runner.Dial = func(context.Context, config.AgentSettings) (Connection, *Failure) {
		calls++
		if calls == 1 {
			return conn, nil
		}
		return nil, handshakeFailure(403, errors.New("denied"))
	}
	runner.Sleep = func(context.Context, time.Duration) error { return nil }
	if err := runner.Run(context.Background(), settingsFixture()); err == nil || calls != 2 || conn.count != 1 {
		t.Fatal("missing ack did not reconnect")
	}
	select {
	case <-conn.closed:
	default:
		t.Fatal("timed out connection was not closed")
	}
}

func TestExpiredTokenPreventsDial(t *testing.T) {
	settings := settingsFixture()
	settings.Login.ExpiresAt = time.Now().Add(-time.Second)
	runner := testRunner(io.Discard)
	runner.Dial = func(context.Context, config.AgentSettings) (Connection, *Failure) {
		t.Fatal("expired login attempted a network connection")
		return nil, nil
	}
	if err := runner.Run(context.Background(), settings); err == nil {
		t.Fatal("expired login was accepted")
	}
}

func TestReconnectBackoffIsCappedAndResetsAfterConfirmedHeartbeat(t *testing.T) {
	conn := newFakeConnection(t)
	conn.onWrite = func(count int) {
		if count == 1 {
			conn.messages <- fakeMessage{data: []byte(`{"type":"heartbeat_ack"}`)}
		} else {
			conn.messages <- fakeMessage{err: io.EOF}
		}
	}
	runner := testRunner(io.Discard)
	calls := 0
	runner.Dial = func(context.Context, config.AgentSettings) (Connection, *Failure) {
		calls++
		if calls == 3 {
			return conn, nil
		}
		if calls == 10 {
			return nil, handshakeFailure(401, errors.New("denied"))
		}
		return nil, handshakeFailure(503, errors.New("unavailable"))
	}
	var delays []time.Duration
	runner.Sleep = func(_ context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		return nil
	}
	if err := runner.Run(context.Background(), settingsFixture()); err == nil {
		t.Fatal("authentication rejection did not stop reconnecting")
	}
	want := []time.Duration{time.Second, 2 * time.Second, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	if len(delays) != len(want) {
		t.Fatal("unexpected reconnect attempts")
	}
	for index, delay := range delays {
		if delay != want[index] {
			t.Fatal("backoff cap or reset after heartbeat acknowledgement failed")
		}
	}
}
