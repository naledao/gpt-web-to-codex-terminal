package terminal

import "io"

// Process methods must support concurrent reading/writing; Close unblocks I/O.
type Process interface {
	io.ReadWriteCloser
	Resize(Size) error
	Wait() (Exit, error)
	Terminate() error
	Kill() error
	Shell() string
}

type Factory func(Size) (Process, error)
