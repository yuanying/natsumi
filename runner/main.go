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
  natsumi-workspace-runner serve [flags]   run commands sent over the Unix socket
  natsumi-workspace-runner check [flags]   exit 0 only while the runner answers (for the healthcheck)`

const defaultSocket = "/run/natsumi-workspace/runner.sock"

func main() {
	if len(os.Args) < 2 {
		fail(usage)
	}
	switch os.Args[1] {
	case "serve":
		serve(os.Args[2:])
	case "check":
		flags := flag.NewFlagSet("check", flag.ExitOnError)
		socket := flags.String("socket", defaultSocket, "the runner's Unix socket")
		_ = flags.Parse(os.Args[2:])
		if err := Check(*socket, 5*time.Second); err != nil {
			fail(fmt.Sprintf("natsumi-workspace-runner: check failed: %v", err))
		}
	default:
		fail(usage)
	}
}

func serve(args []string) {
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	socket := flags.String("socket", defaultSocket, "the Unix socket to listen on")
	dir := flags.String("dir", "/work", "the working directory of every command")
	shell := flags.String("shell", "/bin/bash", "the shell that runs each command with -c")
	path := flags.String("path", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "PATH given to commands")
	home := flags.String("home", "/home/natsumi", "HOME given to commands")
	lang := flags.String("lang", "C.UTF-8", "LANG given to commands")
	timeZone := flags.String("tz", "UTC", "TZ given to commands when the request does not carry one")
	response := flags.Duration("response-limit", 60*time.Second, "how long one command is waited for before the runner answers")
	maxOutput := flags.Int("max-output", 64<<10, "bytes of stdout and of stderr kept from one command")
	_ = flags.Parse(args)
	if *response <= 0 || *maxOutput <= 0 {
		fail("natsumi-workspace-runner: -response-limit and -max-output must be positive")
	}

	listener, err := Listen(*socket)
	if err != nil {
		fail(fmt.Sprintf("natsumi-workspace-runner: cannot listen: %v", err))
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		_ = listener.Close()
	}()
	fmt.Fprintf(os.Stderr, "natsumi-workspace-runner: serving on %s (response limit %v, output limit %d bytes)\n",
		*socket, *response, *maxOutput)
	server := &Server{Limits: Limits{Shell: *shell, Path: *path, Dir: *dir, Home: *home, Lang: *lang,
		TimeZone: *timeZone, Response: *response, MaxOutput: *maxOutput}}
	if err := server.Serve(listener); err != nil {
		fail(fmt.Sprintf("natsumi-workspace-runner: %v", err))
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
