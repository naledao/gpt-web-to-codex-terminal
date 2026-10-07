//go:build linux

package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"web2term/agent/internal/agent"
	"web2term/agent/internal/config"
	"web2term/agent/internal/diagnostic"
	"web2term/agent/internal/terminal"
)

var errRunning = errors.New("后台进程已运行")

type paths struct{ config, lock, socket, state string }

func runtimePaths(path string) (paths, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return paths{}, err
	}
	dir := filepath.Dir(absolute)
	return paths{config: absolute, lock: filepath.Join(dir, "daemon.lock"), socket: filepath.Join(dir, "daemon.sock"), state: filepath.Join(dir, "daemon-state.json")}, nil
}

// Never unlink this file or explicitly LOCK_UN an inherited lock: the parent
// and child share its open file description across exec. Closing the parent's
// descriptor retains the child's lock until the worker exits.
func acquireLock(path string, create bool) (*os.File, error) {
	flags := os.O_RDWR
	if create {
		flags |= os.O_CREATE
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errRunning
		}
		return nil, err
	}
	return file, nil
}

func Start(path string) (Info, bool, error) {
	files, err := runtimePaths(path)
	if err != nil {
		return Info{}, false, err
	}
	if err := os.MkdirAll(filepath.Dir(files.config), 0o700); err != nil {
		return Info{}, false, err
	}
	lock, err := acquireLock(files.lock, true)
	if errors.Is(err, errRunning) {
		info, err := requestControl(files.socket, "/status", http.MethodGet)
		if err != nil {
			return Info{}, false, errors.New("后台进程正在启动或暂时无响应，请稍后运行 web2term status")
		}
		if info.State == StateStopped {
			return Info{}, false, errors.New("后台进程正在退出，请稍后重新运行 web2term run")
		}
		return info, false, nil
	}
	if err != nil {
		return Info{}, false, fmt.Errorf("无法锁定后台进程：%w", err)
	}
	defer lock.Close()
	hostname, _ := os.Hostname()
	if _, err := config.AgentConfig(files.config, time.Now(), hostname); err != nil {
		return Info{}, false, err
	}
	if len(files.socket) > 100 {
		return Info{}, false, errors.New("工具配置目录过长，无法创建后台控制套接字，请使用较短的 XDG_CONFIG_HOME")
	}
	executable, err := os.Executable()
	if err != nil {
		return Info{}, false, err
	}
	console, err := os.CreateTemp("", "web2term-daemon-"+time.Now().UTC().Format("20060102T150405Z")+"-*.log")
	if err != nil {
		return Info{}, false, fmt.Errorf("无法创建后台输出日志：%w", err)
	}
	defer console.Close()
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return Info{}, false, err
	}
	defer null.Close()
	reader, writer, err := os.Pipe()
	if err != nil {
		return Info{}, false, err
	}
	defer reader.Close()
	defer writer.Close()
	command := exec.Command(executable, "__agent", files.config, console.Name())
	command.Dir = "/"
	command.Stdin, command.Stdout, command.Stderr = null, console, console
	command.ExtraFiles = []*os.File{lock, writer} // child descriptors 3 and 4
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return Info{}, false, fmt.Errorf("后台进程启动失败：%w", err)
	}
	_ = writer.Close()
	result := make(chan startupReport, 1)
	go func() {
		var report startupReport
		if json.NewDecoder(io.LimitReader(reader, 64*1024)).Decode(&report) != nil {
			report.Error = "后台进程初始化失败，请查看后台输出日志"
		}
		result <- report
	}()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	var report startupReport
	select {
	case report = <-result:
	case <-timer.C:
		report.Error = "后台进程初始化超时"
	}
	if report.Error != "" || report.Info.PID != command.Process.Pid {
		_ = command.Process.Kill()
		_ = command.Wait()
		if report.Error == "" {
			report.Error = "后台进程返回了无效的启动状态"
		}
		return Info{}, false, fmt.Errorf("%s；后台输出日志：%s", report.Error, console.Name())
	}
	_ = command.Process.Release()
	return report.Info, true, nil
}

func requestControl(socket, path, method string) (Info, error) {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	request, _ := http.NewRequest(method, "http://localhost"+path, nil)
	response, err := client.Do(request)
	if err != nil {
		return Info{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Info{}, errors.New("后台控制请求失败")
	}
	var info Info
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&info); err != nil {
		return Info{}, err
	}
	return info, nil
}

func Inspect(path string) (Info, error) {
	files, err := runtimePaths(path)
	if err != nil {
		return Info{}, err
	}
	lock, err := acquireLock(files.lock, false)
	if errors.Is(err, errRunning) {
		info, err := requestControl(files.socket, "/status", http.MethodGet)
		if err != nil {
			return Info{}, errors.New("后台进程正在启动或暂时无响应，请稍后重试")
		}
		return info, nil
	}
	if err != nil && !os.IsNotExist(err) {
		return Info{}, err
	}
	if lock != nil {
		defer lock.Close()
	}
	info, err := readInfo(files.state)
	if err != nil {
		return Info{}, err
	}
	info.State, info.PID = StateStopped, 0 // a persisted PID is never proof of life
	info.TerminalCount = 0
	return info, nil
}

