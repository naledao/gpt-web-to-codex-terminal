package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	StateConnecting   = "connecting"
	StateOnline       = "online"
	StateReconnecting = "reconnecting"
	StateStopped      = "stopped"
)

// Info contains process/connection metadata only; credentials stay in config.json.
type Info struct {
	PID           int       `json:"pid"`
	State         string    `json:"state"`
	DeviceID      string    `json:"device_id,omitempty"`
	DeviceName    string    `json:"device_name,omitempty"`
	URL           string    `json:"url,omitempty"`
	ExpiresAt     time.Time `json:"expires_at,omitempty"`
	LogPath       string    `json:"log_path,omitempty"`
	OutputPath    string    `json:"output_path,omitempty"`
	LastError     string    `json:"last_error,omitempty"`
	UpdatedAt     time.Time `json:"updated_at"`
	TerminalCount int       `json:"terminal_count"`
	MaxTerminals  int       `json:"max_terminals"`
}

type startupReport struct {
	Info  Info   `json:"info"`
	Error string `json:"error,omitempty"`
}

type control struct {
	mu        sync.Mutex
	info      Info
	statePath string
	cancel    func()
}

func (control *control) snapshot() Info {
	control.mu.Lock()
	defer control.mu.Unlock()
	return control.info
}

func (control *control) update(state, detail string) {
	control.mu.Lock()
	defer control.mu.Unlock()
	control.info.State = state
	control.info.LastError = detail
	control.info.UpdatedAt = time.Now().UTC()
	if state == StateStopped {
		control.info.PID = 0
		control.info.TerminalCount = 0
	}
	if control.statePath != "" {
		if err := writeInfo(control.statePath, control.info); err != nil {
			fmt.Fprintln(os.Stderr, "警告：后台状态文件保存失败，请通过运行日志排查。")
		}
	}
}

func (control *control) updateTerminals(count int) {
	control.mu.Lock()
	defer control.mu.Unlock()
	control.info.TerminalCount = count
	control.info.UpdatedAt = time.Now().UTC()
	if control.statePath != "" {
		if err := writeInfo(control.statePath, control.info); err != nil {
			fmt.Fprintln(os.Stderr, "警告：终端数量保存失败，请查看运行日志。")
		}
	}
}

func (control *control) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Content-Type", "application/json")
	switch {
	case request.URL.Path == "/status" && request.Method == http.MethodGet:
		_ = json.NewEncoder(writer).Encode(control.snapshot())
	case request.URL.Path == "/stop" && request.Method == http.MethodPost:
		_ = json.NewEncoder(writer).Encode(control.snapshot())
		control.cancel()
	default:
		writer.WriteHeader(http.StatusNotFound)
	}
}

func writeInfo(path string, info Info) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".daemon-state-*.tmp")
	if err != nil {
		return err
	}
	defer func() { _ = file.Close(); _ = os.Remove(file.Name()) }()
	if err := json.NewEncoder(file).Encode(info); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func readInfo(path string) (Info, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Info{State: StateStopped}, nil
	}
	if err != nil {
		return Info{}, err
	}
	var info Info
	if err := json.Unmarshal(data, &info); err != nil {
		return Info{}, fmt.Errorf("后台状态文件损坏，请重新运行 web2term run")
	}
	return info, nil
}
