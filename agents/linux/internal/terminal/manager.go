package terminal

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"sync"
	"time"

	"web2term/agent/internal/diagnostic"
)

// Send queues an ordered message; output/exit share the data queue so exit
// cannot overtake a session's buffered output. Ready/errors use the control queue.
type Send func(context.Context, Message, bool) error

type Manager struct {
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.Mutex
	sessions     map[string]*session
	retired      map[string]bool
	retiredOrder []string
	wg           sync.WaitGroup
	Factory      Factory
	Send         Send
	Log          *diagnostic.Log
	OnCount      func(int)
}

type operation struct {
	data []byte
	size *Size
}
type session struct {
	manager    *Manager
	id         string
	size       Size
	ctx        context.Context
	cancel     context.CancelFunc
	operations chan operation
	mu         sync.Mutex
	reason     string
}

func New(ctx context.Context, send Send, log *diagnostic.Log) *Manager {
	ctx, cancel := context.WithCancel(ctx)
	return &Manager{ctx: ctx, cancel: cancel, sessions: make(map[string]*session), retired: make(map[string]bool), Factory: DefaultFactory, Send: send, Log: log}
}

func (manager *Manager) Count() int {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return len(manager.sessions)
}
func (manager *Manager) Close() {
	manager.mu.Lock()
	manager.cancel()
	for _, session := range manager.sessions {
		session.stop("connection_lost")
	}
	manager.mu.Unlock()
	manager.wg.Wait()
}

// Handle never performs PTY I/O on the WebSocket reader goroutine.
func (manager *Manager) Handle(message Envelope) {
	if manager.ctx.Err() != nil {
		return
	}
	if !validSessionID(message.SessionID) {
		manager.reject("", "INVALID_SESSION_ID", "session_id 必须为小写规范 UUID")
		return
	}
	if message.Version != Version {
		manager.reject(message.SessionID, "UNSUPPORTED_VERSION", "终端消息必须使用 version=1")
		return
	}
	switch message.Type {
	case "terminal_open":
		size := Size{}
		if payload(message.Payload, &size) != nil {
			manager.reject(message.SessionID, "INVALID_PAYLOAD", "打开终端需要 cols 和 rows，不能指定 Shell、目录或命令")
			return
		}
		if size.Cols == 0 {
			size.Cols = DefaultCols
		}
		if size.Rows == 0 {
			size.Rows = DefaultRows
		}
		if !validSize(size) {
			manager.reject(message.SessionID, "INVALID_SIZE", "终端行列数必须为 1 到 1000")
			return
		}
		manager.open(message.SessionID, size)
	case "terminal_input":
		var value struct {
			Data *string `json:"data"`
		}
		if payload(message.Payload, &value) != nil || value.Data == nil {
			manager.reject(message.SessionID, "INVALID_PAYLOAD", "终端输入需要 Base64 data 字段")
			return
		}
		data, err := decodeData(*value.Data)
		if err != nil {
			manager.reject(message.SessionID, "INVALID_INPUT", "输入必须是标准 Base64，解码后每条最多 16 KiB")
			return
		}
		manager.enqueue(message.SessionID, operation{data: data})
	case "terminal_resize":
		var size Size
		if payload(message.Payload, &size) != nil || !validSize(size) {
			manager.reject(message.SessionID, "INVALID_SIZE", "终端行列数必须为 1 到 1000")
			return
		}
		manager.enqueue(message.SessionID, operation{size: &size})
	case "terminal_close":
		if len(message.Payload) != 0 && payload(message.Payload, &struct{}{}) != nil {
			manager.reject(message.SessionID, "INVALID_PAYLOAD", "关闭终端的 payload 应为空对象")
			return
		}
		manager.mu.Lock()
		current := manager.sessions[message.SessionID]
		manager.mu.Unlock()
		if current == nil {
			manager.reject(message.SessionID, "SESSION_NOT_FOUND", "终端会话不存在")
			return
		}
		current.stop("closed")
	default:
		manager.reject(message.SessionID, "UNSUPPORTED_MESSAGE", "工具不支持此终端消息类型")
	}
}

