// term.exe: the Windows launcher of the `term` command, built into every Windows payload by `pnpm term:release`
// (task/release.ts) as bin\term.exe, beside bin\term.cmd.
//
// WHY AN EXE AT ALL. winget installs a portable package by putting a LINK to its executable on PATH, and it takes only
// an .exe for that. A .cmd reached through a link finds its folder with `%~dp0`, which names the link's folder, not
// the payload's, so `term.cmd` would look for `..\host\need.mjs` in the wrong place. This program asks for its own
// real path, links resolved, and starts Node on the payload's first module from there.
//
// It does what the sh launcher and term.cmd do and nothing else: find Node, hand it host\need.mjs and every argument,
// share the terminal, and exit with Node's code. Built with `GOOS=windows`; the same source builds on any platform,
// which is how test/call/launcher.ts runs it.

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
)

// the oldest Node the CLI runs on, said when there is none (task/release.ts NODE_FLOOR)
const nodeFloor = "22.3.0"

func main() {
	self, err := os.Executable()
	if err == nil {
		self, err = filepath.EvalSymlinks(self)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "term could not find its own folder: %v\n", err)
		os.Exit(70)
	}

	// bin\term.exe, so the payload is the folder above bin
	root := filepath.Dir(filepath.Dir(self))
	node, err := exec.LookPath("node")

	if err != nil {
		fmt.Fprintf(os.Stderr, "term needs Node.js %s or newer on PATH: https://nodejs.org\n", nodeFloor)
		os.Exit(69)
	}

	// Ctrl-C reaches every process on the console, Node included. This one waits for Node to finish and passes on its
	// code, rather than dying first and leaving Node's last lines after the prompt
	signal.Ignore(os.Interrupt)

	command := exec.Command(node, append([]string{filepath.Join(root, "host", "need.mjs")}, os.Args[1:]...)...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr

	err = command.Run()

	var exit *exec.ExitError

	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode())
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "term could not start Node: %v\n", err)
		os.Exit(70)
	}
}
