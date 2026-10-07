package terminal

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

const (
	Version      = 1
	MaxSessions  = 3
	MaxDataBytes = 16 * 1024
	DefaultCols  = 120
	DefaultRows  = 30
	MaxDimension = 1000
)

type Envelope struct {
	Version   int             `json:"version"`
	Type      string          `json:"type"`
	SessionID string          `json:"session_id,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type Message struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	SessionID string `json:"session_id,omitempty"`
	Payload   any    `json:"payload"`
}

type Size struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}
type Data struct {
	Data string `json:"data"`
}
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Exit struct {
	ExitCode int    `json:"exit_code"`
	Signal   string `json:"signal,omitempty"`
	Reason   string `json:"reason"`
}
type Ready struct {
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
	Shell string `json:"shell"`
}

func packet(kind, id string, payload any) Message {
	return Message{Version: Version, Type: kind, SessionID: id, Payload: payload}
}

func validSessionID(id string) bool {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' || id != strings.ToLower(id) {
		return false
	}
	decoded, err := hex.DecodeString(strings.ReplaceAll(id, "-", ""))
	return err == nil && len(decoded) == 16
}

func payload(data json.RawMessage, value any) error {
	if len(bytes.TrimSpace(data)) == 0 || bytes.TrimSpace(data)[0] != '{' {
		return errors.New("payload must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("extra payload data")
	}
	return nil
}

func validSize(size Size) bool {
	return size.Cols >= 1 && size.Cols <= MaxDimension && size.Rows >= 1 && size.Rows <= MaxDimension
}

func decodeData(encoded string) ([]byte, error) {
	if len(encoded) > base64.StdEncoding.EncodedLen(MaxDataBytes) {
		return nil, errors.New("input too large")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) > MaxDataBytes {
		return nil, errors.New("invalid input data")
	}
	return data, nil
}
