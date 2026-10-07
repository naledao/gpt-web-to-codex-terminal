package agent

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/coder/websocket"
	"web2term/agent/internal/terminal"
)

type outgoing struct {
	data   []byte
	result chan error
}
type writer struct {
	ctx       context.Context
	conn      Connection
	timeout   time.Duration
	heartbeat chan outgoing
	control   chan outgoing
	data      chan outgoing
	done      chan struct{}
	fail      func(*Failure)
}

func newWriter(ctx context.Context, conn Connection, timeout time.Duration, fail func(*Failure)) *writer {
	writer := &writer{ctx: ctx, conn: conn, timeout: timeout, heartbeat: make(chan outgoing, 1), control: make(chan outgoing, 32), data: make(chan outgoing, 64), done: make(chan struct{}), fail: fail}
	go writer.run()
	return writer
}

func (writer *writer) send(ctx context.Context, message terminal.Message, control bool) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return err
	}
	value := outgoing{data: encoded}
	if control {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-writer.ctx.Done():
			return writer.ctx.Err()
		case writer.control <- value:
			return nil
		default:
			err := errors.New("control queue full")
			writer.fail(&Failure{Message: "终端控制消息积压，连接将重新建立", Retry: true, Cause: err})
			return err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-writer.ctx.Done():
		return writer.ctx.Err()
	case writer.data <- value:
		return nil
	}
}

func (writer *writer) beat(ctx context.Context) error {
	result := make(chan error, 1)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case writer.heartbeat <- outgoing{data: []byte(`{"type":"heartbeat"}`), result: result}:
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-result:
		return err
	}
}

func (writer *writer) run() {
	defer close(writer.done)
	for {
		var value outgoing
		// Heartbeats have priority; terminal output cannot fill their queue.
		select {
		case <-writer.ctx.Done():
			return
		case value = <-writer.heartbeat:
		default:
			select {
			case <-writer.ctx.Done():
				return
			case value = <-writer.heartbeat:
			case value = <-writer.control:
			default:
				select {
				case <-writer.ctx.Done():
					return
				case value = <-writer.heartbeat:
				case value = <-writer.control:
				case value = <-writer.data:
				}
			}
		}
		ctx, cancel := context.WithTimeout(writer.ctx, writer.timeout)
		err := writer.conn.Write(ctx, websocket.MessageText, value.data)
		cancel()
		if value.result != nil {
			value.result <- err
		}
		if err != nil {
			writer.fail(connectionFailure(err))
			return
		}
	}
}
