package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/coder/websocket"
	"web2term/agent/internal/config"
	"web2term/agent/internal/diagnostic"
)

type Connection interface {
	Read(context.Context) (websocket.MessageType, []byte, error)
	Write(context.Context, websocket.MessageType, []byte) error
	Close(websocket.StatusCode, string) error
	CloseNow() error
}

type DialFunc func(context.Context, config.AgentSettings) (Connection, *Failure)

type Failure struct {
	Message   string
	Retry     bool
	Status    int
	CloseCode int
	Cause     error
}

func (failure *Failure) Error() string { return failure.Message }
func (failure *Failure) Unwrap() error { return failure.Cause }

func WebSocketURL(server string) (string, error) {
	server, err := config.NormalizeServerURL(server)
	if err != nil {
		return "", err
	}
	address, _ := url.Parse(server)
	address = address.JoinPath("ws/agent")
	if address.Scheme == "https" {
		address.Scheme = "wss"
	} else {
		address.Scheme = "ws"
	}
	return address.String(), nil
}

func HTTPClient() *http.Client {
	// No total HTTP timeout: the upgraded connection must outlive the handshake.
	// Do not forward the JWT or device headers to a redirected address.
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func DialWithClient(client *http.Client) DialFunc {
	return func(ctx context.Context, settings config.AgentSettings) (Connection, *Failure) {
		address, err := WebSocketURL(settings.ServerURL)
		if err != nil {
			return nil, &Failure{Message: "后端地址无效，请运行 web2term set server", Cause: err}
		}
		headers := http.Header{}
		headers.Set("Authorization", "Bearer "+settings.Login.AccessToken)
		headers.Set("X-Device-Id", settings.DeviceID)
		headers.Set("X-Device-Name", settings.DeviceName)
		conn, response, err := websocket.Dial(ctx, address, &websocket.DialOptions{HTTPClient: client, HTTPHeader: headers})
		if err != nil {
			status := 0
			if response != nil {
				status = response.StatusCode
			}
			return nil, handshakeFailure(status, err)
		}
		conn.SetReadLimit(64 * 1024)
		return conn, nil
	}
}

func handshakeFailure(status int, err error) *Failure {
	failure := &Failure{Status: status, Cause: err, Retry: true}
	switch status {
	case http.StatusUnauthorized:
		failure.Message, failure.Retry = "登录凭据被服务端拒绝，请重新运行 web2term login", false
	case http.StatusForbidden:
		failure.Message, failure.Retry = "设备已禁用或属于其他用户，服务端拒绝连接", false
	case http.StatusBadRequest:
		failure.Message, failure.Retry = "服务端拒绝设备握手参数（HTTP 400），请查看诊断日志并检查设备配置", false
	case http.StatusNotFound:
		failure.Message, failure.Retry = "找不到 /ws/agent，请检查后端基础地址和上下文路径（HTTP 404）", false
	case http.StatusSwitchingProtocols:
		failure.Message, failure.Retry = "WebSocket 升级响应不符合协议，请检查服务端握手响应", false
	default:
		if status >= 300 && status < 400 {
			failure.Message, failure.Retry = "服务端返回重定向，请配置最终后端地址；工具不会转发登录凭据", false
		} else if status != 0 {
			failure.Message = fmt.Sprintf("WebSocket 握手失败（HTTP %d）", status)
			failure.Retry = status >= 500 || status == 429 || status == 408
		} else {
			info := diagnostic.DescribeError(err)
			failure.Message = "连接服务端失败：" + info.Detail
			switch info.Kind {
			case "tls_unknown_authority", "tls_hostname_mismatch", "tls_certificate_invalid", "http_https_mismatch", "duplicate_transfer_encoding", "unsupported_transfer_encoding", "invalid_content_length", "invalid_http_response":
				failure.Retry = false
			}
		}
	}
	return failure
}

func connectionFailure(err error) *Failure {
	code := int(websocket.CloseStatus(err))
	failure := &Failure{Cause: err, Retry: true}
	if code >= 0 {
		failure.CloseCode = code
		failure.Message = fmt.Sprintf("服务端关闭了设备连接（WebSocket %d）", code)
		switch websocket.StatusCode(code) {
		case websocket.StatusNormalClosure:
			failure.Message = "服务端正常关闭了连接；同一设备启动新连接时也会关闭旧连接，请确认只运行一个实例"
			failure.Retry = false
		case websocket.StatusPolicyViolation:
			failure.Message, failure.Retry = "设备连接被服务端拒绝或撤销（WebSocket 1008）", false
		case websocket.StatusProtocolError, websocket.StatusUnsupportedData, websocket.StatusInvalidFramePayloadData, websocket.StatusMessageTooBig:
			failure.Message, failure.Retry = fmt.Sprintf("设备通信协议被服务端拒绝（WebSocket %d）", code), false
		}
	} else if errors.Is(err, websocket.ErrMessageTooBig) {
		failure.Message, failure.Retry = "服务端消息超过 64 KiB，工具已停止连接", false
	} else {
		failure.Message = "设备连接中断：" + diagnostic.DescribeError(err).Detail
	}
	return failure
}
