package terminal

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestProtocolBounds(t *testing.T) {
	if !validSessionID("550e8400-e29b-41d4-a716-446655440000") {
		t.Fatal("valid UUID rejected")
	}
	for _, id := range []string{"550E8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-44665544-000", "../session"} {
		if validSessionID(id) {
			t.Fatal("invalid UUID accepted")
		}
	}
	want := bytes.Repeat([]byte{0xff}, MaxDataBytes)
	got, err := decodeData(base64.StdEncoding.EncodeToString(want))
	if err != nil || !bytes.Equal(got, want) {
		t.Fatal("maximum input rejected or changed")
	}
	if _, err := decodeData(base64.StdEncoding.EncodeToString(append(want, 0))); err == nil {
		t.Fatal("oversized input accepted")
	}
	if _, err := decodeData("Zh=="); err == nil {
		t.Fatal("non-canonical trailing bits accepted")
	}
	for _, raw := range []string{`null`, `[]`, `{"cols":80,"command":"bad"}`, `{} {}`} {
		if payload(json.RawMessage(raw), new(Size)) == nil {
			t.Fatal("malformed/unknown payload accepted")
		}
	}
}
