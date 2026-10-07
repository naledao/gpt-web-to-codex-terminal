//go:build !linux

package daemon

import "errors"

func unsupported() error               { return errors.New("当前版本的后台运行仅支持 Linux x86_64") }
func Start(string) (Info, bool, error) { return Info{}, false, unsupported() }
func Inspect(string) (Info, error)     { return Info{}, unsupported() }
func Stop(string) (bool, error)        { return false, unsupported() }
func Worker(string, string) error      { return unsupported() }
