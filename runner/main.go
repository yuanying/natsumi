package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const usage = `usage:
  natsumi-tools-runner serve [flags]   run commands sent over the Unix socket
  natsumi-tools-runner check [flags]   exit 0 only while the runner answers (for the healthcheck)`

func main() {
	if len(os.Args) < 2 {
		fail(usage)
	}
	switch os.Args[1] {
	case "serve":
		serve(os.Args[2:])
	case "check":
		flags := flag.NewFlagSet("check", flag.ExitOnError)
		socket := flags.String("socket", "/run/natsumi-tools/runner.sock", "the runner's Unix socket")
		_ = flags.Parse(os.Args[2:])
		if err := Check(*socket, 5*time.Second); err != nil {
			fail(fmt.Sprintf("natsumi-tools-runner: check failed: %v", err))
		}
	default:
		fail(usage)
	}
}

func serve(args []string) {
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	socket := flags.String("socket", "/run/natsumi-tools/runner.sock", "the Unix socket to listen on")
	dir := flags.String("dir", "/memory", "the working directory of every command")
	shell := flags.String("shell", "/bin/sh", "the shell that runs each command with -c")
	path := flags.String("path", "/bin", "PATH given to commands")
	timeout := flags.Duration("timeout", 10*time.Second, "the time limit of one command")
	maxOutput := flags.Int("max-output", 64<<10, "bytes of stdout and of stderr kept from one command")
	_ = flags.Parse(args)
	if *timeout <= 0 || *maxOutput <= 0 {
		fail("natsumi-tools-runner: -timeout and -max-output must be positive")
	}

	listener, err := Listen(*socket)
	if err != nil {
		fail(fmt.Sprintf("natsumi-tools-runner: cannot listen: %v", err))
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		_ = listener.Close()
	}()
	fmt.Fprintf(os.Stderr, "natsumi-tools-runner: serving on %s (time limit %v, output limit %d bytes)\n", *socket, *timeout, *maxOutput)
	server := &Server{Limits: Limits{Shell: *shell, Path: *path, Dir: *dir, Timeout: *timeout, MaxOutput: *maxOutput}}
	if err := server.Serve(listener); err != nil {
		fail(fmt.Sprintf("natsumi-tools-runner: %v", err))
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
