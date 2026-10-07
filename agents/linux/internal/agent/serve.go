package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"web2term/agent/internal/diagnostic"
	"web2term/agent/internal/terminal"
)

func (runner *Runner) serve(ctx context.Context, conn Connection) (*Failure, bool) {
	workCtx, cancelWork := context.WithCancel(ctx)
	readCtx, cancelReader := context.WithCancel(context.Background())
	acks := make(chan struct{}, 1)
	failures := make(chan *Failure, 1)
	var once sync.Once
	fail := func(failure *Failure) { once.Do(func() { failures <- failure; cancelWork() }) }
	writer := newWriter(workCtx, conn, runner.Options.WriteTimeout, fail)
	manager := terminal.New(workCtx, writer.send, runner.Log)
	manager.OnCount = runner.OnTerminalCount
	if runner.TerminalFactory != nil {
		manager.Factory = runner.TerminalFactory
	}
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			typ, data, err := conn.Read(readCtx)
			if err != nil {
				fail(connectionFailure(err))
				return
			}
			if typ != websocket.MessageText {
				runner.Log.Record(diagnostic.Entry{Event: "agent_message_ignored", Phase: "agent", Bytes: len(data)})
				continue
			}
			var message terminal.Envelope
			if json.Unmarshal(data, &message) != nil {
				runner.Log.Record(diagnostic.Entry{Event: "agent_invalid_json", Phase: "agent", Bytes: len(data)})
				fail(&Failure{Message: "服务端返回了无效的 JSON 消息，请查看诊断日志"})
				return
			}
			if message.Type == "heartbeat_ack" {
				select {
				case acks <- struct{}{}:
				default:
				}
			} else if strings.HasPrefix(message.Type, "terminal_") {
				manager.Handle(message)
			} else {
				runner.Log.Record(diagnostic.Entry{Event: "agent_message_ignored", Phase: "agent", Bytes: len(data)})
			}
		}
	}()
	defer func() {
		cancelWork()
		manager.Close() // reap all session Shells before reconnecting/exiting
		if ctx.Err() != nil {
			_ = conn.Close(websocket.StatusNormalClosure, "agent stopped")
		}
		cancelReader()
		_ = conn.CloseNow()
		<-readerDone
		<-writer.done
	}()
	healthy := false
	for {
		select {
		case <-acks:
		default:
		}
		started := time.Now()
		writeCtx, cancel := context.WithTimeout(workCtx, runner.Options.WriteTimeout)
		err := writer.beat(writeCtx)
		cancel()
		if err != nil {
			select {
			case failure := <-failures:
				return failure, healthy
			default:
				return connectionFailure(err), healthy
			}
		}
		runner.Log.Record(diagnostic.Entry{Event: "heartbeat_sent", Phase: "agent"})
		timer := time.NewTimer(runner.Options.AckTimeout)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, healthy
		case failure := <-failures:
			timer.Stop()
			return failure, healthy
		case <-timer.C:
			runner.Log.Record(diagnostic.Entry{Event: "heartbeat_timeout", Phase: "agent", TimeoutMS: runner.Options.AckTimeout.Milliseconds()})
			return &Failure{Message: fmt.Sprintf("服务端未在 %.1f 秒内确认心跳，连接已关闭", runner.Options.AckTimeout.Seconds()), Retry: true}, healthy
		case <-acks:
			timer.Stop()
			runner.Log.Record(diagnostic.Entry{Event: "heartbeat_ack", Phase: "agent", ElapsedMS: time.Since(started).Milliseconds()})
			if !healthy {
				healthy = true
				runner.state("online", "")
				hello := terminal.Message{Version: terminal.Version, Type: "agent_hello", Payload: map[string]any{"protocol": "web2term-terminal", "max_terminals": terminal.MaxSessions, "capabilities": []string{"pty", "terminal_input", "terminal_resize", "terminal_close"}}}
				if err := writer.send(workCtx, hello, true); err != nil {
					return connectionFailure(err), healthy
				}
				if _, err := fmt.Fprintln(runner.Output, "设备已在线，服务端已确认心跳。最多同时支持 3 个终端。"); err != nil {
					return &Failure{Message: "无法输出设备连接状态", Cause: err}, healthy
				}
			}
		}
		timer = time.NewTimer(runner.Options.HeartbeatInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, healthy
		case failure := <-failures:
			timer.Stop()
			return failure, healthy
		case <-timer.C:
		}
	}
}
