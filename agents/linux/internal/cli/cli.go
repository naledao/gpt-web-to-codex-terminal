package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"

	"web2term/agent/internal/config"
	"web2term/agent/internal/daemon"
)

const help = `web2term — 远程终端工具

用法：
  web2term set server    交互式配置后端请求地址
  web2term login         邮箱验证码登录并保存登录信息
  web2term run           后台连接服务端，保持设备在线
  web2term status        查看后台进程和连接状态
  web2term stop          停止后台进程
  web2term --help        查看帮助
`

// An empty configPath selects the current user's standard configuration path.
func Run(args []string, input io.Reader, output io.Writer, configPath string) error {
	if len(args) == 3 && args[0] == "__agent" {
		return daemon.Worker(args[1], args[2])
	}
	if len(args) == 0 || (len(args) == 1 && (args[0] == "--help" || args[0] == "-h" || args[0] == "help")) {
		_, err := fmt.Fprint(output, help)
		return err
	}
	isSetServer := len(args) == 2 && args[0] == "set" && args[1] == "server"
	isLogin := len(args) == 1 && args[0] == "login"
	isRun := len(args) == 1 && args[0] == "run"
	isStatus := len(args) == 1 && args[0] == "status"
	isStop := len(args) == 1 && args[0] == "stop"
	if !isSetServer && !isLogin && !isRun && !isStatus && !isStop {
		return errors.New("命令格式不正确，请使用 web2term --help 查看帮助；地址和登录信息按交互提示输入")
	}
	if configPath == "" {
		var err error
		configPath, err = config.DefaultPath()
		if err != nil {
			return err
		}
	}
	if isLogin {
		return login(input, output, configPath)
	}
	if isRun {
		return runAgent(output, configPath)
	}
	if isStatus {
		return statusAgent(output, configPath)
	}
	if isStop {
		return stopAgent(output, configPath)
	}
	return setServer(input, output, configPath)
}

func setServer(input io.Reader, output io.Writer, path string) error {
	current, err := config.Server(path)
	if err != nil {
		return err
	}
	if current != "" {
		if normalized, err := config.NormalizeServerURL(current); err == nil {
			current = normalized
			fmt.Fprintf(output, "当前后端请求地址：%s\n", current)
			fmt.Fprintln(output, "直接回车保留当前地址；按 Ctrl+C 取消。")
		} else {
			current = ""
			fmt.Fprintln(output, "当前配置的地址格式无效，请重新设置。")
		}
	} else {
		fmt.Fprintln(output, "按 Ctrl+C 取消。")
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 1024), 8192)
	for {
		fmt.Fprint(output, "请输入后端请求地址（例如 https://example.com:8443）：")
		if !scanner.Scan() {
			if err := scanner.Err(); err != nil {
				return fmt.Errorf("读取输入失败，配置未修改：%w", err)
			}
			fmt.Fprintln(output, "\n已取消，配置未修改。")
			return nil
		}
		value := strings.TrimSpace(scanner.Text())
		if value == "" && current != "" {
			fmt.Fprintln(output, "已保留当前后端请求地址。")
			return nil
		}
		server, err := config.NormalizeServerURL(value)
		if err != nil {
			fmt.Fprintf(output, "地址无效：%s。请重新输入。\n", err)
			continue
		}
		if err := config.SaveServer(path, server); err != nil {
			return err
		}
		fmt.Fprintf(output, "后端请求地址已保存：%s\n配置文件：%s\n", server, path)
		return nil
	}
}