func (manager *Manager) open(id string, size Size) {
	manager.mu.Lock()
	if manager.ctx.Err() != nil {
		manager.mu.Unlock()
		return
	}
	if _, exists := manager.sessions[id]; exists {
		manager.mu.Unlock()
		manager.reject(id, "SESSION_EXISTS", "该终端会话已经存在")
		return
	}
	if manager.retired[id] {
		manager.mu.Unlock()
		manager.reject(id, "SESSION_CLOSED", "该会话已经结束，请使用新的 session_id")
		return
	}
	if len(manager.sessions) >= MaxSessions {
		manager.mu.Unlock()
		manager.reject(id, "TERMINAL_LIMIT_REACHED", "最多同时运行 3 个终端，请先关闭一个终端")
		return
	}
	ctx, cancel := context.WithCancel(manager.ctx)
	current := &session{manager: manager, id: id, size: size, ctx: ctx, cancel: cancel, operations: make(chan operation, 16)}
	manager.sessions[id] = current
	manager.wg.Add(1)
	manager.countChangedLocked()
	manager.mu.Unlock()
	manager.Log.Record(diagnostic.Entry{Event: "terminal_open_started", Phase: "terminal", SessionID: id})
	go current.run()
}

func (manager *Manager) enqueue(id string, value operation) {
	manager.mu.Lock()
	current := manager.sessions[id]
	manager.mu.Unlock()
	if current == nil {
		manager.reject(id, "SESSION_NOT_FOUND", "终端会话不存在")
		return
	}
	if current.ctx.Err() != nil {
		manager.reject(id, "SESSION_CLOSING", "终端正在关闭")
		return
	}
	select {
	case current.operations <- value:
	default:
		manager.reject(id, "INPUT_BACKPRESSURE", "终端输入处理过慢，当前会话已关闭")
		current.stop("input_backpressure")
	}
}

func (manager *Manager) reject(id, code, detail string) {
	manager.Log.Record(diagnostic.Entry{Event: "terminal_error", Phase: "terminal", SessionID: id, TerminalCode: code})
	_ = manager.Send(manager.ctx, packet("terminal_error", id, Error{Code: code, Message: detail}), true)
}
func (manager *Manager) countChangedLocked() {
	if manager.OnCount != nil {
		manager.OnCount(len(manager.sessions))
	}
}
func (session *session) stop(reason string) {
	session.mu.Lock()
	if session.reason == "" {
		session.reason = reason
	}
	session.mu.Unlock()
	session.cancel()
}
func (session *session) closeReason() string {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.reason
}

func (session *session) run() {
	manager := session.manager
	defer manager.wg.Done()
	defer func() {
		session.cancel()
		session.release()
	}()
	if session.ctx.Err() != nil {
		session.finished(Exit{ExitCode: -1})
		return
	}
	process, err := manager.Factory(session.size)
	if err != nil {
		if session.ctx.Err() != nil {
			session.finished(Exit{ExitCode: -1})
			return
		}
		manager.Log.Record(diagnostic.Entry{Event: "terminal_start_failed", Phase: "terminal", SessionID: session.id, Error: diagnostic.DescribeError(err)})
		session.release()
		manager.reject(session.id, "TERMINAL_START_FAILED", "无法创建本机终端，请查看工具运行日志")
		return
	}
	defer process.Close()
	type result struct {
		exit Exit
		err  error
	}
	waited := make(chan result, 1)
	go func() { exit, err := process.Wait(); waited <- result{exit: exit, err: err} }()
	readDone := make(chan error, 1)
	inputDone := make(chan error, 1)
	if session.ctx.Err() == nil {
		if err := manager.Send(session.ctx, packet("terminal_ready", session.id, Ready{Cols: session.size.Cols, Rows: session.size.Rows, Shell: process.Shell()}), true); err != nil {
			session.stop("connection_lost")
		} else {
			manager.Log.Record(diagnostic.Entry{Event: "terminal_ready", Phase: "terminal", SessionID: session.id})
		}
	}
	go func() { readDone <- session.readOutput(process) }()
	go func() { inputDone <- session.writeInput(process) }()
	var finished result
	var readError error
	readComplete, inputComplete, exited := false, false, false
	select {
	case finished = <-waited:
		exited = true
	case readError = <-readDone:
		readComplete = true
		if readError != nil && session.ctx.Err() == nil {
			manager.Log.Record(diagnostic.Entry{Event: "terminal_io_failed", Phase: "terminal", SessionID: session.id, TerminalCode: "TERMINAL_OUTPUT_FAILED", Error: diagnostic.DescribeError(readError)})
			manager.reject(session.id, "TERMINAL_OUTPUT_FAILED", "终端输出传输失败，当前会话已关闭")
			session.stop("output_error")
		}
	case err = <-inputDone:
		inputComplete = true
		if err != nil && session.ctx.Err() == nil {
			manager.Log.Record(diagnostic.Entry{Event: "terminal_io_failed", Phase: "terminal", SessionID: session.id, TerminalCode: "TERMINAL_INPUT_FAILED", Error: diagnostic.DescribeError(err)})
			manager.reject(session.id, "TERMINAL_INPUT_FAILED", "终端输入或尺寸调整失败，当前会话已关闭")
			session.stop("input_error")
		}
	case <-session.ctx.Done():
	}
	// On a clean PTY EOF allow Wait to report the natural Shell exit first.
	if readComplete && readError == nil && session.ctx.Err() == nil {
		timer := time.NewTimer(200 * time.Millisecond)
		select {
		case finished = <-waited:
			exited = true
		case <-timer.C:
			session.stop("shell_exit")
		case <-session.ctx.Done():
		}
		timer.Stop()
	}
	if exited && !readComplete && session.ctx.Err() == nil {
		// Drain buffered output before closing the PTY; a detached child must not
		// hold the reader forever after the Shell exits.
		timer := time.NewTimer(2 * time.Second)
		select {
		case readError = <-readDone:
			readComplete = true
			if readError != nil && session.ctx.Err() == nil {
				manager.Log.Record(diagnostic.Entry{Event: "terminal_io_failed", Phase: "terminal", SessionID: session.id, TerminalCode: "TERMINAL_OUTPUT_FAILED", Error: diagnostic.DescribeError(readError)})
				manager.reject(session.id, "TERMINAL_OUTPUT_FAILED", "终端输出传输失败，当前会话已关闭")
				session.stop("output_error")
			}
		case <-timer.C:
		case <-session.ctx.Done():
		}
		timer.Stop()
	}
	if !exited {
		_ = process.Terminate()
	}
	_ = process.Close()
	session.cancel()
	if !exited {
		timer := time.NewTimer(2 * time.Second)
		select {
		case finished = <-waited:
		case <-timer.C:
			_ = process.Kill()
			finished = <-waited
		}
		timer.Stop()
	}
	if !readComplete {
		<-readDone
	}
	if !inputComplete {
		<-inputDone
	}
	if finished.err != nil {
		manager.Log.Record(diagnostic.Entry{Event: "terminal_wait_failed", Phase: "terminal", SessionID: session.id, Error: diagnostic.DescribeError(finished.err)})
	}
	session.finished(finished.exit)
}

