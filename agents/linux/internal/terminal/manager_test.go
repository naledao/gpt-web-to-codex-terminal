package terminal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"web2term/agent/internal/diagnostic"
)

// All normal tests use memory pipes; they never start a Shell or open a PTY.
type fakeProcess struct {
	reader       *io.PipeReader
	output       *io.PipeWriter
	written      chan []byte
	resized      chan Size
	exit         chan Exit
	finished     sync.Once
	writeGate    <-chan struct{}
	writeStarted chan struct{}
}

func newFakeProcess() *fakeProcess {
	r, w := io.Pipe()
	return &fakeProcess{reader: r, output: w, written: make(chan []byte, 32), resized: make(chan Size, 8), exit: make(chan Exit, 1)}
}
func (p *fakeProcess) Read(data []byte) (int, error) { return p.reader.Read(data) }
func (p *fakeProcess) Write(data []byte) (int, error) {
	if p.writeGate != nil {
		select {
		case p.writeStarted <- struct{}{}:
		default:
		}
		<-p.writeGate
	}
	p.written <- append([]byte(nil), data...)
	return len(data), nil
}
func (p *fakeProcess) Resize(size Size) error { p.resized <- size; return nil }
func (p *fakeProcess) Close() error           { return p.reader.Close() }
func (p *fakeProcess) Shell() string          { return "/fixture/sh" }
func (p *fakeProcess) Wait() (Exit, error)    { return <-p.exit, nil }
func (p *fakeProcess) finish(exit Exit) {
	p.finished.Do(func() { _ = p.output.Close(); p.exit <- exit })
}
func (p *fakeProcess) Terminate() error {
	p.finish(Exit{ExitCode: -1, Signal: "terminated"})
	return nil
}
func (p *fakeProcess) Kill() error { return p.Terminate() }

type recorder struct{ messages chan Message }

func newRecorder() *recorder { return &recorder{messages: make(chan Message, 256)} }
func (r *recorder) send(ctx context.Context, m Message, _ bool) error {
	select {
	case r.messages <- m:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func receive[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for fake terminal")
		var zero T
		return zero
	}
}
func (r *recorder) await(t *testing.T, kind, id string) Message {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m := <-r.messages:
			if m.Type == kind && m.SessionID == id {
				return m
			}
		case <-deadline:
			t.Fatalf("missing %s for %s", kind, id)
			return Message{}
		}
	}
}
func sessionID(n int) string { return fmt.Sprintf("550e8400-e29b-41d4-a716-%012d", n) }
func request(kind, id string, value any) Envelope {
	raw, _ := json.Marshal(value)
	return Envelope{Version: Version, Type: kind, SessionID: id, Payload: raw}
}
func expectCode(t *testing.T, m Message, code string) {
	t.Helper()
	if m.Type != "terminal_error" || m.Payload.(Error).Code != code {
		t.Fatalf("expected %s, got %#v", code, m)
	}
}

func TestLimitIncludesOpeningAndClosingSessions(t *testing.T) {
	r := newRecorder()
	m := New(context.Background(), r.send, nil)
	gate := make(chan struct{})
	entered := make(chan struct{}, 3)
	var calls atomic.Int32
	m.Factory = func(Size) (Process, error) { calls.Add(1); entered <- struct{}{}; <-gate; return newFakeProcess(), nil }
	for n := 1; n <= 3; n++ {
		m.Handle(request("terminal_open", sessionID(n), Size{Cols: 80, Rows: 24}))
	}
	for n := 0; n < 3; n++ {
		receive(t, entered)
	}
	m.Handle(request("terminal_open", sessionID(4), Size{}))
	expectCode(t, receive(t, r.messages), "TERMINAL_LIMIT_REACHED")
	m.Handle(request("terminal_open", sessionID(1), Size{}))
	expectCode(t, receive(t, r.messages), "SESSION_EXISTS")
	m.Handle(request("terminal_close", sessionID(1), struct{}{}))
	m.Handle(request("terminal_open", sessionID(4), Size{}))
	expectCode(t, receive(t, r.messages), "TERMINAL_LIMIT_REACHED")
	if m.Count() != 3 || calls.Load() != 3 {
		t.Fatal("opening/closing session did not occupy a slot")
	}
	close(gate)
	defer m.Close()
	r.await(t, "terminal_exit", sessionID(1))
	if m.Count() != 2 {
		t.Fatal("closed session was not released before exit notification")
	}
	m.Handle(request("terminal_open", sessionID(1), Size{}))
	expectCode(t, r.await(t, "terminal_error", sessionID(1)), "SESSION_CLOSED")
	m.Handle(request("terminal_open", sessionID(4), Size{}))
	r.await(t, "terminal_ready", sessionID(4))
	if calls.Load() != 4 || m.Count() != 3 {
		t.Fatal("a new session could not use the released slot")
	}
}

