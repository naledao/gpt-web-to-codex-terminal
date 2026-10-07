package diagnostic

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"syscall"
)

type ErrorInfo struct {
	Kind   string   `json:"kind"`
	Detail string   `json:"detail"`
	Types  []string `json:"types"`
}

// DescribeError keeps the underlying error category and type chain without
// copying err.Error(): HTTP parser errors can contain raw headers or body bytes,
// and url.Error can contain a URL with proxy credentials.
func DescribeError(err error) *ErrorInfo {
	if err == nil {
		return nil
	}
	info := &ErrorInfo{Kind: "unclassified", Detail: "错误文本已省略，保留错误类型以避免记录凭据或响应内容"}
	for cause, depth := err, 0; cause != nil && depth < 12; cause, depth = errors.Unwrap(cause), depth+1 {
		info.Types = append(info.Types, fmt.Sprintf("%T", cause))
	}
	set := func(kind, detail string) *ErrorInfo {
		info.Kind, info.Detail = kind, detail
		return info
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return set("timeout", "请求超时（context deadline exceeded）")
	case errors.Is(err, context.Canceled):
		return set("cancelled", "请求已取消（context canceled）")
	case errors.Is(err, io.ErrUnexpectedEOF):
		return set("unexpected_eof", "响应尚未完整接收，连接已关闭（unexpected EOF）")
	case errors.Is(err, io.EOF):
		return set("eof", "对端关闭了连接（EOF）")
	case errors.Is(err, syscall.ECONNREFUSED):
		return set("connection_refused", "连接被拒绝（connection refused）")
	case errors.Is(err, syscall.ECONNRESET):
		return set("connection_reset", "连接被对端重置（connection reset by peer）")
	case errors.Is(err, syscall.EPIPE):
		return set("broken_pipe", "向已关闭的连接发送数据（broken pipe）")
	case errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return set("network_unreachable", "主机或网络不可达（host/network unreachable）")
	case errors.Is(err, syscall.ETIMEDOUT):
		return set("timeout", "连接超时（connection timed out）")
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return set("dns_error", "DNS 名称解析失败")
	}
	var untrusted x509.UnknownAuthorityError
	if errors.As(err, &untrusted) {
		return set("tls_unknown_authority", "TLS 证书颁发者不受信任")
	}
	var hostname x509.HostnameError
	if errors.As(err, &hostname) {
		return set("tls_hostname_mismatch", "TLS 证书与后端主机名不匹配")
	}
	var invalid x509.CertificateInvalidError
	if errors.As(err, &invalid) {
		return set("tls_certificate_invalid", "TLS 证书无效")
	}
	var record tls.RecordHeaderError
	if errors.As(err, &record) {
		return set("tls_record_error", "TLS 握手收到无效的数据记录")
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return set("timeout", "网络操作超时")
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return set("os_error", fmt.Sprintf("操作系统网络或文件错误（errno=%d）", errno))
	}
	// Only constant categories are emitted, even if the matching message includes
	// a server-supplied header, redirect URL, or malformed HTTP status line.
	for cause, depth := err, 0; cause != nil && depth < 12; cause, depth = errors.Unwrap(cause), depth+1 {
		message := cause.Error()
		switch {
		case strings.Contains(message, "too many transfer encodings"):
			return set("duplicate_transfer_encoding", "响应包含多个 Transfer-Encoding 值，HTTP 客户端拒绝解析")
		case strings.Contains(message, "unsupported transfer encoding"):
			return set("unsupported_transfer_encoding", "响应使用不支持的 Transfer-Encoding，原始值未记录")
		case strings.Contains(message, "multiple Content-Length"), strings.Contains(message, "bad Content-Length"), strings.Contains(message, "conflicting Content-Length"):
			return set("invalid_content_length", "响应的 Content-Length 无效或冲突，原始值未记录")
		case strings.Contains(message, "malformed HTTP"), strings.Contains(message, "malformed MIME"), strings.Contains(message, "invalid header"):
			return set("invalid_http_response", "收到无效的 HTTP 状态行或响应头，原始内容未记录")
		case strings.Contains(message, "server gave HTTP response to HTTPS client"):
			return set("http_https_mismatch", "HTTPS 请求收到 HTTP 响应，请检查后端协议")
		case strings.Contains(message, "proxyconnect"):
			return set("proxy_error", "连接代理失败")
		}
	}
	return info
}
