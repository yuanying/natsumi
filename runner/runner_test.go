package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The host's own shell and tools stand in for the sandbox's.
func limits(t *testing.T) Limits {
	t.Helper()
	return Limits{Shell: "/bin/sh", Path: "/usr/bin:/bin", Dir: t.TempDir(), Timeout: 5 * time.Second, MaxOutput: 1 << 16}
}

func TestRunReturnsTheExitCodeAndStderr(t *testing.T) {
	result := Run("echo out; echo err >&2; exit 3", limits(t))
	if result.ExitCode == nil || *result.ExitCode != 3 {
		t.Fatalf("exit code = %v, want 3", result.ExitCode)
	}
	if result.Stdout != "out\n" || result.Stderr != "err\n" {
		t.Fatalf("stdout %q stderr %q", result.Stdout, result.Stderr)
	}
	if result.TimedOut || result.StdoutTruncated || result.StderrTruncated || result.Signal != "" {
		t.Fatalf("unexpected flags: %+v", result)
	}
}

func TestRunStopsAtTheTimeLimitWithEveryChild(t *testing.T) {
	l := limits(t)
	l.Timeout = 300 * time.Millisecond
	started := time.Now()
	result := Run("echo before; tail -f /dev/null & tail -f /dev/null", l)
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("took %v, want the time limit to stop it", elapsed)
	}
	if !result.TimedOut || result.ExitCode != nil || result.Signal == "" {
		t.Fatalf("want a timed-out, killed result: %+v", result)
	}
	if result.Stdout != "before\n" {
		t.Fatalf("output before the limit is kept, got %q", result.Stdout)
	}
	if result.TimeoutMs != 300 {
		t.Fatalf("timeoutMs = %d", result.TimeoutMs)
	}
}

func TestRunDoesNotWaitForBackgroundChildrenAfterTheShellExits(t *testing.T) {
	started := time.Now()
	result := Run("tail -f /dev/null & echo done", limits(t))
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("took %v; a background child must not hold the command open", elapsed)
	}
	if result.TimedOut || result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "done\n" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestRunCutsOutputAtTheLimit(t *testing.T) {
	l := limits(t)
	l.MaxOutput = 100
	result := Run(`i=0; while [ $i -lt 2000 ]; do echo 0123456789; echo abcdefghij >&2; i=$((i+1)); done`, l)
	if len(result.Stdout) != 100 || !result.StdoutTruncated {
		t.Fatalf("stdout %d bytes, truncated %v", len(result.Stdout), result.StdoutTruncated)
	}
	if len(result.Stderr) != 100 || !result.StderrTruncated {
		t.Fatalf("stderr %d bytes, truncated %v", len(result.Stderr), result.StderrTruncated)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("the command still runs to its end: %+v", result.ExitCode)
	}
}

func TestRunGivesNoEnvironmentNoInputAndTheMemoryDirectory(t *testing.T) {
	t.Setenv("NATSUMI_FAKE_SECRET", "must-not-leak")
	l := limits(t)
	result := Run("env; pwd; cat", l)
	// PWD is the working directory os/exec sets, not something taken from the runner's environment.
	want := "PATH=/usr/bin:/bin\nPWD=" + l.Dir + "\n" + l.Dir + "\n"
	if result.Stdout != want {
		t.Fatalf("stdout %q, want %q", result.Stdout, want)
	}
}

func startServer(t *testing.T, l Limits) string {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "socket")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(directory, 0o755) })
	path := filepath.Join(directory, "runner.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() { _ = (&Server{Limits: l}).Serve(listener) }()
	return path
}

func ask(t *testing.T, path string, request string) map[string]any {
	t.Helper()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		t.Fatalf("no answer: %v", err)
	}
	var answer map[string]any
	if err := json.Unmarshal(line, &answer); err != nil {
		t.Fatalf("answer is not JSON: %q", line)
	}
	return answer
}

func TestServeAnswersOneJSONLineOverTheUnixSocket(t *testing.T) {
	path := startServer(t, limits(t))
	answer := ask(t, path, `{"command":"echo hi; echo oops >&2; exit 4"}`+"\n")
	if answer["exitCode"] != float64(4) || answer["stdout"] != "hi\n" || answer["stderr"] != "oops\n" || answer["timedOut"] != false {
		t.Fatalf("answer: %v", answer)
	}
}

func TestListenLeavesTheSocketDirectoryReadOnlyAndTheSocketOpenToItsPeer(t *testing.T) {
	path := startServer(t, limits(t))
	info, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o555 {
		t.Fatalf("socket directory mode %o, want 555 so commands cannot remove or replace the socket", info.Mode().Perm())
	}
	socket, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if socket.Mode()&os.ModeSocket == 0 || socket.Mode().Perm() != 0o666 {
		t.Fatalf("socket mode %v", socket.Mode())
	}
}

func TestListenReplacesAStaleSocket(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "socket")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(directory, 0o755) })
	path := filepath.Join(directory, "runner.sock")
	first, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	first.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = first.Close()
	second, err := Listen(path)
	if err != nil {
		t.Fatalf("a restarted runner must take over its old socket: %v", err)
	}
	_ = second.Close()
}

func TestServeRefusesMalformedAndOversizedRequests(t *testing.T) {
	path := startServer(t, limits(t))
	if answer := ask(t, path, "not json\n"); answer["error"] == nil || answer["exitCode"] != nil {
		t.Fatalf("malformed: %v", answer)
	}
	if answer := ask(t, path, `{"command":""}`+"\n"); answer["error"] == nil {
		t.Fatalf("empty command: %v", answer)
	}
	if answer := ask(t, path, `{"command":"`+strings.Repeat("a", MaxRequestBytes)+`"}`+"\n"); answer["error"] == nil {
		t.Fatalf("oversized: %v", answer)
	}
}

func TestServeRunsOneCommandAtATime(t *testing.T) {
	l := limits(t)
	path := startServer(t, l)
	marker := filepath.Join(l.Dir, "running")
	// Each command fails if it finds the other one running.
	command := `if [ -e running ]; then echo overlap; exit 9; fi; : > running; i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done; rm running`
	done := make(chan map[string]any, 2)
	for range 2 {
		go func() { done <- ask(t, path, `{"command":`+quote(command)+`}`+"\n") }()
	}
	for range 2 {
		if answer := <-done; answer["exitCode"] != float64(0) {
			t.Fatalf("commands overlapped: %v", answer)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("marker left behind: %v", err)
	}
}

func TestCheckSucceedsOnlyWhileTheRunnerAnswers(t *testing.T) {
	path := startServer(t, limits(t))
	if err := Check(path, 5*time.Second); err != nil {
		t.Fatalf("check: %v", err)
	}
	if err := Check(filepath.Join(t.TempDir(), "missing.sock"), time.Second); err == nil {
		t.Fatal("check must fail without a runner")
	}
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
