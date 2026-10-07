package agent

import (
	"context"
	"fmt"
	"io"
	"math/rand/v2"
	"time"

	"web2term/agent/internal/config"
	"web2term/agent/internal/diagnostic"
	"web2term/agent/internal/terminal"
)

type Options struct {
	HandshakeTimeout  time.Duration
	HeartbeatInterval time.Duration
	AckTimeout        time.Duration
	WriteTimeout      time.Duration
	RetryMin          time.Duration
	RetryMax          time.Duration
}

func DefaultOptions() Options {
	return Options{HandshakeTimeout: 10 * time.Second, HeartbeatInterval: 20 * time.Second, AckTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, RetryMin: time.Second, RetryMax: 30 * time.Second}
}

type Runner struct {
	Dial            DialFunc
	Options         Options
	Output          io.Writer
	Log             *diagnostic.Log
	Sleep           func(context.Context, time.Duration) error
	Jitter          func(time.Duration) time.Duration
	OnState         func(state, detail string)
	OnTerminalCount func(int)
	TerminalFactory terminal.Factory
}

func New(output io.Writer, log *diagnostic.Log) *Runner {
	return &Runner{Dial: DialWithClient(HTTPClient()), Options: DefaultOptions(), Output: output, Log: log, Sleep: sleep, Jitter: jitter}
}

func (runner *Runner) Run(ctx context.Context, settings config.AgentSettings) error {
	ctx, stop := context.WithDeadline(ctx, settings.Login.ExpiresAt)
	defer stop()
	delay := runner.Options.RetryMin
	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			return stopped(ctx)
		}
		runner.Log.Record(diagnostic.Entry{Event: "agent_connect_started", Phase: "agent", Attempt: attempt, TimeoutMS: runner.Options.HandshakeTimeout.Milliseconds()})
		runner.state("connecting", "")
		if _, err := fmt.Fprintln(runner.Output, "正在连接服务端……"); err != nil {
			return err
		}
		started := time.Now()
		dialCtx, cancel := context.WithTimeout(ctx, runner.Options.HandshakeTimeout)
		conn, failure := runner.Dial(dialCtx, settings)
		cancel()
		var healthy bool
		if failure == nil {
			runner.Log.Record(diagnostic.Entry{Event: "agent_connected", Phase: "agent", Status: 101, Attempt: attempt, ElapsedMS: time.Since(started).Milliseconds()})
			failure, healthy = runner.serve(ctx, conn)
			if healthy {
				delay = runner.Options.RetryMin
			}
		}
		if ctx.Err() != nil {
			return stopped(ctx)
		}
		if failure == nil {
			return nil
		}
		runner.Log.Record(diagnostic.Entry{Event: "agent_connection_failed", Phase: "agent", Attempt: attempt, Status: failure.Status, CloseCode: failure.CloseCode, Error: diagnostic.DescribeError(failure.Cause)})
		if !failure.Retry {
			return failure
		}
		runner.state("reconnecting", failure.Message)
		wait := runner.Jitter(delay)
		runner.Log.Record(diagnostic.Entry{Event: "agent_reconnect_scheduled", Phase: "agent", DelayMS: wait.Milliseconds()})
		if _, err := fmt.Fprintf(runner.Output, "%s；%.1f 秒后重连。\n", failure, wait.Seconds()); err != nil {
			return err
		}
		if err := runner.Sleep(ctx, wait); err != nil {
			return stopped(ctx)
		}
		delay *= 2
		if delay > runner.Options.RetryMax {
			delay = runner.Options.RetryMax
		}
	}
}

func (runner *Runner) state(state, detail string) {
	if runner.OnState != nil {
		runner.OnState(state, detail)
	}
}

func stopped(ctx context.Context) error {
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("登录已过期，设备连接已停止，请重新运行 web2term login 后再运行 web2term run")
	}
	return nil
}

func sleep(ctx context.Context, wait time.Duration) error {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func jitter(delay time.Duration) time.Duration {
	return time.Duration(float64(delay) * (0.8 + 0.2*rand.Float64()))
}
