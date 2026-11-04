# Term: rules for agents

Term is a language written in `.tree` files (indentation syntax) that compiles to TypeScript, Rust, Swift and Kotlin.
Older names say "seed". The language, packages and import prefix are `term`. Every path is relative to this
repository's root, and every command runs from it.

## Packages

Every package lives under `deck/` and is named by the `deck <name>` line of its own `deck.tree` (never by
`package.json`). A manifest: `deck @alice/tools` / `head <Small tools>` / `mark <1.4.2>` / `link @term/base, mark <0.0.x>`.
`code ./src` names the code root (default `./code`). `code <1.4.2>` and `bear ./code` are old spellings:
`pnpm term:manifest-mark --commit` rewrites them.

| package | path | what it is |
| --- | --- | --- |
| `@term/base` | `deck/base/` | the standard library |
| `@term/bind` | `deck/bind/` | platform bindings, typed handles for host APIs |
| `@term/call` | `deck/call/` | the CLI, built to `host/line.js` |
| `@term/cask` | `deck/cask/` | the native app shell: window, WebView, bridge |
| `@term/deck` | `deck/deck/` | the package manager |
| `@term/face` | `deck/face/` | the UI component library |
| `@term/flow` | `deck/flow/` | the language server |
| `@term/host` | `deck/host/` | the data dialect, read at run time |
| `@term/make` | `deck/make/` | the compiler |
| `@term/mark` | `deck/mark/` | the benchmark suite and `term mark` |
| `@term/mill` | `deck/mill/` | the mill engine and every grammar |
| `@term/scan` | `deck/scan/` | dependency and advisory scanning |
| `@term/site` | `deck/site/` | the app framework (dom, http, graphics, zone) |
| `@term/test` | `deck/test/` | test and verification tooling |

## Paths

| what | path |
| --- | --- |
| compiler, parser, checker, backends | `deck/make/code/`, `parser/`, `check/`, `compile/` |
| CLI entry, build driver, test runner | `deck/call/code/line.ts`, `make.ts`, `test.ts` |
| built CLI | `host/line.js` |
| stdlib types, traits, platform impls, tests | `deck/base/code/*.tree`, `code/mask/`, `code/native/<platform>/`, `deck/base/test/` |
| gate and tooling | `task/term/` (`test.ts`, `line-lock.ts`, `self-contained.ts`, `root.ts`) |

## Commands

| task | command |
| --- | --- |
| install | `pnpm install`, then `pnpm run install:all` |
| rebuild the CLI after any compiler or CLI `.ts`, or a ported `.tree` | `pnpm run make:line` (takes the line lock, runs `make:port` first) |
| hold the line lock while editing a live compiler `.tree` | `node task/term/line-lock.ts take --by <item>`, then `free --by <item>` |
| build one package | `pnpm --dir deck/<name> exec node "$PWD/host/line.js" make` |
| build the stdlib | `pnpm --dir deck/base exec node "$PWD/host/line.js" make --trees` |
| test one package | `pnpm --dir deck/<name> exec node "$PWD/host/line.js" test` |
| every gate | `pnpm term:test` (`--only <substr>` a subset, `--fresh` ignores the result cache, `--list` the suites) |
| no path leaves the repository | `pnpm term:self-contained` |
| the TypeScript suite | `npx vitest run` |
| release | `pnpm term:release`: reads `GHCR_TOKEN` or `TERM_OCI_TOKEN`, `TERM_MACHINE_MODULE` and the EC2 key for the Windows step, `TERM_RELEASE_REGISTRY` to move the registry |

Environment the tools read: `TERM_ROOT` (the root), `TERM_PARENT_ROOT` (an enclosing checkout, only for the tools that
read one. Unset, they exit 2 or skip), `TERM_ZONE` (the zone command, else `zone` on PATH).

## Syntax

A file whose role carries `mark lean` (`deck/call/code/work/**`) is LEAN: `back x` returns, `<x>` is text, a bare word
is the variable, `f(a, b)` is a call, `f()` calls with no arguments (a bare `f` is the task itself), fork arms are
`hold` / `miss`. Never hand-convert: `pnpm term:lean-convert <file> --commit`. The rules below are the longhand.

- Loads: `load @term/base/list` then `find get`. Alias: `find get, name list-get`, never `find get as list-get`.
- Return: `send back, read x`. A value with children goes on the next indented line under `send back`.
- Literals: `text <hello>`, bare `true` / `false`, `code 42`. `<<...>>` is raw text. An ordinary literal unescapes
  `\< \> \{ \} \n \r \t \e \\` only. Never `wave true` or `mark 42`.