func (session *session) finished(exit Exit) {
	manager := session.manager
	exit.Reason = session.closeReason()
	if exit.Reason == "" {
		if manager.ctx.Err() != nil {
			exit.Reason = "connection_lost"
		} else {
			exit.Reason = "shell_exit"
		}
	}
	manager.Log.Record(diagnostic.Entry{Event: "terminal_exit", Phase: "terminal", SessionID: session.id, ExitCode: &exit.ExitCode, Outcome: exit.Reason})
	session.release() // resources are gone before a client receives terminal_exit
	if manager.ctx.Err() == nil {
		_ = manager.Send(manager.ctx, packet("terminal_exit", session.id, exit), false)
	}
}

func (session *session) release() {
	manager := session.manager
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.sessions[session.id] != session {
		return
	}
	delete(manager.sessions, session.id)
	manager.retired[session.id] = true
	manager.retiredOrder = append(manager.retiredOrder, session.id)
	if len(manager.retiredOrder) > 128 {
		delete(manager.retired, manager.retiredOrder[0])
		manager.retiredOrder = manager.retiredOrder[1:]
	}
	manager.countChangedLocked()
}

func (session *session) readOutput(process Process) error {
	buffer := make([]byte, MaxDataBytes)
	for {
		n, err := process.Read(buffer)
		if n > 0 && session.ctx.Err() == nil {
			ctx, cancel := context.WithTimeout(session.ctx, 5*time.Second)
			sendErr := session.manager.Send(ctx, packet("terminal_output", session.id, Data{Data: base64.StdEncoding.EncodeToString(buffer[:n])}), false)
			cancel()
			if sendErr != nil {
				return sendErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) || session.ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

func (session *session) writeInput(process Process) error {
	for {
		select {
		case <-session.ctx.Done():
			return nil
		case value := <-session.operations:
			if session.ctx.Err() != nil {
				return nil
			}
			if value.size != nil {
				if err := process.Resize(*value.size); err != nil {
					return err
				}
				session.manager.Log.Record(diagnostic.Entry{Event: "terminal_resized", Phase: "terminal", SessionID: session.id})
				if err := session.manager.Send(session.ctx, packet("terminal_resized", session.id, *value.size), true); err != nil {
					return err
				}
			} else {
				data := value.data
				for len(data) > 0 {
					n, err := process.Write(data)
					if err != nil {
						return err
					}
					if n == 0 {
						return io.ErrShortWrite
					}
					data = data[n:]
				}
			}
		}
	}
}
