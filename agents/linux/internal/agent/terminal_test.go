package agent

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"web2term/agent/internal/terminal"
)

// No listener, backend, or native PTY: this exercises the real multiplexing loop.
type terminalConnection struct {
	incoming   chan []byte
	written    chan terminal.Envelope
	closed     chan struct{}
	once       sync.Once
	active     atomic.Int32
	concurrent atomic.Bool
}

func newTerminalConnection() *terminalConnection {
	return &terminalConnection{incoming: make(chan []byte, 32), written: make(chan terminal.Envelope, 256), closed: make(chan struct{})}
}
func (c *terminalConnection) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	select {
	case data := <-c.incoming:
		return websocket.MessageText, data, nil
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	case <-c.closed:
		return 0, nil, io.EOF
	}
}
func (c *terminalConnection) Write(ctx context.Context, _ websocket.MessageType, data []byte) error {
	if c.active.Add(1) != 1 {
		c.concurrent.Store(true)
	}
	defer c.active.Add(-1)
	var message terminal.Envelope
	if err := json.Unmarshal(data, &message); err != nil {
		return err
	}
	select {
	case c.written <- message:
	case <-ctx.Done():
		return ctx.Err()
	}
	if message.Type == "heartbeat" {
		select {
		case c.incoming <- []byte(`{"type":"heartbeat_ack"}`):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
func (c *terminalConnection) Close(websocket.StatusCode, string) error { return c.CloseNow() }
func (c *terminalConnection) CloseNow() error                          { c.once.Do(func() { close(c.closed) }); return nil }
func (c *terminalConnection) request(kind, id string, payload any) {
	data, _ := json.Marshal(terminal.Message{Version: 1, Type: kind, SessionID: id, Payload: payload})
	c.incoming <- data
}
func (c *terminalConnection) await(t *testing.T, kind string) terminal.Envelope {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m := <-c.written:
			if m.Type == kind {
				return m
			}
		case <-deadline:
			t.Fatalf("missing %s", kind)
			return terminal.Envelope{}
		}
	}
}

type terminalProcess struct {
	reader *io.PipeReader
	output *io.PipeWriter
	exit   chan terminal.Exit
	once   sync.Once
}

func newTerminalProcess() *terminalProcess {
	r, w := io.Pipe()
	return &terminalProcess{reader: r, output: w, exit: make(chan terminal.Exit, 1)}
}
func (p *terminalProcess) Read(data []byte) (int, error)  { return p.reader.Read(data) }
func (p *terminalProcess) Write(data []byte) (int, error) { return len(data), nil }
func (p *terminalProcess) Close() error                   { return p.reader.Close() }
func (p *terminalProcess) Resize(terminal.Size) error     { return nil }
func (p *terminalProcess) Shell() string                  { return "/fixture/sh" }
func (p *terminalProcess) Wait() (terminal.Exit, error)   { return <-p.exit, nil }
func (p *terminalProcess) Terminate() error {
	p.once.Do(func() { _ = p.output.Close(); p.exit <- terminal.Exit{ExitCode: -1} })
	return nil
}
func (p *terminalProcess) Kill() error { return p.Terminate() }

func TestServeRoutesThreeTerminalsAndContinuesHeartbeats(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newTerminalConnection()
	runner := testRunner(io.Discard)
	var count atomic.Int32
	runner.OnTerminalCount = func(n int) { count.Store(int32(n)) }
	runner.TerminalFactory = func(terminal.Size) (terminal.Process, error) { return newTerminalProcess(), nil }
	done := make(chan *Failure, 1)
	go func() { failure, _ := runner.serve(ctx, c); done <- failure }()
	hello := c.await(t, "agent_hello")
	var capabilities struct {
		Max int `json:"max_terminals"`
	}
	if json.Unmarshal(hello.Payload, &capabilities) != nil || capabilities.Max != 3 {
		t.Fatal("missing capacity advertisement")
	}
	ids := []string{"550e8400-e29b-41d4-a716-446655440001", "550e8400-e29b-41d4-a716-446655440002", "550e8400-e29b-41d4-a716-446655440003"}
	for _, id := range ids {
		c.request("terminal_open", id, terminal.Size{})
		ready := c.await(t, "terminal_ready")
		if ready.SessionID != id {
			t.Fatal("session routing lost")
		}
	}
	c.request("terminal_open", "550e8400-e29b-41d4-a716-446655440004", terminal.Size{})
	message := c.await(t, "terminal_error")
	var detail terminal.Error
	if json.Unmarshal(message.Payload, &detail) != nil || detail.Code != "TERMINAL_LIMIT_REACHED" || count.Load() != 3 {
		t.Fatal("fourth session was not rejected")
	}
	c.await(t, "heartbeat") // the reader remains available while terminals are active
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("serve did not reap fake Shells on shutdown")
	}
	if count.Load() != 0 || c.concurrent.Load() {
		t.Fatal("shutdown leaked sessions or concurrent WebSocket writes occurred")
	}
}

func TestWriterPrioritizesHeartbeatAndPreservesOutputExitOrder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newTerminalConnection()
	w := &writer{ctx: ctx, conn: c, timeout: time.Second, heartbeat: make(chan outgoing, 1), control: make(chan outgoing, 2), data: make(chan outgoing, 2), done: make(chan struct{}), fail: func(*Failure) { cancel() }}
	w.data <- outgoing{data: []byte(`{"type":"terminal_output"}`)}
	w.data <- outgoing{data: []byte(`{"type":"terminal_exit"}`)}
	w.control <- outgoing{data: []byte(`{"type":"terminal_ready"}`)}
	w.heartbeat <- outgoing{data: []byte(`{"type":"heartbeat"}`)}
	go w.run()
	for _, kind := range []string{"heartbeat", "terminal_ready", "terminal_output", "terminal_exit"} {
		select {
		case m := <-c.written:
			if m.Type != kind {
				t.Fatalf("expected %s, got %s", kind, m.Type)
			}
		case <-time.After(time.Second):
			t.Fatal("writer stalled")
		}
	}
	cancel()
	<-w.done
}