func Stop(path string) (bool, error) {
	files, err := runtimePaths(path)
	if err != nil {
		return false, err
	}
	lock, err := acquireLock(files.lock, false)
	if err == nil {
		_ = lock.Close()
		return false, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	if !errors.Is(err, errRunning) {
		return false, err
	}
	target, err := requestControl(files.socket, "/stop", http.MethodPost)
	if err != nil {
		return false, errors.New("无法确认后台停止结果，请运行 web2term status 查看状态并检查日志")
	}
	// Wait for the worker to close its WebSocket and release the singleton lock.
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			return false, errors.New("停止请求已发送，但后台进程尚未退出，请运行 web2term status 查看状态")
		case <-ticker.C:
			lock, err := acquireLock(files.lock, false)
			if err == nil {
				_ = lock.Close()
				return true, nil
			}
			if !errors.Is(err, errRunning) {
				return false, err
			}
			if current, err := requestControl(files.socket, "/status", http.MethodGet); err == nil && current.OutputPath != target.OutputPath {
				return true, nil // a new instance started after the requested one exited
			}
		}
	}
}

// Worker is internal; it must be launched by Start with inherited lock/pipe FDs.
func Worker(path, outputPath string) (result error) {
	files, err := runtimePaths(path)
	if err != nil {
		return err
	}
	lock, ready := os.NewFile(3, "daemon.lock"), os.NewFile(4, "daemon-ready")
	if lock == nil || ready == nil {
		return errors.New("请使用 web2term run 启动工具")
	}
	defer lock.Close()
	defer ready.Close()
	// Do not let PTY Shells inherit the daemon lock or startup pipe.
	syscall.CloseOnExec(3)
	syscall.CloseOnExec(4)
	lockedInfo, err := lock.Stat()
	if err != nil {
		return errors.New("缺少后台启动锁，请使用 web2term run")
	}
	pathInfo, err := os.Stat(files.lock)
	if err != nil || !os.SameFile(lockedInfo, pathInfo) {
		return errors.New("后台启动锁不匹配，请使用 web2term run")
	}
	pipeInfo, err := ready.Stat()
	if err != nil || pipeInfo.Mode()&os.ModeNamedPipe == 0 {
		return errors.New("缺少后台启动通道，请使用 web2term run")
	}
	reported := false
	defer func() {
		if !reported {
			detail := "后台初始化失败，请查看后台输出日志"
			if result != nil {
				detail = "后台初始化失败：" + result.Error()
			}
			_ = json.NewEncoder(ready).Encode(startupReport{Error: detail})
		}
	}()
	// Handle and discard HUP rather than setting SIG_IGN: PTY Shells must
	// inherit the default hangup disposition after exec. Setsid already
	// detaches this worker from the terminal that launched web2term run.
	hangups := make(chan os.Signal, 1)
	signal.Notify(hangups, syscall.SIGHUP)
	defer signal.Stop(hangups)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	hostname, _ := os.Hostname()
	settings, err := config.AgentConfig(files.config, time.Now(), hostname)
	if err != nil {
		return err
	}
	address, err := agent.WebSocketURL(settings.ServerURL)
	if err != nil {
		return err
	}
	log, err := diagnostic.OpenRun("", os.Stderr)
	if err != nil {
		return fmt.Errorf("无法创建后台运行日志：%w", err)
	}
	defer log.Close()
	info := Info{PID: os.Getpid(), State: StateConnecting, DeviceID: settings.DeviceID, DeviceName: settings.DeviceName, URL: address, ExpiresAt: settings.Login.ExpiresAt, LogPath: log.Path(), OutputPath: outputPath, UpdatedAt: time.Now().UTC(), MaxTerminals: terminal.MaxSessions}
	control := &control{info: info, statePath: files.state, cancel: cancel}
	if err := writeInfo(files.state, info); err != nil {
		return fmt.Errorf("无法保存后台状态：%w", err)
	}
	if err := os.Remove(files.socket); err != nil && !os.IsNotExist(err) {
		return err
	}
	listener, err := net.Listen("unix", files.socket)
	if err != nil {
		return fmt.Errorf("无法创建后台控制通道：%w", err)
	}
	defer listener.Close()
	if err := os.Chmod(files.socket, 0o600); err != nil {
		return err
	}
	server := &http.Server{Handler: control, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 2 * time.Second, WriteTimeout: 2 * time.Second, IdleTimeout: 2 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, "后台控制通道异常，工具停止运行。")
			cancel()
		}
	}()
	defer func() {
		detail := ""
		if result != nil {
			detail = result.Error()
		} // Runner only returns safe, user-facing errors
		control.update(StateStopped, detail)
		shutdownCtx, stop := context.WithTimeout(context.Background(), 2*time.Second)
		defer stop()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := json.NewEncoder(ready).Encode(startupReport{Info: info}); err != nil {
		return errors.New("无法向启动命令确认后台状态")
	}
	reported = true
	_ = ready.Close()
	log.Record(diagnostic.Entry{Event: "agent_run_started", Phase: "agent", URL: address, DeviceID: settings.DeviceID})
	runner := agent.New(os.Stdout, log)
	runner.OnState = control.update
	runner.OnTerminalCount = control.updateTerminals
	err = runner.Run(ctx, settings)
	outcome := "stopped"
	if err != nil {
		outcome = "failed"
	}
	log.Record(diagnostic.Entry{Event: "agent_run_finished", Phase: "agent", Outcome: outcome, Error: diagnostic.DescribeError(err)})
	return err
}
