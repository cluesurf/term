# The `term` CLI

The `term` command builds, runs, checks, formats, and ships Term projects. Every verb is a short word. This page lists them all, then shows the ones you reach for daily.

## Every command

| Command | Does | Key options |
| --- | --- | --- |
| `term wake [name]` | Scaffold a new project (new dir, or current) | |
| `term load` | Install all dependencies | `--clean`, `--offline`, `--like base` |
| `term save [deck]` | Add a dependency | |
| `term toss [deck]` | Remove a dependency | |
| `term link [deck]` | Link a local package for development | |
| `term seek` | Check dependencies are installed correctly | `--audit` (security advisories) |
| `term host` | Publish the package to the registry | `--dry` |
| `term make` | Build the project to `host/` | `--watch` (incremental rebuild on change) |
| `term scan <file>` | Type-check one file, report diagnostics | `--back json` |
| `term boot [entry]` | Compile and run the app (server + client) | `--port`, `--remote`, watches in dev |
| `term feed [entry]` | Dev server: lazy ESM + hot reload | |
| `term halt` | Stop running `boot` servers | `--port` |
| `term work` | Long-lived compiler worker (warm analyzer) | |
| `term test [filter]` | Run tests (filter by name substring) | |
| `term time [filter]` | Run benchmarks, or profile a file | `--cpu`, `--memory`, `--save`, `--compare`, `--fail-on-regression` |
| `term hold` | Verify files hold: gaps + cross-backend differential, gate CI | |
| `term hunt [glob]` | Automated bug-hunt: oracles + fuzzing | `--runs`, `--terms` |
| `term lint [paths]` | Lint for style and correctness | `--fix` |
| `term form [paths]` | Format files into canonical layout | `--check` (CI), `--list` (stdout) |
| `term look [target]` | Inspect what a module exposes (forms + tasks) | `--json`, `--csv`, `--kind form|task` |
| `term note [deck]` | Show package info | |
| `term show [what]` | Display info (`mark`, `deck`, `self`) | |
| `term mind [fact]` | Project memory: remember or recall facts | `--name`, `--like decision|convention|...` |
| `term move <target> [level]` | Version bump (`1`=major, `2`=minor, `3`=patch) | |
| `term wash [target]` | Clean build artifacts | |
| `term walk` | Start the REPL | |
| `term fill` | Print the shell completion script | |

Add `--hint` (or `-h`) to any command for its help. Add `--back json` for machine-readable output where supported.

## The daily loop

```bash
term wake my-app        # scaffold
cd my-app
term load               # install deps
term make --watch       # build to host/, rebuild on every save
```

In another terminal, run the app with live reload:

```bash
term boot               # compile + serve the deck.tree boot entry, hot-reloading on edits
term boot app.tree --port 3000
term halt               # stop all running servers
```

## Build and check

```bash
term make               # one-shot build of the whole project to host/
term make --watch       # incremental: only files whose output changed are rewritten
term scan src/user.tree # type-check a single file, with a colored kink-style report
term hold               # verify proofs/holds and the cross-backend differential (CI gate)
```

A failing `scan` prints a kink frame:

```
kink <return value: expected text, found number>
  site <src/user.tree:4:3>
    3 |   like text
    4 |   send back
      |   ^^^^^^^^^
  note <make the value match the expected type, or adjust the annotation>
  name <type-mismatch>
  code <0007>
```

## Test, benchmark, format, lint

```bash
term test               # run every test
term test parser        # only tests whose name contains "parser"

term time               # run all time-* benchmarks
term time --cpu hot.tree    # profile one file's hotspots
term time --save main       # save this run as a baseline
term time --compare main --fail-on-regression 5   # CI gate at 5%

term form               # format every .tree file in place
term form --check       # CI: report which files would change, write nothing

term lint               # report style/correctness problems
term lint --fix         # apply the safe autofixes
```

## Packages

```bash
term save @scope/thing  # add a dependency
term toss @scope/thing  # remove it
term link ../local-pkg  # use a local checkout while developing
term seek               # confirm everything is installed
term seek --audit       # plus known vulnerabilities
term host               # publish to the registry
term host --dry         # rehearse the publish without uploading
term move code 3        # bump the patch version
```

## Explore and inspect

```bash
term look src/user.tree         # what forms and tasks does this module expose?
term look @scope/pkg --kind task --json
term note @scope/pkg            # package metadata
term walk                       # REPL: evaluate expressions interactively
term fill >> ~/.zshrc           # install tab-completion
```
