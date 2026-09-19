// Package main is the runner inside the natsumi tools container (ADR 0011).
//
// It listens on a Unix socket that natsumi reaches through a shared volume, runs each command with `sh -c` in the
// memory directory, and answers with the exit code, stdout and stderr, cut at a time limit and an output limit.
// The container itself provides the confinement: no network, no secrets, only the memory directory, whose .git is
// mounted read-only over it so the history cannot be rewritten from here (ADR 0018).
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// MaxRequestBytes bounds one request line. natsumi caps a command at 8000 characters (ADR 0018), and a command
// written in Japanese is three bytes per character, so the line it sends can be well over 16 KiB.
const MaxRequestBytes = 64 << 10

// Limits are fixed when the runner starts; a request cannot change them.
type Limits struct {
	Shell     string
	Path      string
	Dir       string
	Timeout   time.Duration
	MaxOutput int
}

// Result is the answer to a command that was run. ExitCode is nil when a signal stopped the shell.
type Result struct {
	ExitCode        *int   `json:"exitCode"`
	Signal          string `json:"signal,omitempty"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
	TimedOut        bool   `json:"timedOut"`
	TimeoutMs       int64  `json:"timeoutMs"`
}

type refusal struct {
	Error string `json:"error"`
}

// capped keeps the first max bytes written and remembers whether more came.
type capped struct {
	buffer    bytes.Buffer
	max       int
	truncated bool
}

func (c *capped) Write(p []byte) (int, error) {
	room := c.max - c.buffer.Len()
	switch {
	case room >= len(p):
		c.buffer.Write(p)
	case room > 0:
		c.buffer.Write(p[:room])
		c.truncated = true
	case len(p) > 0:
		c.truncated = true
	}
	return len(p), nil
}

// Run runs one command in its own process group. At the time limit the whole group is killed; after the shell
// exits, anything it left in the background is killed too, so no command outlives its answer.
func Run(command string, limits Limits) Result {
	ctx, cancel := context.WithTimeout(context.Background(), limits.Timeout)
	defer cancel()
	stdout := &capped{max: limits.MaxOutput}
	stderr := &capped{max: limits.MaxOutput}
	cmd := exec.CommandContext(ctx, limits.Shell, "-c", command)
	cmd.Dir = limits.Dir
	// Nothing from the runner's own environment reaches the command.
	cmd.Env = []string{"PATH=" + limits.Path}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	// A background child holding the output open must not keep the answer waiting.
	cmd.WaitDelay = 200 * time.Millisecond

	result := Result{TimeoutMs: limits.Timeout.Milliseconds()}
	if err := cmd.Start(); err != nil {
		code := 127
		result.ExitCode = &code
		result.Stderr = "the shell could not be started\n"
		return result
	}
	_ = cmd.Wait()
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)

	result.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
	if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		result.Signal = status.Signal().String()
	} else {
		code := cmd.ProcessState.ExitCode()
		result.ExitCode = &code
	}
	result.Stdout = strings.ToValidUTF8(stdout.buffer.String(), "�")
	result.Stderr = strings.ToValidUTF8(stderr.buffer.String(), "�")
	result.StdoutTruncated = stdout.truncated
	result.StderrTruncated = stderr.truncated
	return result
}

// Listen takes over the socket path, then makes the socket connectable by its peer and its directory read-only, so a
// command running as the same user cannot remove or replace the socket.
func Listen(path string) (net.Listener, error) {
	directory := filepath.Dir(path)
	if err := os.Chmod(directory, 0o755); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o666); err != nil {
		_ = listener.Close()
		return nil, err
	}
	if err := os.Chmod(directory, 0o555); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

// Server answers one JSON request line per connection and runs one command at a time.
type Server struct {
	Limits Limits
	mu     sync.Mutex
}

func (s *Server) Serve(listener net.Listener) error {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go s.handle(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	line, _ := bufio.NewReader(io.LimitReader(conn, MaxRequestBytes+1)).ReadBytes('\n')
	var answer any
	var request struct {
		Command string `json:"command"`
	}
	switch {
	case len(line) > MaxRequestBytes:
		answer = refusal{Error: "request too large"}
	case !bytes.HasSuffix(line, []byte("\n")):
		answer = refusal{Error: "request must be one JSON line"}
	case json.Unmarshal(line, &request) != nil:
		answer = refusal{Error: "request is not JSON"}
	case strings.TrimSpace(request.Command) == "":
		answer = refusal{Error: "command is empty"}
	default:
		s.mu.Lock()
		answer = Run(request.Command, s.Limits)
		s.mu.Unlock()
	}
	encoded, _ := json.Marshal(answer)
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Write(append(encoded, '\n'))
}

// Check asks the runner at path to run a no-op, for the container's healthcheck.
func Check(path string, timeout time.Duration) error {
	conn, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write([]byte(`{"command":":"}` + "\n")); err != nil {
		return err
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return err
	}
	var result Result
	if err := json.Unmarshal(line, &result); err != nil {
		return err
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		return fmt.Errorf("the runner did not run the check command")
	}
	return nil
}
