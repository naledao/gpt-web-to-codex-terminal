package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"web2term/agent/internal/auth"
)

type AgentSettings struct {
	ServerURL  string
	Login      LoginInfo
	DeviceID   string
	DeviceName string
}

// AgentConfig validates authentication before creating persistent device fields.
// A device ID is never regenerated on authentication rejection or reconnect.
func AgentConfig(path string, now time.Time, hostname string) (AgentSettings, error) {
	fields, err := readFields(path)
	if err != nil {
		return AgentSettings{}, err
	}
	server, err := serverFromFields(fields)
	if err != nil {
		return AgentSettings{}, err
	}
	server, err = NormalizeServerURL(server)
	if err != nil {
		return AgentSettings{}, errors.New("请先运行 web2term set server 配置后端请求地址")
	}
	var login LoginInfo
	if err := json.Unmarshal(fields["login"], &login); err != nil {
		return AgentSettings{}, errors.New("请先运行 web2term login 登录")
	}
	loginServer, err := NormalizeServerURL(login.ServerURL)
	if err != nil || loginServer != server {
		return AgentSettings{}, errors.New("登录信息与当前后端地址不一致，请重新运行 web2term login")
	}
	response := auth.LoginResponse{AccessToken: login.AccessToken, TokenType: login.TokenType, ExpiresInSeconds: login.ExpiresInSeconds, User: login.User}
	if response.Validate() != nil || login.LoggedInAt.IsZero() || login.ExpiresAt.IsZero() {
		return AgentSettings{}, errors.New("本地登录信息无效，请重新运行 web2term login")
	}
	if !now.Before(login.ExpiresAt) {
		return AgentSettings{}, errors.New("登录已过期，请重新运行 web2term login")
	}
	var id, name string
	changed := false
	if raw, exists := fields["device_id"]; exists {
		if json.Unmarshal(raw, &id) != nil || !validUUID(id) {
			return AgentSettings{}, errors.New("配置中的 device_id 不是有效的 UUID，请修复配置；工具不会自动更换设备标识")
		}
		if strings.ToLower(id) != id {
			id, changed = strings.ToLower(id), true
		}
	} else {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return AgentSettings{}, errors.New("无法生成设备 UUID")
		}
		random[6] = (random[6] & 0x0f) | 0x40
		random[8] = (random[8] & 0x3f) | 0x80
		hexID := hex.EncodeToString(random[:])
		id = hexID[:8] + "-" + hexID[8:12] + "-" + hexID[12:16] + "-" + hexID[16:20] + "-" + hexID[20:]
		changed = true
	}
	if raw, exists := fields["device_name"]; exists {
		if json.Unmarshal(raw, &name) != nil || !validDeviceName(name) {
			return AgentSettings{}, errors.New("配置中的 device_name 必须为 1 到 100 个可打印 ASCII 字符，以用于设备握手请求头")
		}
	} else {
		name = strings.TrimSpace(hostname)
		if !validDeviceName(name) {
			name = "agent-" + id[:8]
		}
		changed = true
	}
	if changed {
		fields["device_id"], _ = json.Marshal(id)
		fields["device_name"], _ = json.Marshal(name)
		if err := writeFields(path, fields); err != nil {
			return AgentSettings{}, fmt.Errorf("无法保存设备标识：%w", err)
		}
	}
	return AgentSettings{ServerURL: server, Login: login, DeviceID: id, DeviceName: name}, nil
}

func validUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	decoded, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	return err == nil && len(decoded) == 16
}

func validDeviceName(value string) bool {
	return len(value) > 0 && len(value) <= 100 && strings.TrimSpace(value) == value && !strings.ContainsFunc(value, func(r rune) bool { return r < 32 || r >= 127 })
}