func TestIndependentInputResizeOutputAndExitOrdering(t *testing.T) {
	r := newRecorder()
	m := New(context.Background(), r.send, nil)
	defer m.Close()
	created := make(chan *fakeProcess, 2)
	m.Factory = func(Size) (Process, error) { p := newFakeProcess(); created <- p; return p, nil }
	m.Handle(request("terminal_open", sessionID(1), Size{}))
	first := receive(t, created)
	ready := r.await(t, "terminal_ready", sessionID(1)).Payload.(Ready)
	if ready.Cols != DefaultCols || ready.Rows != DefaultRows {
		t.Fatal("default dimensions lost")
	}
	m.Handle(request("terminal_open", sessionID(2), Size{Cols: 80, Rows: 24}))
	second := receive(t, created)
	r.await(t, "terminal_ready", sessionID(2))
	input := []byte{'a', 3, 0, 0xff, '\r'} // Ctrl+C and arbitrary bytes are forwarded unchanged.
	m.Handle(request("terminal_input", sessionID(1), Data{Data: base64.StdEncoding.EncodeToString(input)}))
	if !bytes.Equal(receive(t, first.written), input) {
		t.Fatal("input bytes were altered")
	}
	select {
	case <-second.written:
		t.Fatal("input crossed into another session")
	default:
	}
	want := Size{Cols: 132, Rows: 43}
	m.Handle(request("terminal_resize", sessionID(2), want))
	if receive(t, second.resized) != want {
		t.Fatal("wrong terminal resized")
	}
	if r.await(t, "terminal_resized", sessionID(2)).Payload.(Size) != want {
		t.Fatal("resize acknowledgement differs")
	}
	output := []byte("private-fixture-output\x1b[31m\xff")
	go func() { _, _ = first.output.Write(output); first.finish(Exit{ExitCode: 7}) }()
	var got []byte
	for {
		message := receive(t, r.messages)
		if message.SessionID != sessionID(1) {
			continue
		}
		if message.Type == "terminal_output" {
			chunk, err := base64.StdEncoding.DecodeString(message.Payload.(Data).Data)
			if err != nil {
				t.Fatal(err)
			}
			got = append(got, chunk...)
		} else if message.Type == "terminal_exit" {
			exit := message.Payload.(Exit)
			if exit.ExitCode != 7 || exit.Reason != "shell_exit" || !bytes.Equal(got, output) {
				t.Fatal("exit overtook output or lost exit status")
			}
			break
		}
	}
	if m.Count() != 1 {
		t.Fatal("exiting one terminal affected other sessions")
	}
}

func TestStartupFailureAndConnectionCloseReleaseAllSessions(t *testing.T) {
	r := newRecorder()
	m := New(context.Background(), r.send, nil)
	m.Factory = func(Size) (Process, error) { return nil, errors.New("private-fixture-error") }
	m.Handle(request("terminal_open", sessionID(1), Size{}))
	expectCode(t, r.await(t, "terminal_error", sessionID(1)), "TERMINAL_START_FAILED")
	if m.Count() != 0 {
		t.Fatal("failed start leaked a slot")
	}
	created := make(chan *fakeProcess, 3)
	m.Factory = func(Size) (Process, error) { p := newFakeProcess(); created <- p; return p, nil }
	for n := 2; n <= 4; n++ {
		m.Handle(request("terminal_open", sessionID(n), Size{}))
	}
	for n := 0; n < 3; n++ {
		receive(t, created)
	}
	m.Close()
	if m.Count() != 0 {
		t.Fatal("disconnect left live sessions")
	}
}

