package diagnostic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

func TestPrivateLogFileAndSynchronousRecords(t *testing.T) {
	log, err := Open(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	log.Record(Entry{Event: "request_started", Phase: "login", RequestID: 2})
	data, err := os.ReadFile(log.Path())
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatal("records were not available before Close")
	}
	for _, line := range lines {
		var entry Entry
		if err := json.Unmarshal([]byte(line), &entry); err != nil || entry.Time.IsZero() || entry.Time.Location().String() != "UTC" {
			t.Fatal("record is not valid JSON with a UTC timestamp")
		}
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(log.Path())
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatal("log permissions are not 0600")
		}
	}
}

func TestWriteFailureWarnsOnce(t *testing.T) {
	var warnings bytes.Buffer
	log, err := Open(t.TempDir(), &warnings)
	if err != nil {
		t.Fatal(err)
	}
	_ = log.file.Close()
	log.Record(Entry{Event: "request_started"})
	log.Record(Entry{Event: "request_failed"})
	log.Close()
	if strings.Count(warnings.String(), "诊断日志写入失败") != 1 {
		t.Fatal("write failure should emit one warning")
	}
}

func TestErrorCategoriesAndSecretRedaction(t *testing.T) {
	const secret = "fixture-private-token-and-email@example.invalid"
	tests := []struct {
		name string
		err  error
		kind string
	}{
		{"eof", &url.Error{Op: "Post", URL: "http://user:" + secret + "@proxy/?token=" + secret, Err: io.EOF}, "eof"},
		{"incomplete", io.ErrUnexpectedEOF, "unexpected_eof"},
		{"timeout", context.DeadlineExceeded, "timeout"},
		{"reset", &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}, "connection_reset"},
		{"refused", syscall.ECONNREFUSED, "connection_refused"},
		{"dns", &net.DNSError{Err: secret, Name: secret}, "dns_error"},
		{"invalid-header", errors.New("malformed MIME header line: " + secret), "invalid_http_response"},
		{"duplicate-encoding", errors.New("too many transfer encodings: " + secret), "duplicate_transfer_encoding"},
		{"unsupported-encoding", errors.New("unsupported transfer encoding: " + secret), "unsupported_transfer_encoding"},
		{"conflicting-length", errors.New("http: message cannot contain multiple Content-Length headers; got " + secret), "invalid_content_length"},
		{"unknown", errors.New(secret), "unclassified"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			info := DescribeError(test.err)
			if info.Kind != test.kind || len(info.Types) == 0 {
				t.Fatal("incorrect underlying error category or missing type chain")
			}
			data, _ := json.Marshal(info)
			if strings.Contains(string(data), secret) {
				t.Fatal("error metadata contains credentials or server-supplied text")
			}
		})
	}
}
