package diagnostic

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"sync"
	"time"
)

// Entry deliberately has no request/response bodies, headers, or input fields.
type Entry struct {
	Time         time.Time  `json:"time"`
	Event        string     `json:"event"`
	Phase        string     `json:"phase,omitempty"`
	RequestID    uint64     `json:"request_id,omitempty"`
	Method       string     `json:"method,omitempty"`
	URL          string     `json:"url,omitempty"`
	Proxy        string     `json:"proxy,omitempty"`
	Peer         string     `json:"peer,omitempty"`
	Network      string     `json:"network,omitempty"`
	Status       int        `json:"http_status,omitempty"`
	Code         string     `json:"api_code,omitempty"`
	Protocol     string     `json:"protocol,omitempty"`
	ElapsedMS    int64      `json:"elapsed_ms,omitempty"`
	TimeoutMS    int64      `json:"timeout_ms,omitempty"`
	Bytes        int        `json:"response_bytes,omitempty"`
	Addresses    int        `json:"resolved_addresses,omitempty"`
	Reused       *bool      `json:"connection_reused,omitempty"`
	Outcome      string     `json:"outcome,omitempty"`
	Runtime      string     `json:"runtime,omitempty"`
	Platform     string     `json:"platform,omitempty"`
	DeviceID     string     `json:"device_id,omitempty"`
	SessionID    string     `json:"session_id,omitempty"`
	TerminalCode string     `json:"terminal_code,omitempty"`
	ExitCode     *int       `json:"exit_code,omitempty"`
	Attempt      int        `json:"attempt,omitempty"`
	CloseCode    int        `json:"close_code,omitempty"`
	DelayMS      int64      `json:"retry_delay_ms,omitempty"`
	Error        *ErrorInfo `json:"error,omitempty"`
}

type Log struct {
	mu       sync.Mutex
	file     *os.File
	warnings io.Writer
	warned   bool
	closed   bool
}

// Open creates one private log per invocation. An empty directory uses TMPDIR
// on Linux and TEMP on Windows. Nothing is written inside the repository.
func Open(directory string, warnings io.Writer) (*Log, error) {
	return open(directory, "web2term-login", warnings)
}

func OpenRun(directory string, warnings io.Writer) (*Log, error) {
	return open(directory, "web2term-run", warnings)
}

func open(directory, prefix string, warnings io.Writer) (*Log, error) {
	if directory == "" {
		directory = os.TempDir()
	}
	file, err := os.CreateTemp(directory, prefix+"-"+time.Now().UTC().Format("20060102T150405Z")+"-*.log")
	if err != nil {
		return nil, err
	}
	log := &Log{file: file, warnings: warnings}
	log.Record(Entry{Event: "log_opened", Runtime: runtime.Version(), Platform: runtime.GOOS + "/" + runtime.GOARCH})
	return log, nil
}

func (log *Log) Path() string {
	return log.file.Name()
}

// Record is synchronous and flushes each line, retaining completed events if
// Ctrl+C stops the process. HTTP trace callbacks may run on different goroutines.
// Logging failures warn once and do not stop the command.
func (log *Log) Record(entry Entry) {
	if log == nil {
		return
	}
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.closed {
		return
	}
	entry.Time = time.Now().UTC()
	data, err := json.Marshal(entry)
	if err == nil {
		_, err = log.file.Write(append(data, '\n'))
	}
	if err == nil {
		err = log.file.Sync()
	}
	log.warn(err)
}

func (log *Log) Close() {
	if log == nil {
		return
	}
	log.mu.Lock()
	defer log.mu.Unlock()
	if !log.closed {
		log.closed = true
		log.warn(log.file.Close())
	}
}

func (log *Log) warn(err error) {
	if err != nil && !log.warned {
		log.warned = true
		if log.warnings != nil {
			_, _ = fmt.Fprintln(log.warnings, "警告：诊断日志写入失败，后续记录可能不完整；工具继续运行。")
		}
	}
}
