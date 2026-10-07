//go:build !linux

package terminal

import "errors"

func DefaultFactory(Size) (Process, error) {
	return nil, errors.New("PTY currently supports Linux only")
}
