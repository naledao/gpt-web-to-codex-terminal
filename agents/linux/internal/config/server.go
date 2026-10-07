package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
)

const serverKey = "server_url"

// DefaultPath is independent of the directory from which web2term is invoked.
// On Linux, UserConfigDir honors XDG_CONFIG_HOME and otherwise uses ~/.config.
func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("无法确定用户配置目录：%w", err)
	}
	return filepath.Join(dir, "web2term", "config.json"), nil
}

// NormalizeServerURL validates an HTTP API base URL without making a request.
// Paths (including trailing slashes) are retained for backends with a context path.
func NormalizeServerURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("后端请求地址不能为空")
	}
	if strings.ContainsFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) {
		return "", errors.New("地址中不能包含空白或控制字符")
	}
	address, err := url.Parse(value)
	if err != nil {
		return "", errors.New("地址格式不正确，请检查主机、端口和路径")
	}
	address.Scheme = strings.ToLower(address.Scheme)
	if address.Scheme != "http" && address.Scheme != "https" {
		return "", errors.New("请填写以 http:// 或 https:// 开头的后端请求地址")
	}
	if address.Opaque != "" || address.Hostname() == "" {
		return "", errors.New("地址缺少有效主机，例如 https://example.com:8443")
	}
	if address.User != nil {
		return "", errors.New("后端请求地址不能包含用户名或密码")
	}
	if address.ForceQuery || address.RawQuery != "" || strings.Contains(value, "#") {
		return "", errors.New("请填写后端基础地址，不要包含查询参数或 # 片段")
	}
	if strings.HasPrefix(address.Host, "[") {
		ip, err := netip.ParseAddr(address.Hostname())
		if err != nil || !ip.Is6() {
			return "", errors.New("方括号内必须是有效的 IPv6 地址")
		}
	} else if strings.Contains(address.Hostname(), ":") {
		return "", errors.New("IPv6 地址需要使用方括号，例如 http://[::1]:8080")
	}
	if strings.HasSuffix(address.Host, ":") {
		return "", errors.New("端口不能为空")
	}
	if port := address.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", errors.New("端口必须是 1 到 65535 的整数")
		}
	}
	return address.String(), nil
}

func readFields(path string) (map[string]json.RawMessage, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return make(map[string]json.RawMessage), nil
	}
	if err != nil {
		return nil, fmt.Errorf("无法读取配置文件：%w", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, errors.New("现有配置文件不是有效的 JSON 对象，请修复后重试")
	}
	return fields, nil
}

func Server(path string) (string, error) {
	fields, err := readFields(path)
	if err != nil {
		return "", err
	}
	return serverFromFields(fields)
}

func serverFromFields(fields map[string]json.RawMessage) (string, error) {
	raw, exists := fields[serverKey]
	if !exists {
		return "", nil
	}
	var server string
	if err := json.Unmarshal(raw, &server); err != nil {
		return "", errors.New("现有配置的 server_url 必须是字符串，请修复后重试")
	}
	return server, nil
}

// SaveServer preserves other settings and clears authentication when the backend changes.
func SaveServer(path, value string) error {
	server, err := NormalizeServerURL(value)
	if err != nil {
		return err
	}
	fields, err := readFields(path)
	if err != nil {
		return err
	}
	previous, err := serverFromFields(fields)
	if err != nil {
		return err
	}
	previous, _ = NormalizeServerURL(previous)
	if previous != server {
		delete(fields, "login")
	}
	fields[serverKey], err = json.Marshal(server)
	if err != nil {
		return fmt.Errorf("无法编码后端请求地址：%w", err)
	}
	return writeFields(path, fields)
}

func writeFields(path string, fields map[string]json.RawMessage) error {
	data, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return fmt.Errorf("无法编码配置文件：%w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("无法创建配置目录：%w", err)
	}
	temp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("无法创建临时配置文件：%w", err)
	}
	defer func() {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
	}()
	if _, err := temp.Write(data); err != nil {
		return fmt.Errorf("无法写入配置文件：%w", err)
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("无法同步配置文件：%w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("无法关闭配置文件：%w", err)
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		return fmt.Errorf("无法替换配置文件，原配置已保留：%w", err)
	}
	return nil
}
