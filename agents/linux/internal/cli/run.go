package cli

import (
	"fmt"
	"io"

	"web2term/agent/internal/daemon"
)

func runAgent(output io.Writer, path string) error {
	info, started, err := daemon.Start(path)
	if err != nil {
		return err
	}
	message := "后台进程已启动"
	if !started {
		message = "后台进程已在运行，本次未重复启动"
	}
	if _, err := fmt.Fprintf(output, "%s（PID：%d）。\n", message, info.PID); err != nil {
		return err
	}
	if err := printAgentInfo(output, info); err != nil {
		return err
	}
	_, err = fmt.Fprintln(output, "关闭当前终端后继续运行。查看状态：web2term status；停止：web2term stop。")
	return err
}

func statusAgent(output io.Writer, path string) error {
	info, err := daemon.Inspect(path)
	if err != nil {
		return err
	}
	return printAgentInfo(output, info)
}

func stopAgent(output io.Writer, path string) error {
	stopped, err := daemon.Stop(path)
	if err != nil {
		return err
	}
	message := "后台进程已停止。"
	if !stopped {
		message = "后台进程未运行。"
	}
	_, err = fmt.Fprintln(output, message)
	return err
}

func printAgentInfo(output io.Writer, info daemon.Info) error {
	state := map[string]string{daemon.StateConnecting: "正在连接服务端", daemon.StateOnline: "设备已在线，服务端已确认心跳", daemon.StateReconnecting: "等待重新连接", daemon.StateStopped: "未运行"}[info.State]
	if state == "" {
		state = "状态未知"
	}
	if _, err := fmt.Fprintf(output, "后台状态：%s\n", state); err != nil {
		return err
	}
	if info.PID > 0 {
		if _, err := fmt.Fprintf(output, "进程 PID：%d\n", info.PID); err != nil {
			return err
		}
	}
	if info.MaxTerminals > 0 {
		if _, err := fmt.Fprintf(output, "终端会话：%d/%d\n", info.TerminalCount, info.MaxTerminals); err != nil {
			return err
		}
	}
	if info.DeviceID != "" {
		if _, err := fmt.Fprintf(output, "设备名称：%s\n设备 ID：%s\n连接地址：%s\n登录有效期至：%s（UTC）\n", info.DeviceName, info.DeviceID, info.URL, info.ExpiresAt.UTC().Format("2006-01-02 15:04:05")); err != nil {
			return err
		}
	}
	if info.LastError != "" {
		if _, err := fmt.Fprintf(output, "最近错误：%s\n", info.LastError); err != nil {
			return err
		}
	}
	if info.LogPath != "" {
		if _, err := fmt.Fprintf(output, "运行日志：%s\n", info.LogPath); err != nil {
			return err
		}
	}
	if info.OutputPath != "" {
		if _, err := fmt.Fprintf(output, "后台输出日志：%s\n", info.OutputPath); err != nil {
			return err
		}
	}
	return nil
}
