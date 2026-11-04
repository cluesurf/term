# Commands

**Generated. Do not edit.** Run `npx tsx test/call/commands.ts --commit` from
`deck/term/deck/term` after changing the CLI. `pnpm term:test` fails when this
page and the CLI disagree.

Built by running `term --help` and `term <verb> --help`, so it describes the
commands that exist rather than the ones somebody remembered to write down.

38 verbs.

| verb | what |
| --- | --- |
| [`base`](#base) | The base record system |
| [`wake`](#wake) | `[name]` Scaffold a new Term project |
| [`load`](#load) | Install all dependencies |
| [`save`](#save) | `[deck] [mark]` Add a dependency |
| [`toss`](#toss) | `[deck]` Remove a dependency |
| [`link`](#link) | `[deck]` Link a local package for development |
| [`seek`](#seek) | Check if packages are installed correctly (--audit for the security scan) |
| [`host`](#host) | Publish package to registry |
| [`bind`](#bind) | Log in to term.surf with Google, for publishing |
| [`self`](#self) | The versions of term on this machine: list, find, load, pick, need, show, toss, wash, check, update, back, and skill, which teaches a coding agent its verbs |
| [`update`](#update) | Install the newest release and move the front to it (term self update) |
| [`make`](#make) | `[file]` Build/compile the project, or with --emit one program for one backend |
| [`scan`](#scan) | `<file>` Type-check a file and report diagnostics (the verifier) |
| [`mind`](#mind) | `[fact]` Project memory: remember a fact, or recall facts |
| [`test`](#test) | `[filter]` Run tests |
| [`time`](#time) | `[filter]` Run benchmarks, or profile a file with --cpu / --memory |
| [`mark`](#mark) | `[rest..]` Compare emitted code with hand-written code per target (time: time-* tasks) |
| [`boot`](#boot) | `[mode] [entry]` Compile and run an app, in development (the default) or production |
| [`cast`](#cast) | `[entry]` Build an SSR app into a deployable Cloudflare Worker (work/index.ts + build/) |
| [`halt`](#halt) | Stop running term boot servers (all, or specific --port list) |
| [`feed`](#feed) | `[entry]` Retired: the development server is term boot |
| [`work`](#work) | Run the long-lived compiler worker (shared warm analyzer) |
| [`wash`](#wash) | `[target]` Clean build artifacts |
| [`walk`](#walk) | Start REPL |
| [`move`](#move) | `<target> [level]` Version management |
| [`note`](#note) | `[deck]` Show package info |
| [`form`](#form) | `[paths..]` Format .tree files into canonical layout |
| [`look`](#look) | `[target]` Inspect what a module offers (forms + tasks): its own and what it passes on with bear |
| [`roll`](#roll) | `[kind]` The roll of this project: every deck, exception, task, route and tell in the build |
| [`mold`](#mold) | `[file]` Shape Term data: a data file (long or compact), JSON or tree/code, printed as long form, compact (--pack), JSON (--json) or tree/code (--code) |
| [`view`](#view) | `[path]` Check a document in the view role and print what it uses |
| [`lint`](#lint) | `[paths..]` Lint .tree files for style and correctness |
| [`hold`](#hold) | `[paths..]` The proof gate: every file compiles, no claim is open, every tier-0 obligation is proven or baselined. One line, non-zero exit |
| [`knit`](#knit) | `[spec..]` The prove loop: from a spec in words, a model writes the Term code, the laws and the proofs until term hold holds. Every law reported in English from its Term form |
| [`hunt`](#hunt) | `[glob]` Automated bug-hunt: oracles + fuzzing over .tree files (crashes, hangs, round-trip, determinism, backend emit, perf). Fails when any check did not run |
| [`show`](#show) | `[what] [name]` Display information |
| [`zone`](#zone) | `[rest..]` Secrets and environment: run a command with a zone's values, and manage them |
| [`fill`](#fill) | Print the shell completion script (add to your shell rc file) |

## base

`term base`

The base record system

| subcommand | what |
| --- | --- |
| `init` | Create a repository here |
| `log [branch]` | Commits per branch, newest first |
| `diff <to> [from]` | Field-level changes between two commits |
| `show <commit> <mark>` | One record in canonical form, which is what is hashed |
| `list <commit>` | Every record at a commit |
| `check` | Whether the repository is coherent |
| `status [branch]` | What the working files would change |
| `commit <message>` | Commit the working files onto a branch |
| `checkout <commit>` | Write a commit back out as .tree files |
| `merge <from>` | Merge a branch into another |
| `export <commit>` | Write the working tree at a commit as .tree files |
| `import <source>` | Bring a csv, tsv, json or jsonl file, or a directory of them, in as records |
| `project <commit>` | What a projection would write, and with --into --write, write it |
| `tag <name> [commit]` | Name a commit, so it can be cited |

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## wake

`term wake [name]`

Scaffold a new Term project

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## load

`term load`

Install all dependencies

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--clean` Clean install from scratch
- `--offline` Install without network

## save

`term save [deck] [mark]`

Add a dependency

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## toss

`term toss [deck]`

Remove a dependency

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## link

`term link [deck]`

Link a local package for development

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--toss` Remove the deck's link instead, so the next term load installs the published one

## seek

`term seek`

Check if packages are installed correctly (--audit for the security scan)

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--audit` Security scan: audit dependencies against the advisory database
- `--code` Also run the static code scan (dangerous native imports, taint) over the project
- `--sarif` Write a SARIF 2.1.0 report to this path (for GitHub code scanning)
- `--format` Console output format (default human)
- `--fix` Rewrite deck.tree to the safe dependency versions

## host

`term host`

Publish package to registry

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--dry` Dry run (no upload)
- `--registry` The oci:// registry to publish to, in place of the scope default
- `--trust` Add this public key to the scope key set instead of publishing
- `--untrust` Remove this public key from the scope key set instead of publishing
- `--ping` Announce the already-published version to the package index instead of publishing

## bind

`term bind`

Log in to term.surf with Google, for publishing

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--toss` Forget the term.surf token on this machine instead
- `--again` Log in again even while the saved token works

## self

`term self`

The versions of term on this machine: list, find, load, pick, need, show, toss, wash, check, update, back, and skill, which teaches a coding agent its verbs

| subcommand | what |
| --- | --- |
| `list` | Installed versions, the front, the default, and what runs here |
| `find [range]` | Released versions, newest first |
| `load <range>` | Install a version, verified, without switching to it |
| `pick <range>` | The version that runs outside any project |
| `need [range]` | The version this project needs, written to deck.tree and pinned in lock.tree |
| `show` | Which version runs here, and every rule that decided it |
| `toss <mark>` | Remove one installed version |
| `wash` | Versions nothing has used in --days; removed only with --commit |
| `check` | Verify this install against the signed release |
| `update` | Install the newest release and move the front to it |
| `back` | Move the front back to the previous version |
| `skill` | Write the skill that teaches a coding agent term's verbs into this project, at .claude/skills/term/SKILL.md |

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## update

`term update`

Install the newest release and move the front to it (term self update)

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## make

`term make [file]`

Build/compile the project, or with --emit one program for one backend

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--emit` Write ONE program as a single source file for node (TypeScript), rust, swift or kotlin (runtime prelude plus emitted code), or for wgsl or hvm (a numeric part of the language: anything outside it is refused, by name and place), or llvm (IR) or wasm (WASI), through the Rust. A check error refuses
- `--out` With --emit: the file to write (default standard output)
- `--units` With --emit rust, swift or kotlin and --out <folder>: one file per Term module beside a shared one, each written only when it changed
- `--env` Every program of the project (a file with a `run`, `boot` or `main` task taking nothing) for rust, swift, kotlin or node, one file each under host/<env>/. One that does not build is reported and the rest written
- `--build` With --emit: add the main that calls the program and build it with its toolchain, into --out <folder> (default host/<target>). With --env: build every program, beside its source
- `--run` With --emit: build it, then run it, its output and exit code passed through
- `--main` With --build or --run: the task the program starts at (default run, else boot, else main)
- `--ride, --watch` Watch files and recompile incrementally on every change
- `--separate` Separate compilation, the default: each module checked once against its imports' stubs and cached, per-module artifacts
- `--merged` One whole-program compile per file instead, optimized across modules (the build before separate compilation)
- `--explain` Say why each unit that was built was built: its own text, a name it reaches, its settings, or the compiler
- `--trees` Compile .tree files even when package.json owns `make` (which otherwise runs that script instead)
- `--target` Build a native app cask for a platform (macos, ios, android, linux, windows), a Compose app (compose: the desktop with its JVM, compose-android: an APK), or an iPhone app drawn by UIKit (uikit: an Xcode project, signed ad hoc with --team)
- `--team` With --target uikit: the Apple team to sign for (read from the keychain when it holds one team)
- `--link` With --target uikit: the https address the app will be served at, for an install page an iPhone opens
- `--page` The page entry of the cask app (default face/base.tree)
- `--entry` The cask entry of the app (default cask.tree; for a Compose or UIKit target, the file the boot line of deck.tree names, else app.tree)
- `--url` Dev loop: the cask loads this URL instead of the bundled page
- `--sign` A Developer ID identity for codesign (ad hoc when absent)
- `--dmg` Also make a .dmg beside the .app
- `--publish` Also publish the page just built as a signed over-the-air update into this directory
- `--channel` The update channel --publish writes (default main)

## scan

`term scan <file>`

Type-check a file and report diagnostics (the verifier)

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--fix` Write the sure fixes into the file and scan again. A guess is offered, never written

## mind

`term mind [fact]`

Project memory: remember a fact, or recall facts

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--name` A short name for the fact
- `--kind` The kind of fact
- `--find` Recall only facts matching this query
- `--forget` Forget the fact with this name

## test

`term test [filter]`

Run tests

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--merged` Compile each test file whole, instead of one unit at a time with the units shared across files
- `--case` Run only the tests whose phrase or name holds this, in any case
- `--env` The backend the tests run on: node (the default), rust, swift or kotlin
- `--ride` Run, then run again on every edit the tests whose files the edit reaches, until ctrl-c
- `--update` Write what each `want snapshot` sees into the test file's snapshot file, instead of comparing against it
- `--limit` The seconds a test file may run before it and its children are ended (default 300)

## time

`term time [filter]`

Run benchmarks, or profile a file with --cpu / --memory

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--file` Run benchmarks in a specific file
- `--cpu` Profile CPU hotspots of a .tree file
- `--memory` Profile memory use of a .tree file
- `--top` Show the top-N hottest functions (with --cpu)
- `--json` Output JSON instead of table
- `--save` Save results as a named baseline
- `--compare` Compare against a saved baseline
- `--fail-on-regression` Fail if any benchmark regresses by more than N%
- `--markdown` Output comparison as markdown
- `--history` Show history for a specific benchmark

## mark

`term mark [rest..]`

Compare emitted code with hand-written code per target (time: time-* tasks)

## boot

`term boot [mode] [entry]`

Compile and run an app, in development (the default) or production

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `-p, --port` Port to serve on
- `--env` Target env (node, browser)
- `--remote` Remote cache endpoint (pull before, push after)
- `--remote-token` Bearer token for the remote cache
- `--out` Write a command-line program to this directory (run.mjs, app.mjs, dock.mjs) instead of running it

## cast

`term cast [entry]`

Build an SSR app into a deployable Cloudflare Worker (work/index.ts + build/)

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--target` Deploy target (cloudflare)

## halt

`term halt`

Stop running term boot servers (all, or specific --port list)

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `-p, --port` Comma-separated ports to stop (default: all)

## feed

`term feed [entry]`

Retired: the development server is term boot

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `-p, --port` Port to serve on
- `--env` Target env

## work

`term work`

Run the long-lived compiler worker (shared warm analyzer)

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `-p, --port` Port to serve on
- `--env` Target env
- `--target` Develop a native app: a cask (its page on a dev server with hot swaps, the app pointed at it), or `compose` / `compose-android` (rebuilt and relaunched on each edit, on the screen it was on)
- `--page` The page entry of the cask app (default face/base.tree)
- `--entry` The entry of the app (default cask.tree; for a Compose or UIKit target, the file the boot line of deck.tree names, else app.tree)

## wash

`term wash [target]`

Clean build artifacts

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## walk

`term walk`

Start REPL

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## move

`term move <target> [level]`

Version management

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## note

`term note [deck]`

Show package info

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap

## form

`term form [paths..]`

Format .tree files into canonical layout

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--check` Report which files would change without writing (for CI)
- `--list` Print formatted source to stdout instead of writing

## look

`term look [target]`

Inspect what a module offers (forms + tasks): its own and what it passes on with bear

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Everything the module loads, not only what it offers
- `--json` Output JSON
- `--csv` Output CSV
- `--kind` Only forms or only tasks

## roll

`term roll [kind]`

The roll of this project: every deck, exception, task, route and tell in the build

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--json` Output the roll as JSON
- `--private` Only the exceptions no tell covers
- `--host` Only the entries of one deck (@term/site)
- `--path` Under each exception, one call path from every task that can raise it to the raise site
- `--diff` What changed in what each task can reach and raise since a roll file (term roll --json > before.json) or a git ref. A task that gained a native module is a warning, so --strict makes it a gate

## mold

`term mold [file]`

Shape Term data: a data file (long or compact), JSON or tree/code, printed as long form, compact (--pack), JSON (--json) or tree/code (--code)

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--pack` Compact form, one entry per line
- `--json` JSON, keys in snake case
- `--keep` With --json: leave keys as written
- `--tree` The input is JSON
- `--trees` Keep tree anchors instead of expanding them
- `--lines` The input is a compact stream: one form per line, anchors re-declarable
- `--check` Only report problems, exit 1 on any
- `--code` tree/code bytes, Zstandard frames where smaller (to a file or a pipe)
- `--canonical` With --code: the canonical bytes, every frame uncompressed

## view

`term view [path]`

Check a document in the view role and print what it uses

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--find` Print the query manifest instead

## lint

`term lint [paths..]`

Lint .tree files for style and correctness

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--fix` Apply autofixes in place

## hold

`term hold [paths..]`

The proof gate: every file compiles, no claim is open, every tier-0 obligation is proven or baselined. One line, non-zero exit

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--cross` Also run the cross-backend differential
- `--commit` Rewrite hold.json to the obligations not proven today, and print how many that added
- `--cache` Skip files unchanged since they last held
- `--force` Re-check everything, ignoring the cache
- `--json` Machine-readable output
- `--lean` Also re-check every claim in Lean 4 (TERM_LEAN, else the PATH)
- `--report` Print the report: every law laws.tree names, in English, and what it rests on

## knit

`term knit [spec..]`

The prove loop: from a spec in words, a model writes the Term code, the laws and the proofs until term hold holds. Every law reported in English from its Term form

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--spec-file` Read the spec from this file instead
- `--port` A TypeScript module to port
- `--law` A law of the law library (deck/site/code/law) the project must prove of its own forms and tasks, by name (repeat for more)
- `--name` The run's name (default: knit- and the time)
- `--out` Where the run is written (default: tmp/knit/<name>)
- `--model` The model that writes the proofs
- `--effort` How hard the model thinks
- `--cap` The most the run may spend, in dollars, from the usage the API reports
- `--rounds` The most rounds of term hold
- `--turns` The most requests to the model
- `--minutes` The most minutes the run may take
- `--max-tokens` The most tokens one answer may take
- `--lean` Also re-check every law in Lean 4 (--no-lean to skip)
- `--example` Show the model the notes demo as an example (--no-example to leave it out)

## hunt

`term hunt [glob]`

Automated bug-hunt: oracles + fuzzing over .tree files (crashes, hangs, round-trip, determinism, backend emit, perf). Fails when any check did not run

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--runs` Fuzz inputs per term
- `--seeds` Distinct fuzz seeds
- `--fuzz-timeout` Watchdog seconds per fuzz term
- `--budget` Milliseconds one compile may take before it is a finding (default 1000)
- `--json` Machine-readable output

## show

`term show [what] [name]`

Display information

- `-b, --back` Response format
- `-q, --quiet` Print only failed items and the closing item
- `--verbose` Also print debug items
- `--trace` Also print trace items, for debugging Term itself
- `--log` One JSON object per event on stdout, and no human view
- `--color` Color the output
- `--utc` Clocks in UTC rather than local time
- `--plain` One sentence per item, for screen readers and transcripts
- `--strict` Warnings fail the run with exit 1
- `--motion` Animate the spinner (--no-motion holds it still)
- `-y, --yes` Accept every default instead of asking
- `--raw` Pass a child process's output through untouched
- `--source` Show one service of a stream, without tags
- `--all` Show every problem and list entry past the cap
- `--budget` With `name`: the most tokens the answer may take, roughly four characters each (default 4000)

## zone

`term zone [rest..]`

Secrets and environment: run a command with a zone's values, and manage them

## fill

`term fill`

Print the shell completion script (add to your shell rc file)

## Every verb answers bad input in words

`test/call/bad-input.ts` feeds each verb a bad flag and a bad path from an empty
directory and fails on a stack trace, a raw runtime error class, or a bare errno
reaching the output. A verb is free to fail, and most of these should. It has to
fail in a sentence.