- Variables: `read x`, `read x/foo`, `read x/{key}`, `read x/0`. Assign `save y, code 20`. Constant `host x, code 10`.
- Construction: `make user` with `bind field, value`. `make hash` with `save <key>, <value>` lines. `make list`.
- Arguments: one per indented line. `bind <name>, <value>` under a `call` is named. `take p, like T, fall v` defaults.
- A COMMA POPS ONE LEVEL, a SPACE nests. A multi-word part cannot be followed by a comma: write `call add, read(a),
  read(b)` or put arguments on their own lines.
- Branching: `fork test` / `hook test` / `hook hold` / `hook miss`. Match: `sift <value>` with `case <name>` children.
- Looping: `walk list, read items` / `hook next` / `take site, name item`. `turn next` continues, `halt` breaks,
  `walk xs, name outer` names a loop.
- Comparison: `is-above`, `is-below`, `is-minimum`, `is-maximum`.
- A numeric literal is never a method receiver: `call subtract(code 24, read x)`.
- Errors: `halt <form>` with `bind` children raises, `halt kink` passes a callee's exception on, `halt <text>` raises
  `failure`. A guarded block is a `fork` whose first line is `mark unsafe`, followed by `halt take` / `take e`.
  Exception names are nouns (`absence`, `excess`), never `-error`.
- Async: `mark async` on a definition. Calls to it are awaited with nothing written. `tick f(x)` starts without
  waiting. Never `wait true` on a call to an async task. Outside a task, call an async task only with `tick`.
- Metadata is `mark`: `mark async`, `mark private`, `mark unsafe`, `mark draft` (a file), `mark open`. Never `note`
  as metadata, never `mark native` under a `dock load`. `mark x` is never a variable.
- Theorem variables are `seat <name>, like <type>` inside a `rule`. A proof is a `task`, never `test <name>`.
- Native calls: `dock load` / `load <node:fs/promises>, name fs-promise`, then `call fs-promise/read-file`. A public
  stdlib module writes `load .../native/{platform}/<name>`.
- Types: `like unknown` is gradual, `like dynamic` the host's `any`. A list that mixes elements says
  `like list, like unknown`. A generic form applies its own argument: `like linked-list t`.
- Task parameters: `take body` / `like task` / `take dir, like text`.
- Templates: `fuse` / `tree`, parameters by `{param}`. One brace syntax for interpolation: `{x}`, `{add(a, b)}`.
- Data files (only `host` / `list` / `mesh` / `tree` / `fuse` and literals) compile to JSON.

## File resolution

`./foo/bar` tries `bar.tree`, `bar/base.tree`, `bar/note.tree`. A package path `@scope/name/<path>` resolves in the
code root first, then the package root. One function decides it: `resolvePackagePath` in `deck/make/code/resolve.ts`.
Prefer `foo.tree` over `foo/base.tree`.

## Naming

- kebab-case for folders and files (C and Xcode files excepted).
- A task is a verb (`make-text`). A form, view or value is a noun. Tasks are never namespaced (`task make`).
- No redundant suffixes on forms (`form command`).
- A name is scoped to its module and reaches others only through `load` / `find`. Never rename to dodge a collision.
- Functions with 2+ parameters take one object.

## On disk

Everything Term keeps lives under `.base/@term/code/`, built in ONE place: `deck/call/code/home.ts`
(`projectHome`, `userHome`). Environment variables are `TERM_*`, never a bare `TERM`.

## Never

- Grep or glob the whole repository: scope to a folder.
- Trust `term scan`. Only `term make` proves a file compiles.
- Use `take` inside a `load`, or `find X as Y`.
- Use `term` for strings, or `back` outside a lean file.
- Name a task with a module prefix.
- Never add docs to this repository. User docs go to the term.surf site.
- Commit an absolute path, a home path into one machine, or a path that climbs out of the root
  (`pnpm term:self-contained` fails on one, and a fake root a test needs goes on `task/term/self-contained.allow`).

## Always

- Rebuild with `pnpm run make:line` after editing compiler or CLI code, or you measure a stale binary.
- Run `npx vitest run` and `pnpm term:test` before finishing compiler work.
- Treat a rise in error count after a fix as revelation: read the new errors first.
- Hold the line lock while editing a live compiler `.tree`.
