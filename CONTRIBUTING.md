# Contributing to Term

Every command here runs from the root of this repository, the folder that holds this file. The rules an agent follows
when it edits the code are in `AGENTS.md`.

## The one rule about paths

No absolute path is ever committed or published. That covers a path into one machine's home folder, a home path into
one person's layout, and a relative path that climbs out of the repository root. `pnpm term:self-contained` checks the
tree, and the release checks every payload it stages the same way. When a test needs an absolute path as data, give it
a fake root and put that root on `task/term/self-contained.allow`, with the reason.

## Install

Term needs Node 22.18 or newer (the tooling runs `.ts` files with Node's own type stripping) and pnpm.

```sh
git clone https://github.com/cluesurf/term.git
cd term
pnpm install
pnpm run install:all
```

`install:all` installs the root and then the packages that keep their own lockfile (`deck/deck`, `deck/mill`,
`deck/base`, and `deck/flow` outside the workspace).

## Build the CLI

```sh
pnpm run make:line
```

This builds `host/line.js`, the CLI, and its worker bundles. It first runs `make:port`, which compiles every ported
toolchain module from `.tree` to `deck/<package>/host/port/`. A fresh clone runs it before anything else, and you run
it again after editing any compiler or CLI `.ts`, or a ported `.tree`, or you measure a stale binary.

`make:line` runs under the line lock, `task/term/line-lock.ts`. Only one build of the CLI and its ports runs at a time
in a checkout, because a port compiles with the working tree's compiler and a half-made edit breaks it. A second
`make:line` started while one runs waits for the first (up to an hour), so parallel work in one checkout queues here
instead of colliding.

```sh
node task/term/line-lock.ts show                  # who holds it, or free
node task/term/line-lock.ts take --by <name>      # hold it while you edit a live compiler .tree by hand
node task/term/line-lock.ts free --by <name>      # let it go
pnpm run make:line --by <name>                    # build while you hold it, without waiting on yourself
```

A lock whose process died is broken by the next taker. A lock taken by hand lapses after 20 minutes without a renewal,
and after 15 minutes from its take however often it was renewed. The lock lives in `.base/@term/code/line-lock/` and is
never committed.

## Test one package

The CLI runs inside a package folder:

```sh
pnpm --dir deck/base exec node "$PWD/host/line.js" test     # the stdlib's tests
pnpm --dir deck/base exec node "$PWD/host/line.js" make --trees
pnpm --dir deck/make exec node "$PWD/host/line.js" test
```

`$PWD` is the repository root, expanded before pnpm changes folder. `term make` is the only trustworthy compile
signal. `term scan` cannot resolve cross-file imports.

The TypeScript suites run one at a time with `npx tsx test/<area>/<file>.ts`, and the vitest suite with
`npx vitest run`.

## The gate

```sh
pnpm term:test                   # every suite
pnpm term:test --only parser     # the suites whose name holds "parser"
pnpm term:test --list            # the suites, without running them
pnpm term:test --quick           # only the suites that last took under 30 seconds
pnpm term:test --fresh           # every suite, ignoring the result cache
```

One line per suite with its count, and a non-zero exit when any suite fails. Suites run at the same time, longest
first (`--jobs N`, default the cores minus one).

The gate keeps a result cache: a suite whose inputs have not changed since its last pass is answered from it, and the
line says `cached`. Run `--fresh` before a release, and whenever you doubt a cached answer. The first run after
changing the gate itself reruns every suite.

`self-contained` is one of the suites, so `pnpm term:test` fails on a path leak too. On its own:

```sh
pnpm term:self-contained                       # the tracked tree
pnpm term:self-contained --payload <folder>    # a staged release payload
```

It exits 0 clean and 1 on a leak, one line per leak and a summary line. In the tree, mentions of the notes and sites
that live outside this repository may only fall, against `task/term/self-contained.baseline.json`. When you remove
some, `pnpm term:self-contained --write-baseline` lowers the baseline. It refuses to raise it.

## Toolchains

A full gate builds and runs the emitted code on every backend, so it wants:

- `cargo` (Rust)
- `swiftc` (Swift), and on macOS the iOS simulator (`xcrun simctl`)
- `kotlinc`, a JDK and Maven (Kotlin), and the Android SDK with an emulator for the mobile suites

A suite whose toolchain is missing is skipped, with the reason on its line, and never fails. One command checks them
all on macOS, Linux or Windows, and installs what is missing with `--commit`:

```sh
sh task/dev/bootstrap/start.sh check
sh task/dev/bootstrap/start.sh install --commit
powershell -ExecutionPolicy Bypass -File task\dev\bootstrap\start.ps1 check
```

## Tests that reach outside data

A few suites compare Term against data this repository does not carry. Each reads a path from the environment and
skips, saying so, when it is not set. A relative path resolves against the folder you typed the command in.

| variable | what it names | suites |
| --- | --- | --- |
| `TERM_TEST_MODULES` | a project with `@playwright/test` and `string-width` installed, when the Term root has neither | the web suites, the cell grid width table |
| `TERM_VOCABULARY` | a `terms.json` word list for the vocabulary | `test/compile/head-words.ts` |
| `TERM_SEED_TREE` | a checkout of the seed.tree project | `test/check/law-english.ts` |
| `BEAT_TERM_ROOT` | the beat-term app folder | the beat-term app builds |
| `DATABASE_URL` | a Postgres the suites may write | `test/site/blog-db.ts`, `test/site/blog-loop.ts` |

## Release

```sh
pnpm term:release --dry      # build tmp/release/<version>/term-<platform>.tar.gz for every platform and stop
pnpm term:release            # build, then publish @term/code to ghcr.io/cluesurf/term/code and tell the index
```

Every staged payload passes `term:self-contained --payload` before it is packed, and a leak refuses the release with
nothing published.

Credentials come from the environment, and this repository holds no secret store:

| variable | for |
| --- | --- |
| `TERM_OCI_TOKEN`, `TERM_OCI_USERNAME`, `TERM_OCI_HOST` | the registry push, to the host `TERM_OCI_HOST` names (default `ghcr.io`) |
| `GHCR_TOKEN`, `GHCR_USERNAME` | the registry push to ghcr.io, when `TERM_OCI_TOKEN` is unset |
| `TERM_RELEASE_REGISTRY` | another registry for both publishing and `term self`, as `oci://host/namespace` |
| `TERM_MACHINE_MODULE` | the module that rents the Windows machine the windows-x64 build runs on |

Without either token the push falls back to the docker config (`$DOCKER_CONFIG/config.json`). Without
`TERM_MACHINE_MODULE`, a dry run can pack windows-x64 here instead, untested, with `--windows-cross`.

`pnpm term:distro` makes the packages for the Linux and Windows package managers. It writes the public files the
installer serves to `--site <folder>`, else `TERM_SITE_DIR`, else `host/site/`.