func TestInvalidMessagesCannotCreateShells(t *testing.T) {
	cases := []struct {
		message Envelope
		code    string
	}{
		{request("terminal_open", "not-a-uuid", Size{}), "INVALID_SESSION_ID"},
		{Envelope{Version: 2, Type: "terminal_open", SessionID: sessionID(1), Payload: json.RawMessage(`{}`)}, "UNSUPPORTED_VERSION"},
		{request("terminal_open", sessionID(1), map[string]any{"command": "bad"}), "INVALID_PAYLOAD"},
		{request("terminal_open", sessionID(1), Size{Cols: -1, Rows: 24}), "INVALID_SIZE"},
		{request("terminal_resize", sessionID(1), Size{}), "INVALID_SIZE"},
		{request("terminal_input", sessionID(1), map[string]any{}), "INVALID_PAYLOAD"},
		{request("terminal_input", sessionID(1), map[string]any{"data": nil}), "INVALID_PAYLOAD"},
		{request("terminal_input", sessionID(1), Data{Data: "%%%"}), "INVALID_INPUT"},
		{request("terminal_input", sessionID(1), Data{Data: base64.StdEncoding.EncodeToString(make([]byte, MaxDataBytes+1))}), "INVALID_INPUT"},
		{request("terminal_execute", sessionID(1), struct{}{}), "UNSUPPORTED_MESSAGE"},
	}
	for _, test := range cases {
		t.Run(test.code, func(t *testing.T) {
			r := newRecorder()
			m := New(context.Background(), r.send, nil)
			defer m.Close()
			m.Factory = func(Size) (Process, error) {
				t.Error("invalid message started a process")
				return nil, errors.New("unexpected")
			}
			m.Handle(test.message)
			expectCode(t, receive(t, r.messages), test.code)
		})
	}
}

func TestInputBackpressureClosesOnlyAffectedTerminal(t *testing.T) {
	r := newRecorder()
	m := New(context.Background(), r.send, nil)
	gate := make(chan struct{})
	p := newFakeProcess()
	p.writeGate = gate
	p.writeStarted = make(chan struct{}, 1)
	var calls atomic.Int32
	m.Factory = func(Size) (Process, error) {
		if calls.Add(1) == 1 {
			return p, nil
		}
		return newFakeProcess(), nil
	}
	m.Handle(request("terminal_open", sessionID(1), Size{}))
	r.await(t, "terminal_ready", sessionID(1))
	m.Handle(request("terminal_open", sessionID(2), Size{}))
	r.await(t, "terminal_ready", sessionID(2))
	input := request("terminal_input", sessionID(1), Data{Data: "eA=="})
	m.Handle(input)
	receive(t, p.writeStarted)
	for n := 0; n < 17; n++ {
		m.Handle(input)
	}
	expectCode(t, r.await(t, "terminal_error", sessionID(1)), "INPUT_BACKPRESSURE")
	close(gate)
	defer m.Close()
	if r.await(t, "terminal_exit", sessionID(1)).Payload.(Exit).Reason != "input_backpressure" {
		t.Fatal("wrong close reason")
	}
	if m.Count() != 1 {
		t.Fatal("backpressure affected an unrelated terminal")
	}
}

func TestTerminalLogsOmitInputOutputAndRawErrors(t *testing.T) {
	log, err := diagnostic.OpenRun(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	r := newRecorder()
	m := New(context.Background(), r.send, log)
	p := newFakeProcess()
	m.Factory = func(Size) (Process, error) { return nil, errors.New("private-start-error-secret") }
	m.Handle(request("terminal_open", sessionID(10), Size{}))
	expectCode(t, r.await(t, "terminal_error", sessionID(10)), "TERMINAL_START_FAILED")
	m.Factory = func(Size) (Process, error) { return p, nil }
	m.Handle(request("terminal_open", sessionID(1), Size{}))
	r.await(t, "terminal_ready", sessionID(1))
	input := "private-command-secret"
	m.Handle(request("terminal_input", sessionID(1), Data{Data: base64.StdEncoding.EncodeToString([]byte(input))}))
	receive(t, p.written)
	go func() { _, _ = p.output.Write([]byte("private-output-secret")); p.finish(Exit{}) }()
	r.await(t, "terminal_exit", sessionID(1))
	m.Close()
	data, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "private-") || strings.Contains(string(data), base64.StdEncoding.EncodeToString([]byte(input))) || !strings.Contains(string(data), sessionID(1)) {
		t.Fatal("log leaked terminal data or omitted session metadata")
	}
}
