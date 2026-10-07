package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"web2term/agent/internal/auth"
)

type LoginInfo struct {
	ServerURL        string    `json:"server_url"`
	AccessToken      string    `json:"access_token"`
	TokenType        string    `json:"token_type"`
	ExpiresInSeconds int64     `json:"expires_in_seconds"`
	LoggedInAt       time.Time `json:"logged_in_at"`
	ExpiresAt        time.Time `json:"expires_at"`
	User             auth.User `json:"user"`
}

// SaveLogin binds the credentials to the backend used for this login attempt.
// A cancelled/failed request never calls this method, leaving the old login intact.
func SaveLogin(path, server string, response auth.LoginResponse, receivedAt time.Time) error {
	if err := response.Validate(); err != nil {
		return err
	}
	server, err := NormalizeServerURL(server)
	if err != nil {
		return err
	}
	fields, err := readFields(path)
	if err != nil {
		return err
	}
	current, err := serverFromFields(fields)
	if err != nil {
		return err
	}
	current, err = NormalizeServerURL(current)
	if err != nil || current != server {
		return errors.New("登录过程中后端地址已变更，登录信息未保存，请重新运行 web2term login")
	}
	loggedInAt := receivedAt.UTC()
	info := LoginInfo{
		ServerURL: server, AccessToken: response.AccessToken, TokenType: response.TokenType,
		ExpiresInSeconds: response.ExpiresInSeconds, LoggedInAt: loggedInAt,
		ExpiresAt: loggedInAt.Add(time.Duration(response.ExpiresInSeconds) * time.Second),
		User:      response.User,
	}
	fields["login"], err = json.Marshal(info)
	if err != nil {
		return fmt.Errorf("无法编码登录信息：%w", err)
	}
	return writeFields(path, fields)
}
