# Term: rules for agents

Term is a programming language written in `.tree` files, with indentation-based syntax. It compiles one source to
TypeScript, Rust, Swift and Kotlin. Term was called Seed before, and some older names still say "seed", but the
language, its packages and its import prefix are all `term`.

Every path below is relative to the root of this repository, and every command runs from it. `CONTRIBUTING.md` says
how to install, build, test and release.

## Packages

Every package lives under `deck/`. A package declares its identity in its own `deck.tree`, not in `package.json`.
The `package.json` names that survive in a few packages are stale leftovers, and imports never resolve against them.

- Each package is identified by the `deck <name>` line in its `deck.tree`. Import it by that name.
- A manifest: `deck @alice/tools` / `head <Small tools>` / `mark <1.4.2>` / `link @term/base, mark <0.0.x>`. `mark` is
  the version and a dependency's constraint. `code ./src` names the CODE ROOT, the folder a package path resolves in
  first. Absent, it is `./code`, so almost no manifest writes it. `code <1.4.2>` (a text literal, told apart from a
  path by its form) and `bear ./code` are the OLD spellings. They are still read, and `term lint` warns
  (`manifest-code-version` L050, `manifest-bear` L051). `term lint --fix` rewrites one project, and
  `pnpm term:manifest-mark --commit` the whole repository. The OCI config and the lockfile keep their own `code` keys:
  they are wire formats, signed or written by the package manager, and not the manifest's spelling.

| package | path | what it is |
| --- | --- | --- |
| `@term/base` | `deck/base/` | the standard library, all `.tree` |
| `@term/bind` | `deck/bind/` | platform bindings: typed handles for the host APIs each backend exposes. 3,091 `.tree` files, the largest package |
| `@term/call` | `deck/call/` | the CLI, built to `host/line.js` |
| `@term/cask` | `deck/cask/` | the native app shell: window, WebView, bridge |
| `@term/deck` | `deck/deck/` | the package manager (resolve, fetch, lockfile) |
| `@term/face` | `deck/face/` | the UI component library |
| `@term/flow` | `deck/flow/` | the language server |
| `@term/host` | `deck/host/` | the data dialect, read at run time |
| `@term/make` | `deck/make/` | the compiler |
| `@term/mark` | `deck/mark/` | the benchmark suite and its runner (`term mark`): emitted code against hand-written code, per target (`pnpm term:bench`) |
| `@term/mill` | `deck/mill/` | the mill engine (mine and mint DSL definitions) and every grammar |
| `@term/scan` | `deck/scan/` | dependency and advisory scanning (OSV, audit) |
| `@term/site` | `deck/site/` | the app framework (dom, http, graphics, zone) |
| `@term/test` | `deck/test/` | test and verification tooling (bdd, bench, bmc, cegar, fuzz) |

## Paths

| what | path | note |
| --- | --- | --- |
| compiler source | `deck/make/code/` | |
| parser | `deck/make/code/parser/` | `tree.ts`, `token.ts`, `diagnostic.ts`, `event.ts` |
| mill and build | `deck/make/code/compile/mill.ts` | tree AST to typed AST |
| checker | `deck/make/code/check/` | `infer.ts`, `resolve.ts`, `substitution.ts`, `type-seed.ts`, `kernel.ts` |
| backends | `deck/make/code/compile/` | `typescript.ts`, `rust.ts`, `kotlin.ts`, `swift.ts`, `hvm.ts`, `wgsl.ts` |
| CLI entry | `deck/call/code/line.ts` | |
| build driver | `deck/call/code/make.ts` | `findTreeFiles`, `compileProject` |
| test runner | `deck/call/code/test.ts` | |
| built CLI | `host/line.js` | |
| stdlib root | `deck/base/` | |
| stdlib types (forms) | `deck/base/code/*.tree` | |
| stdlib traits (masks) | `deck/base/code/mask/*.tree` | |
| platform impls | `deck/base/code/native/` | browser, javascript, kotlin, node, rust, shared, swift |
| stdlib tests | `deck/base/test/` | |
| gate and tooling | `task/term/` | `test.ts` (the gate), `line-lock.ts`, `self-contained.ts` |
| the language guide | `book/` | one cheatsheet page per topic |
| generated references | `doc/` | the command reference and the lint catalog, written by tests |

## Commands

- `term make` is the ONLY trustworthy compile signal. `term scan` cannot resolve cross-file imports and reports valid
  code as broken. Never conclude anything from `scan` alone.
- The CLI runs inside a package folder. From the root, `pnpm --dir deck/<name> exec node "$PWD/host/line.js" <verb>`
  runs it there (`$PWD` is the root, expanded before pnpm changes folder).

| task | command | note |
| --- | --- | --- |
| build one package | `pnpm --dir deck/<name> exec node "$PWD/host/line.js" make` | One unit at a time (`compile/separate.ts`): each module is checked once a build against its imports' stubs, cached by its text and their surfaces, emitted to `host/.unit/`, with `host/<path>.ts` exporting what the module reaches. `--merged` is the whole-program build. The two agree on every file of every package (`pnpm term:separate-diff` compares them, exit 1 on a disagreement). A stub must carry whatever a whole-program analysis reads of a body: a new analysis that reads callee bodies reads `stubFacts` for a stub, or separate and merged disagree. A unit's stored answer is keyed by the dependency definitions it reaches BY NAME (`compile/names.tree`), shared machine-wide and portable across clones. A project of 16 files or more builds its units across a worker pool. `--explain` says why each unit was built. `pnpm term:edit-replay` holds the incremental build equal to a clean one under random edits |
| test one package | `pnpm --dir deck/<name> exec node "$PWD/host/line.js" test` | |
| build the stdlib | `pnpm --dir deck/base exec node "$PWD/host/line.js" make --trees` | `--trees` is needed because `deck/base/package.json` carries a `make` script, and a `package.json` make script otherwise REPLACES the `.tree` build entirely (it builds the TypeScript runtime shims). Without the flag `term make` there runs tsc and compiles no `.tree` at all |
| the roll | `node "$PWD/host/line.js" roll exception`, in a project | every exception in the build, who raises it, and whether the app tells it. `term make` also writes `host/roll.json` |
| rebuild the CLI after editing any `.ts` or a ported `.tree` | `pnpm run make:line` | Takes the line lock, then runs `make:port` first (`task/port-build.ts`), which writes every ported toolchain module to `deck/<d>/host/port/` with its native prelude. A bare esbuild of `line.ts` skips that and bundles a stale port, or fails to resolve one on a fresh clone: `hashText` IS `deck/make/code/term/hash.tree`, and `compile/cache.ts` has no TypeScript copy |
| the TypeScript suite | `npx vitest run` | |
| the mill grammar files | `npx tsx test/compile/mill-grammar.ts` | every `deck/mill/code` grammar file parses, loads and finds only what exists. The host and mill roles are held to zero, the rest reported |
| every Term gate, one command | `pnpm term:test` | One line per suite with its count. A toolchain-gated suite is skipped with the reason when cargo, swiftc or kotlinc is absent, and the two Postgres blog suites without `DATABASE_URL`. Suites run concurrently, longest first (`--jobs N`, default the cores minus one). `--only <substr>` runs a subset, `--list` names the suites, `--full` also runs the minute-long three-variable CAD checks (`CAD_FULL=1`), `--fresh` ignores the result cache. Run it before finishing compiler work |
| the data package on the native backends | `npx tsx test/compile/host-native.ts` | the `@term/host` package with its stdlib closure through cargo, swiftc and kotlinc: builds, round trips, fill. `HN_ONLY=rust\|swift\|kotlin` for one. No jars or crates beyond the harness's own. Run it after touching a native emitter |
| no path leaves the repository | `pnpm term:self-contained` | no absolute path, home path or climb out of the root, in the tree or a release payload |

## The draft marker

- An unfinished module stays in the tree but out of the build. `mark draft` on its own line near the top of a `.tree`
  file shelves that file (`note draft` is the old spelling, still honored). A `draft.tree` file in a directory shelves
  that directory and everything under it.
- Both are honored by the build walk (`deck/call/code/make.ts`) and the test runner (`deck/call/code/test.ts`), so a
  shelved module's tests do not run either. Both read the marker as raw text, anywhere in the file, before anything
  parses: `/^(mark|note) draft\s*$/m`, through `declaresDraft` in `deck/call/code/draft.ts` (an unindented line, so a
  `mark draft` indented under a definition does not shelve the file). Every other tool that skips shelved files
  (`task/term/*.ts`, `deck/call/code/files.ts` and its port `files.tree`) tests the same pattern.
- Delete the marker to bring the module back in.

## Compiler phases

| phase | name | what it does |
| --- | --- | --- |
| 0 | Parse | the tree parser produces a generic Tree AST |
| 1 | Build | the mill (mine and mint) produces typed AST nodes |
| 2 | Resolve | annotate with definition references |
| 3 | Expand | ADT self-type encodings |
| 4 | Check | type annotations, purity marks |
| 5 | Generate | emit target code (TS, Rust, Kotlin, Swift, HVM, WGSL) |

## File resolution

- A path `./foo/bar` (no extension) resolves by trying, in order: `./foo/bar.tree`, `./foo/bar/base.tree`,
  `./foo/bar/note.tree`. For a package root (no subpath): `note.tree` first, then `base.tree`.
- Prefer `foo.tree` over `foo/base.tree` for a module without submodules.
- A PACKAGE path `@scope/name/<path>` resolves inside the package's CODE ROOT first, then its package root: `C/<path>`
  by the candidates above, else `P/<path>`. C is what the manifest's `code ./dir` names, `./code` when absent (almost
  always). So `load @term/base/boolean` is `deck/base/code/boolean.tree`, and the older long form
  `@term/base/code/boolean` still reaches the same file (there is no `code/code/`). A bare `@scope/name` names the
  entry: `C/note.tree`, `C/base.tree`, then the same under P.
- `base <dir>` under a `load`, beside `find`, forces the package root: `load @term/site/make/bar` / `base make` /
  `find bar` reads `./make/bar.tree` and never looks in `./code/`. Its value must be the path's first segment, and a
  mismatch fails the build at the load, naming both. It imports nothing.
- A path both roots hold resolves to the code root, and `term lint` warns `ambiguous-load` (L052), naming both files.
  `{platform}` slots fill per env exactly as before, each rung by this rule. Relative loads are unchanged.
- A relative load that resolves to nothing fails the build at the load (`compile/loading.tree` `walk-one`,
  `test/compile/unresolved-relative-load.ts`), whether the file is missing or outside the package and project roots.
  A path with a `{platform}` slot is left to the build on each platform, and so is a load with a `base` under it.
- ONE function decides it: `resolvePackagePath` in `deck/make/code/resolve.ts`. The stdlib, sibling, `link/` and
  own-package resolvers, `projectResolver`, the language server, `term look`, `term scan`, the mill's grammar loads and
  the manifest grammar bundler all call it. `test/compile/code-root.ts` holds the rule. `pnpm term:short-loads`
  rewrote the tree's long loads to the short form, each proven to reach the same file.

## Syntax

### Lean files

THE RULES BELOW ARE THE LONGHAND. A file whose role carries `mark lean` (a package's `role.tree` or `base/role.tree`,
today `deck/call/code/work/**`) is written LEAN, and the rules that say "always `send back`", "`text <hello>`" and
"one `call` per argument line" do not apply in it. Lean is the house style for every self-hosting port. In a lean file:

- `back x` returns. `<x>` is text. A bare word is the variable.
- `f(a, b)`, or `f` with arguments under it, is a call. A head under a call that names a PARAMETER of the callee is
  that named argument (`key <tense>`), and one that names a task is a nested call.
- A fork's arms are `hold` / `miss` with no `hook`. `walk xs` / `take x` iterates.
- A call with no arguments is `f()` or `call f`, never a bare `f`, which is the TASK itself (the checker refuses a
  field read off one, and a `fall` default of the wrong type).
- Keep a head wherever two readings are legal: `call` stays on a call with only `bind` arguments, and `read` stays
  before a path (`read x/y`) and before a reserved word (`read term`).
- A single-child value sits on its parent's line (`save result, make list`, `view p, who`), which `term form` lays out
  and lint L044 (`line-layout`) fixes in a lean file. In a lean file a call-shaped part keeps the parentheses it was
  written with, because it may be a label (only the checker can tell). Outside lean a call in a value position always
  takes them.
- In a `view` body a bare variable is a dynamic text node, the same as `read who`.
- Never hand-convert: `pnpm term:lean-convert <file> --commit` does it, and `pnpm term:lean-equal --only <dir>` must
  read every file equal FIRST.
- Every tool that compiles a file must pass `roleOf` and `leanOf` (`projectRoleOf` / `projectLeanOf` from
  `deck/call/code/role-of.ts`), or a lean file is read as longhand.

### load

Use `find` (not `take`) inside load blocks: `load @term/base/list`, then indented `find get`. Alias an import with
`find get, name list-get`. NEVER `find get as list-get`.

### send back

Return values use `send back`. Simple: `send back, read x`. Complex: `send back` on its own line, the value indented
below. NEVER `send back, make foo` with `bind` children on the next line. If the value has children, it MUST go on the
next indented line.

### Literals

- `text <hello>` for strings. Bare `true` / `false` for booleans. `code 42` for numbers. `wave true` and `mark 42` are
  RETIRED. Do not write them.
- `<<...>>` is a RAW text literal: its content is read exactly as written, no interpolation and no escape, to the `>>`
  ending the first run of `>` on its line. Write a pattern this way: `make pattern, <<\p{Lu}(?<=x)>>`. A literal holding
  a nested `<x>` is written `<\<x\>>`. `test/parser/raw-text.ts`.
- An ordinary `<...>` literal (a bind's text among them) unescapes exactly nine: `\<` `\>` `\{` `\}` `\n` `\r` `\t`
  `\e` `\\`. A backslash before anything else is kept with what follows, which is how a regular expression is written
  in an ordinary literal (`\s`, `\d`), and `|` is not special: `\|` stays the two characters `\|`, so a bind meaning
  JavaScript's `||` writes `||` plainly (`test/compile/bind-text.ts`).

### Grammar scopes

- A stretch of a line can be written in another grammar: `something x, role note, x + y`, `role note(x + y)`, or
  `role note` over an indented block. `role note x + y`, with a space and no comma, is refused, naming the comma it
  wants.
- A name the file's loads import as a grammar needs no `role`: `load @term/mill/text/note` / `find note`, then
  `note x + y`, `note(x + y)`, and `note total = x * 3` on a line of its own (an assignment). A grammar import is
  `find role X` under any load, `@term/mill/text/<g>` finding `g`, or any find under a RELATIVE path ending in `mill`.
- The LEXER hands the scope over whole, as one literal remembering its spelling (`parser/token.tree` `scope-at`,
  `scope` on the text node), since `.tree` cannot tokenize `+`. `compile/scope.tree` `expand-scopes` lowers it to
  Term source before the code grammar, in `mill()` and in the import scan alike, and adds the loads the lowered code
  needs.
- `role code` / `host` / `view` / `site` / `call` / `mill` / `book` are a `role.tree`'s rules and never a scope.
  `role note, <<x + y>>` is the same scope written as a literal.
- A grammar scope is read ONLY by its mill grammar: `deck/mill/code/text/note/mine.tree` IS the note parser, run by
  the text grammar engine (`compile/mine-text.tree`, a memoized PEG made once per grammar), baked in by
  `pnpm term:grammar-bundle` (`--check` gates it). Never write a reader beside a grammar.
- The `note` grammar: arithmetic, comparison, logic, every radix, exact scientific, quantities with REGISTERED units
  (`9.81m/s^2`, `20MB/s`, `$20`, `@term/base/unit` `unit-table`), calls, indexes, members, lists, sets, ranges,
  intervals. An unregistered unit is `scope-refused` at the unit.
- Proofs: `test/parser/grammar-scope.ts`, `test/compile/role-scope.ts`, `deck/mill/test/note/read.tree`,
  `deck/make/test/mine-text.tree`.

### Variables

`read x` to access. `read x/foo` for nested access. `read x/{key}` reads the member named by evaluating `key`. A
LITERAL index is a plain segment: `read x/0`, never `read x/{0}`. `save y, code 20` for assignment. `host x, code 10`
for constants.

### Union tag

A `form` with `case`s is a discriminated union tagged on `form`. `mark tag, name kind` under the form tags it on
`kind` instead: the TypeScript type, every construction, the field-less constants and every `fork case` test use that
field, so a port keeps the shape the TypeScript it replaces declared. The tag VALUES are the case names. The native
backends emit enums and ignore it (`test/compile/union-tag.ts`). The tag READS as a field on every backend (`s/form`,
or `s/kind` under the mark): the case's name as written. A native enum is given one accessor for it only when the
program reads it (`compile/tag.ts`). Writing it is refused (`test/compile/tag-native.ts`).

### Text forms

A closed set of texts is a form marked `mark text` whose cases carry no fields:
`form binary-op / mark text / case plus, text <+> / case minus, text <->`. A case with no `text` is its own name in
snake_case (`case less-equal` is `less_equal`). On TypeScript a value IS its text: the type is the string-literal
union (`"+" | "-"`), `make plus` is `"+"`, a `sift` compares strings, and a TypeScript caller passes `"+"`. Natively it
is a field-less enum. Every such form gets two generated tasks, overloaded by type: `to-text(value)` and
`from-text(text, fallback)`. A case holding a value, or two cases with one text, is refused (`check/text-forms.ts`).
`test/compile/text-form.ts` holds it on TypeScript and Rust.

### Construction

`make user` with `bind field, value` children. `make hash` is the native map (`new Map()` on TypeScript), its entries
`save <key>, <value>` lines under it (a key that is not a word is a text, `save <Two words>, 2`, or computed,
`save <{k}>, 2`: `save/mine.tree` `save-key`, under `make` only), and `make list` the native array, typed as a
`like hash` / `like list` is. `make find` (the older spelling of `make hash`) and a `bind` under `make hash` are
refused. A `make` of a name that is no form and no case of one is refused (`make unit`, `check/type-names.ts`,
`test/check/construction-names.ts`).

### Errors

- `halt` is the one word for stopping the current flow. Bare `halt` breaks a loop. `halt kink` as a child of a `call`
  passes the callee's exception on (like Rust `?`). `halt <form>` with `bind` children RAISES an exception: a `form`
  that is `like exception` or like one of the seventeen stdlib exceptions (`excess`, `absence`, ...) in
  `@term/base/exception`. `halt <text>` raises `failure`.
- A GUARDED BLOCK IS A `fork` with `mark unsafe` as its first line, the statements to try under it, and the
  `halt take` / `take e` after the fork is the handler: `fork` / `mark unsafe` / `save answer, fetch(url)`, then
  `halt take` / `take problem`. A block is always a `fork`. A metadata word never opens one, so `mark unsafe` (or
  `note unsafe`) holding statements itself is REFUSED by name (`pnpm term:guard-migrate --commit`,
  `test/compile/guard.ts`).
- A childless `halt <form>` line on a task SIGNATURE (beside `take` and `like`, before the first statement) is a bound,
  not a raise: the body may raise only what the signature declares, checked through callees.
- A raise is caught on TypeScript, Rust, Swift and Kotlin alike (one `TermException` carrier per backend,
  `test/compile/guard-native.ts`). `bust` and `send kink` are RETIRED and fail the build.
- `term roll exception` lists every exception in the build. See `book/language/errors.md`.

### Exceptions

Declare one as `form upload-excess` / `like excess` / `bind note, <Upload too large>` / `link policy, like text`. Names
are NOUNS for the failure (`absence`, `excess`, `conflict`), never adjectives, never an `-error` suffix. Under a
`like`: `bind` pins a field, `link` adds a prop, `head a, like T` names a type argument. An app decides what a customer
sees with a top-level `tell @deck/form` (`note`, `hint`, `link` children) in `code/tell.tree`. Absent means private. A
`tell` for an exception nothing can raise fails the build.

### Data

- A `.tree` whose top-level heads are all `host` / `list` / `mesh` / `tree` / `fuse` with nothing but those and the
  six literals (`<text>`, `123`, `-3.5`, `0x1f`, `true`, `false`, `void`) beneath is DATA, not code: `term make`
  compiles it to a module exporting the value as JSON, `term mold` converts it (long, `--pack` compact, `--json`), and
  `@term/host` reads it at run time.
- Compact: `h(x,h(y,123),l(a,5,6,7),l(m,m(h(name,<foo>))))`, one entry per line. Keys kebab in the file, snake in
  JSON. `tree name` anchors come first, `fuse name` splices, later keys win.
- `term form` lays a data file out canonically (comments kept), `term lint` reports its grammar (L040), `term look`
  lists its keys, `term mold --lines` reads a stream. A `role.tree` (`role host` / `take @/data/**`) overrides the
  content rule.
- `call fill / <data> / like <form>` fills a FORM: the compiler walks the form's fields (a `data-mismatch` with `path`
  and `reason` when the value does not fit), and `call melt / <value> / like <form>` is the reverse, on every backend
  (a walker per form is generated on Rust, Swift and Kotlin). `fill` without a `like` is the run-time task against a
  shape written as data.
- `@term/host` also has `get-at` (a path), and a stream reader (`make-reader` / `feed`) and writer (`make-writer` /
  `emit`). Its defect messages are word for word the compiler's, and `test/compile/host-term.ts` holds them so. Reader:
  `deck/make/code/compile/host.ts`.
- TWO ENCODINGS, ONE MODEL: `tree/text` is the `.tree` above, `tree/code` the compact encoded form (typed tokens,
  varints, texts and shapes interned per frame, canonical: one spelling per value, so its bytes hash the data).
  Reference codec `compile/host-code.ts` (Zstandard injected, browser-safe), `term mold --code` / `--canonical`. In
  Term: `@term/host` `to-code` / `to-code-all` / `from-code` (`code.tree`, lean), raising `code-defect` by the
  reference's names. In an app: `@term/site/http/code` (`code-response`, `code-of-request`),
  `application/tree+code`, base64 inside the program and bytes on the wire, packed with zstd by the node transport.
  Gates: `test/compile/host-code.ts`, `host-code-native.ts` (Rust, Swift, Kotlin write the reference's bytes),
  `tree-code-http.ts` (end to end), `deck/host/test/code.tree`.

### Arguments

Call arguments are one per indented line. `bind <name>, <value>` under a `call` is a NAMED argument, put in the
callee's declared position by the checker (a name the task lacks, or a name on a `slot`, fails). A
`take p, like T, fall v` parameter fills in when left out. `slot p, like T` is positional only. Two tasks may share a
name with different arities or different parameter types, and the call picks the one its arguments fit. `make form`
with bare values fills the form's `slot` fields in order. A form without slots refuses them.

### Async

- AWAIT BY DEFAULT. A DEFINITION is async with `mark async`: `task read` / indented `mark async`, a child beside `take`
  and `like`, never a wrapper. A CALL to an async task is awaited with nothing written, and the task making it becomes
  async too (`check/async-resolve.ts` infers it through the call graph), so a caller needs no mark of its own.
- `wait true` under a call still reads and means the same. On a call to an async TASK it is redundant, and lint L054
  (`redundant-wait`) removes it. On a call into a `dock load` module it is the ONLY await, because the build cannot see
  that a host function returns a promise, so it stays there (lean: the prefix `wait f(x)`), UNLESS the load line
  carries `mark async` (`load <node:fs/promises>, name fs-promise` / indented `mark async`): every call into that
  module is then awaited with nothing written and makes its caller async (`check/async-resolve.ts` `asyncDocksOf`),
  L054 reports its `wait true`, and any other word under a load line is refused (`test/compile/host-async.ts`).
- A `bind` whose host code answers a promise carries `mark async` too (before or after its takes or `like`), and a
  call to it is then waited exactly like a call to an async task: awaited by default, `tick` outside a task, a tick's
  job never read as the answer. A field read off an UNMARKED bind's promise is refused as `missing-wait` where the
  text's shape says it is one (`new Promise`, `Promise.all`, `fetch(`, `import(`, a `.then` chain). Any other shape is
  known only by the mark. A bind whose promise is a VALUE for more host code (a queue, a promise kept and waited later)
  stays unmarked (`test/compile/async-bind.ts`).
- `tick f(x)`, or `tick f` over its arguments, starts the call and does NOT wait: on every backend it runs at once to
  its first wait and the rest runs while the caller goes on. As a statement it fires and forgets. In a value position
  it is the pending JOB, `spawn` of the call (`check/pending.ts`): `save work, tick fetch(x)` is a `handle r` from
  `@term/base/task`, read back with `work/wait()` (never `wait(work)`, which is the await marker). The file must load
  `@term/base/task`, and the build says so. Jobs interleave at their waits on every backend (one thread: Rust's
  executor in `compile/rust.ts`, Swift `Task.immediate`, Kotlin's `termLoop`, `test/compile/spawn-native.ts`).
  `call f / wait false` is the older spelling. `tick` on a task that is not async is an error naming the task, a
  `wait` under a `tick` is refused, and `tick` is a reserved head.
- OUTSIDE every task (a top-level `host` or statement, a `view` body, a closure there that is not async) nothing can
  wait, so an un-ticked call to an async task is an error, `async-outside-task`, naming `tick`. The switch is
  `setAwaitOutsideTasks` in `check/effects.ts`. A file that loads a `{platform}` module keeps its markers when its Rust
  build fails alone: a callee can be an async task on one backend and a binding on another. Where inference cannot make
  the caller async (a callback parameter typed async) the message says `mark async` or `tick`.
- `test/compile/tick-native.ts` holds the start on all four backends, and `test/compile/await-mark.ts` the rest.

### Task parameters

Task-typed params need a nested `like task` with `take` children: `take body` / indented `like task` / indented
`take dir, like text`.

### Types

- A CONTAINER IS INVARIANT IN A LOOSE ELEMENT: `unknown` and `dynamic` are gradual for a value only. A list, a hash key
  or value, or a form's type argument holding `unknown` or `dynamic` does not fit one holding a settled type, in either
  direction at any depth, on all four backends, and a signature's own `head t` counts as settled in its body. The
  type-mismatch names the three ways out: make the callee generic (`head t`), declare the source loose from its first
  line, or copy it by name, walking and pushing. Not refused: a list or hash made in place (below), two loose words
  meeting (`unknown` and `dynamic` are one representation, so a callee's push is seen), and an element not yet pinned,
  which takes the loose word so later pushes box. A literal the wanted type does not reach, one assigned
  (`save h/items, make list(<a>)`) or handed to an overloaded task, infers itself, so one of a single type is a list of
  T and is refused. Overload fit agrees (`fits-type`). `test/compile/list-loose-native.ts`.
- `like unknown` is the GRADUAL type: consistent with every type, both directions. Use it for a parameter that takes
  any Term value and is narrowed at run time (`deep-equal`, `assert`). Without it, inference pins the parameter to its
  first use and every other call site becomes a type error.
- `like dynamic` is the host's `any` at the FFI boundary. Also consistent with everything, but it means "this crossed a
  native boundary", not "this is polymorphic".
- Natively, `unknown` is the boxed dynamic: `std::rc::Rc<dyn std::any::Any>` on Rust, `Any` on Swift and Kotlin, `any`
  on TypeScript. Rust boxes at the construction site (record fields, call arguments, returns, declared-unknown lets).
  `test/compile/unknown-native.ts` holds it on all three toolchains. A field with no `like` at all (an opaque
  `link dock, mark private` handle) is unknown too and so carries any record.
- A BARE `like list` / `like hash` leaves its element (key, value) a fresh inference variable filled from usage, so a
  native backend emits the concrete element (`SeedList<String>`). A list that mixes elements says
  `like list, like unknown`. A local made as an empty list with no `like`, in a task whose result is
  `like list, like unknown`, takes that type at its `save` when the body hands that local back, so its first push does
  not pin the element (`check/inferring-expressions.tree` `declared-by-return`).
- A list or hash MADE IN PLACE as a direct call's argument, a field, a result or a declared let takes the wanted type
  when that type holds `unknown` or `dynamic` at any depth, so `run(sql, make list(id, 1))` is how a mixed list is
  written, and each element boxes (`infer-wanted`, `test/compile/list-loose-native.ts`).
- `dynamic` is the boxed dynamic too, on all four. On Rust it is `Rc<dyn Any>`: a JSON text, number, boolean or null is
  the Term value in the box, a JSON array or object a `serde_json::Value` in the box read through `@term/base/json`,
  and two loose values compare through the runtime's deep equal (`test/compile/dynamic-native.ts`).
- `dock type / load <any>, name x` is the portable opaque handle: each backend maps it to its own dynamic.
- A signature-only task (no body) emits a stub natively (`TODO` / `fatalError` / `unimplemented!`), so a
  declaration-only module still builds.
- A generic form must apply its own type argument in self-references: `like linked-list t`, not `like linked-list`.

### Branching

- `fork test`: `hook test` (condition), `hook hold` (then), `hook miss` (else). Several `hook test` / `hook hold` pairs
  make an if/else-if chain.
- `sift <value>` is the match, exactly `fork case, <value>` (the same mill form, the same output on every backend), in
  every file. `fork case` stays the longhand, and lint L042 rewrites it to `sift` in a lean file.
- `fork case`: `case <name>` children (NOT `hook <name>`). Inside an arm the variant's fields are locals by their own
  names, TYPED (a method call on one dispatches to its form). A leading run of `link <name>` lines under the `case`
  either SELECTS fields (every name is a field of the variant) or RENAMES them in declaration order (any name is not a
  field), so `case text` / `link content` binds the `value` field as `content`, and a `read value` beneath reaches the
  outer `value` again. One rule for the checker and every backend: `deck/make/code/check/arm.ts`. A field named like an
  outer variable shadows it, so rename when you mean the outer.

### Looping

- `walk list, read items` / `hook next` / `take site, name item` for list iteration. `walk size` with `bind base` /
  `bind head` for ranges. `walk test` with `hook test` / `hook hold` for while loops.
- `turn next` for continue. `halt` for break.
- `walk xs, name outer` names a loop, and `halt, name outer` / `turn next, name outer` leave or continue it from inside
  a loop nested in it. A name no loop around it has, a loop named like one it sits in, and `halt, name x` with anything
  else on it are refused. Every backend writes a loop label (`test/compile/loop-name-native.ts`).

### Comparison

`is-above` (not is-greater-than). `is-below` (not is-less-than). `is-minimum` (not is-greater-than-or-equal).
`is-maximum` (not is-less-than-or-equal).

### Arithmetic

A numeric literal cannot be a method receiver. `call 24/subtract` is invalid. Nest instead: `call subtract` /
indented `code 24` / indented the other operand, or `call subtract(code 24, read x)`.

### Comma chains

The tree syntax is GENERIC and knows nothing about head terms. Term is a layer of special keywords within it, so no
nesting rule is ever stated in terms of `call` or `bind`.

- Only two things change depth. A SPACE nests: `a b c` is `a > b > c`. A COMMA POPS EXACTLY ONE LEVEL: the part after
  it is a sibling of the part before it, however deep that part had nested. So `foo bar baz bang boom, a b c, d e f`
  puts `a` beside `boom` (under `bang`) and `d` beside `c` (under `b`).
- Two floors stop a comma, the head of the line and an enclosing parenthesis, so the head stays open for what follows.
  A LITERAL and a CALL CLOSED BY ITS OWN PARENTHESIS open no level, so a comma after one has nothing of its own to pop
  and STAYS AT THAT PART'S LEVEL: `want hold, is-equal get(found, 1), 14` gives `is-equal` two arguments, and
  `code <1.x.x>, have 1` puts `have` under `code`, beside the literal. `test/parser/file/comma-depth.tree` is the rule,
  and `CommaAfterLeaf` in `parser/event.ts` the parameter a migration passes to `parse`.
- CONSEQUENCE: a multi-word part cannot be followed by a comma, whatever it ends in. `call add, read a, read b` puts
  `read b` INSIDE `read`, beside `a`, and `call add, code 1, code 2` puts `code 2` inside the first `code`. Write each
  argument self-contained (`call add, read(a), read(b)`, `call add, code(1), code 2`), or put the arguments on their
  own indented lines, which is built from indentation alone and is how most of the codebase reads:

  ```
  call add
    read a
    read b
  ```

- The mill takes the callee's own children as its arguments, so `call f(a, b)`, `call f, a, b` and the stacked form
  resolve to the same call even though they build different trees.
- A head that takes one value (`save x, V`, `send back, V`, `bind f, V`) REFUSES a trailing extra with a message, so a
  value cannot go missing that way.
- The same comma under `make`: `f(make list(a), b)` is `make > list(a), b`, so `b` is not f's next argument. A
  construction with values under its name AND a part beside it (by comma or by an indented line) is REFUSED, naming
  both spellings: `f(make(list, a), b)` for f's next argument, `make list(a, b)` for one more item.
  `test/check/make-split.tree` is the rule.

### Multi-word values

Every word after a head reads as a head of its own, so a multi-word value becomes a nested group. `task tsc` carries
one term, and `task vitest run` parses as task > vitest{run}. Reconstruct the phrase by walking head plus terms
recursively. Reading only the first term truncates it.

### Templates

- `fuse` / `tree` / `hook fuse` for template (macro) syntax. Template parameters substitute via `{param}`
  interpolation, never `read param`. A hole's `take` may say its kind (`like name`, `like number`, `like text`,
  `like boolean`) and a `fall` default.
- Every `fuse` must fit its template or it is refused AT THE FUSE: every hole filled (or `fall`), no value too many, no
  `bind` / `beam` the template lacks, each value of its hole's kind, a template the build has (`compile/template.ts`,
  `test/compile/template-holes.ts`).
- ONE BRACE SYNTAX for interpolation in a text literal, `{x}` / `{e/form}` / `{add(a, b)}`, and the compiler decides
  when it is filled: a template parameter at expansion, a module constant (a top-level `host` that folds) at COMPILE
  time so the output is a plain literal (`ir/simplify.ts` `fillTemplates`), anything else at RUN time (a template
  literal on TypeScript, `format!` on Rust, `\(x)` on Swift, `$x` on Kotlin). A name that names nothing is an unknown
  name. `{{x}}` is the older spelling of the same thing, and lint L043 rewrites it. Literal braces are `\{` and `\}`.
  `test/compile/lean-second.ts` holds all of it.

### Native calls

- `dock load` imports native modules: `load <node:fs/promises>, name fs-promise`. `call fs-promise/read-file` calls
  `readFile` on that module.
- A public stdlib module spells the platform slot EXPLICITLY: `load .../native/{platform}/<name>`. `withNativeEnv`
  fills `{platform}` with the target env, then the borrowed sibling env (cloudflare to browser), then the abstract
  module beside the env dirs (`native/serve.tree`) when one exists. The implicit `.../native/<name>` rewrite is
  RETIRED: an abstract path resolves as written or not at all.
- `dock type / load <NativeType>, name x` declares an opaque per-backend handle type. A field read off such a handle is
  refused outside a `native/<backend>/` file: no backend can be told what it is.
- A host value bound with a `like` of text, number or boolean is checked at that binding on TypeScript (`__termHost`,
  raising `data-mismatch`, `test/compile/host-value.ts`).

### mark (all metadata)

- Metadata is `mark`, and every word is read by something or refused.
- ON A TASK: `mark async`, `mark private`, `mark roam` (meant to run forever), `mark open` (a claim left open),
  `mark deprecated` (a call from another file warns).
- ON A `fork`, its first line: `mark unsafe` makes the fork a guarded block (the `halt take` after it is the handler).
  A `mark` never holds statements of its own.
- ON A FILE, unindented at the top level: `mark draft` shelves it out of the build, `mark stable` / `mark unstable` say
  whether v1 promises the module (`pnpm term:base-marks`). Under a task those three are refused.
- `mark native` under a `dock load` is REFUSED: `dock` already says the module is native. `mark feature`,
  `mark platform`, `mark keep` and `mark exact` are refused until something reads them.
- The mill reads `mark <word>` as the same form `note <word>` built (`deck/mill/code/tree/code/note/mine.tree`,
  `mine mark-note` / `mine mark-guard`), so the two emit the same program. `note <word>` as metadata is the OLD
  spelling: still read, warned as `note-metadata` (the entry file's own), and rewritten by `term lint --fix` (L053).
  Which `note` is metadata is decided once, by form, in `check/note-metadata.ts`.
- `note` otherwise means documentation: `note <A sentence.>`, and a field NAMED note (`bind note, <...>` on an
  exception) is not metadata. `rest flow` for breakpoints. Logging is `info` / `warn` / `error` from `@term/base/log`.

### mark (the other meanings)

`mark` is NOT a variable binding. Its meanings, told apart by FORM:

- `mark <word>` with a word from the closed metadata list is metadata (above).
- `mark private` on a task: visible ONLY inside the file that defines it, ENFORCED. A call, a value reference, or a
  `load ... / find` of it from any other file fails as `private-name`, naming the file (`check/private.ts`). Exact, by
  binding: a same-named parameter or local elsewhere is not refused, nor is a call that may bind to a public definition
  of the name (an overload). A file under the package's `test/` may use the package's privates. `note private` is the
  OLD spelling: still honored, warns as `note-private`. `mark private` on a record FIELD (`link dock, mark private`) is
  field privacy, a different thing.
- `mark <uuid>`, a TEXT LITERAL, is the durable IDENTITY of a record. This is what `mark` will always mean.
- A theorem's variable is NOT a `mark`: it is a `seat` (below). `mark x, like t` under a `rule` or its `have` is
  REFUSED by name (`mint-bridge.ts` `refuseMarkBinders`).
- A twin's knob is the one `mark` with a `like` left (`mark tile, like number`, `twin/mine.tree`).
- A variable binding is `save x` or `host x`. Never `mark x`.

### seat

`seat <name>, like <type>` inside a `rule` declares a universally quantified variable of a theorem
(`rule collide-is-reversible` / `seat a, like tone`): a place in the law every value of its type may fill. Under a
`have` it quantifies that hypothesis alone (`have symmetric / seat u, like a / is-equal r(u, v), ...`), and the prover
uses it at the terms the goal names. A seat with no `like` takes its type from use, and one with a `like task` and
`take` lines under it is a function. `seat` is the ONLY binder spelling. `pnpm term:seat-migrate` (`--ts`, `--md`)
rewrites a tree, the tests' template literals or the docs, each `.tree` file proven by its tree. The mill:
`rule/def/mine.tree` `rule-seat`.

### rule

A `rule` OWES something, and the build refuses it until it is paid. Two shapes, told apart by whether the rule states a
`show` goal.

- NO `show` is a CLAIM: a name declared at a type. `head` is a generic, `take` a parameter, `like` the result. A `task`
  of the same name proves it, and that task states the name and its bare parameters only, because it INHERITS the
  claim's generics, result and parameter types. An unfilled claim is an error (`open-claim`), and running code may not
  call one (`open-claim-used`). `mark open` leaves it open on purpose: it compiles, the build line reports the count,
  and it still may not be called (`note open`, the old spelling, still works).
- A `show` is a THEOREM over its binders: `seat` is a universal binder, `take` / `have` a hypothesis, `find` an
  existential witness, `base true` postulates it as an axiom, and the proof steps are `hold`'s own vocabulary. A goal
  the prover REFUTES is an error, and so is a goal it cannot REACH: not proven is not proven.
- Never write a proof as `test <name>`. The test preprocessor rewrites a `test` block into a task returning a boolean,
  which proves nothing. A proof term is a `task`.
- A claim's `task` is a proof only if the kernel checks its whole body as ONE term against the claim's type, it
  terminates, and it is pure. Otherwise `unverified-proof`, `looping-proof` or `impure-proof`. The lemma-search step is
  `seek` (it was `auto`).
- Equality is an indexed family: `like equal a / head / read x / head / read y`, NEVER `like equal a x y`, which puts
  the values where type arguments go. A value used as a type index is always a `head` child with `read`. A type family
  is a parameter that is a task to `type`, used as `like p / head / read x`. When a match must rewrite a variable
  already in scope, match in a helper returning a function (the convoy: `chain`, `carry` in `deck/base/code/proof/equal/`).

### Contracts

A task's signature may carry `have` (a precondition the body assumes and every caller must prove) and `must` (a
postcondition, where `read back` is the value being returned). A `walk` may carry `must` (an invariant: true before
the walk and at the end of every turn) and `down` (a natural number that falls every turn). Each takes one expression,
the way a `hold` does. None of them runs: the checker lowers them into holds in its own copy of the program, and an
unproven one fails the build.

### term hold

`term hold` is THE gate: every file compiles, no claim is `mark open`, and every tier-0 obligation (a list read inside
its list, a division by something other than zero) is proven or named in the project's `hold.json`. One line, non-zero
exit. `--commit` rewrites `hold.json`, which may only shrink. `term make` prints the tier-0 count on every build and
never fails on it.

## Naming

- A NAME IS SCOPED TO ITS MODULE and reaches another module only through `load ... / find`. The build still merges
  every module into one flat program, and binds by import on top of that merge. A task, a component or a form with
  definitions in two or more files is SPLIT BY FILE (each file's renamed `name__in<g>_<k>`, the entry file's keeping
  its name), and every reference is bound by WHAT ITS OWN FILE IMPORTED: its own definition, else the file its `find`
  reached or that file's `bear` chain. Tasks and components: `check/overload.ts` `bindByImport`. Forms, their methods,
  mask instances: `check/scope.ts` `bindFormsByImport`, which runs before `extendForms`. A reference imported from more
  than one definer is refused as `duplicate-definition`, naming the files. A reference that NO import reaches still
  gets what the flat program gave it: a call the one file whose arity fits (or the checker's choice by type among
  several typed apart), a form the last of its definers in file name order. That fallback is the gap left:
  `pnpm term:scope-census` counts what relies on it.
- ONE NAME MAY BE TWO KINDS OF THING: a task and a form called the same are told apart by WHERE THE NAME STANDS
  (`call x` is a task, `like x` and `make x` a form, `view x` a component), so `find x` with no alias imports both. The
  kernel keeps them apart on its own copy (`check/elaborate.ts` `kindsApart`). `test/check/module-scope.ts` holds all
  of it. Never rename or qualify an identifier to dodge a collision: the binding handles it, and if it does not, that is
  a defect in the binding.
- A PRIMITIVE WORD IS SCOPED. A form that writes a `case`, a `link` or a `slot` is a real form, whatever its name,
  `name <Native>` or not. In the module that declares it, and in a module whose `find` reaches it, its word names it.
  Everywhere else the word is the language's own. A form that writes none of those stays the primitive's methods. The
  words are `compile/surface.tree` `primitive-of` plus `list`, `hash` and `task`. Inside a module holding the real form
  the primitive is reached by another word of its entry (`integer` or `native-number`, `native-string`,
  `native-boolean`, `void` or `native-void`). `like task` with a `take`, a `halt` or a result under it stays the
  function type. The mint decides from its own file (`compile/minting-reads.tree` `words-in-file`), the binder settles a
  `find` (`check/scope.tree` `settle-words`), and such a form always takes a split name, so no backend has a rule for
  it. Limit: a `find x, name text` keeps `text` the primitive, and `host x, text <a>` in a module holding a real
  `form text` is typed as the form and refused.
- No redundant suffixes on form names. `form command`, not `form command-schema`.
- Forms CAN be namespaced (`command-flag`, `command-argument`). Tasks CANNOT (`task make`, not `task command-make`).
- A TASK IS NAMED WITH A VERB: `make-text`, never `text`. A bare noun names a form, a view (component) or a value. A
  noun-named task takes the name a component or type needs. When one blocks a name, rename the task to its verb form.
- kebab-case for all folders and files. Exception: C files (`hvm_lib.h`) and Xcode (`module.modulemap`).
- Functions with 2+ params use a single object input param, not positional args.

## Code generation

- Compile-time unwrap for flag-based APIs. The compiler erases overloaded flag params into direct platform calls at
  compile time. No runtime branching on flags.
- `like text` desugars to `Ref("String")`, which emits `String` in Rust.
- Rust backend: concrete enum types, type inference from the Ann/All chain, `impl Fn(A) -> B` for closures.
- The TypeScript backend should eventually split: one for Node.js, one for the browser.

## Stdlib layout

- Types live directly in `code/` (`code/boolean.tree`). Traits live in `code/mask/`. Platform impls live in
  `code/native/<platform>/`.
- Import paths: `@term/base/boolean`, `@term/base/native/node/file`. The package path resolves inside the code root
  (`code/`) first, so the `code/` segment is not written (see File resolution).

## On disk

- Everything Term keeps on disk lives under `.base/@term/code/`, the toolchain package's own name: a project's build
  cache, memory, boot markers and logs, and the user-level installs, auth token, signing key, link registry and shared
  caches under the home folder. It was `.base/term/` and then `.base/@cluesurf/term/`. The second rename MOVES the
  folder: `home.ts` `settle`, run by `projectHome` / `userHome` and at CLI startup, renames it whole and leaves a link
  at the old name (merging entry by entry when both exist, using the old folder whole when the rename is refused), and
  renames the five `.gitignore` rules `term wake` wrote. Proof: `npx tsx test/call/home-move.ts`. A path that names the
  old folder on purpose (wash, halt, the installer's PATH rewrite, `@term/deck`'s read fallback) says so beside it.
- The path is written in ONE place, `deck/call/code/home.ts`. A missed copy does not fail: it reads an empty cache, or
  writes a fact into a directory nothing looks in. `projectHome(root, ...)` and `userHome(...)` build it.
- `@term/deck` spells the constant out locally instead of importing it, because that package is PUBLISHED and consumed
  as an installed package, so it must not reach back into the CLI's source. `home.ts` is still the source of truth.
  Keep the two in step.
- Anything that CANNOT BE REBUILT reads through `keptAt(current, legacy)`: a remembered fact, an auth token, a signing
  key, the link registry. If the new location is absent and the old one exists, the old one is used WHOLE, so a rename
  cannot lose a file and cannot half-migrate one. A cache does not go through it, because the next build regenerates
  it.
- Environment variables are `TERM_*` (`TERM_CACHE_HOME`, `TERM_HTML`, `TERM_MODEL`, `TERM_FLOW_SERVER`, `TERM_TOKEN`).
  The `SEED_*` spelling is still honored so an existing shell profile keeps working, via `env()` in `home.ts`. Never a
  bare `TERM`, which is the terminal type every POSIX shell sets.
- `TERM_TOKEN`, else the user-level `auth` file (`~/.base/@term/code/auth`, the token alone), is a term.surf token from
  term.surf/settings/tokens with `package:publish`. `term host` reads it (`call/code/host.ts`, `readIndexToken`) and
  sends it ONLY to the package index ping, with a claim signed by the version's key, so the index credits the version
  to that account. It never reaches a registry: pushing uses `TERM_OCI_TOKEN`, `GHCR_TOKEN` or the docker config.
  Without it the ping is anonymous and the version is indexed all the same. `term bind` writes that file
  (`call/code/bind.ts`): a Google login through the browser and a loopback listener, the code swapped by tool.term.surf
  (`/sessions/terminal/create!` and `verify!`) for an ordinary `package:publish` token. `term bind --toss` deletes the
  file and does not revoke the token.
- An INSTALL of the `term` command (`curl -fsSL https://term.surf/load | sh`) lives under `~/.base/@term/code/`:
  `call/term` links to `code/<version>/term/bin/term`, and `code/<version>/install.tree` names the version, platform
  and layer digest. `term self check|update|back` (`call/code/self.ts`) reads that `install.tree` through `readTree`,
  never a hand parser. Releases are `@term/code` at `ghcr.io/cluesurf/term/code`: an image index per version, one
  signed manifest per platform (`deck/deck/code/oci/release.ts`), built and published by `pnpm term:release`
  (`task/release.ts`). `TERM_RELEASE_REGISTRY=oci://host/namespace` moves both publishing and `term self` to another
  registry. End to end: `npx tsx test/call/self-release.ts`.
- MANY VERSIONS, ONE PER PROJECT. Every installed `term` starts in `host/need.mjs` (`call/code/need-run.ts`), which
  resolves the version this command runs and imports `host/line.js` in-process when it is itself, or hands over to
  `code/<v>/term/host/need.mjs` as a child. The order: `+<range>` as the first argument, `TERM_VERSION`, the nearest
  `deck.tree`'s `need @term/code, mark <2.6.x>` (exactly its `lock.tree` pin while the pin satisfies it), `need.tree`
  under the home (`term self pick`), the front (`call/term`), the newest installed. A version not here is installed on
  first use, verified, unless `TERM_NEED=local`. Resolution is `call/code/need.ts` and reads every file with
  `readTree`, never a pattern. The one install path is `call/code/need-load.ts`. `term self` runs on the front, never
  on a project's version. Verbs: list, find, load, pick, need, show, toss, wash, check, update, back. `call/term` is
  the FRONT, not the version that runs. Proof: `npx tsx test/call/need-resolve.ts`, `test/call/self-release.ts`,
  `pnpm term:need-bench`.

## Never

- Glob or grep the whole repository. Always scope to specific subdirectories.
- Trust `term scan`. Only `term make` proves a file compiles.
- Use `take` inside `load` blocks (use `find`).
- Write `find X as Y` for an import alias. It parses without binding, silently, and the failure surfaces much later as
  an undefined name. Use `find X, name Y`.
- Use `term` for strings (use `text`).
- Use `back` for returns outside a lean file (use `send back`).
- Write `wave true` / `wave false` or `mark 42`. Use bare `true` / `false` and `code 42`.
- Write metadata as `note`. Metadata is `mark`: `mark async`, `mark unsafe`, `mark draft`, `mark private`. Never
  `mark native` under a `dock load` (refused). `note async` is the old spelling and warns. Never write `wait true` on a
  call to an async task (it is awaited already), never call an async task outside a task without `tick`, and neither
  `mark` nor `wait` is ever a parent wrapper.
- Name tasks with module prefixes (`task command-make`). Use plain verbs (`task make`).
- Put docs inside a package folder. Documentation goes in `doc/` at the root.
- Commit an absolute path, a home path into one machine's layout, or a relative path that climbs out of the root.
  `pnpm term:self-contained` fails on one, and a fake root a test needs goes on `task/term/self-contained.allow`.
- Add Co-Authored-By to HVM fork commits.

## Always

- Rebuild `host/line.js` with `pnpm run make:line` after editing any compiler or CLI `.ts`, or a ported `.tree` under
  a toolchain package, or you will measure a stale binary.
- Run `npx vitest run` and `pnpm term:test` from the root before finishing compiler work.
- Treat a RISE in error count after a fix as revelation, not regression. A file that starts parsing exposes everything
  behind its first error. Read the new errors before assuming you broke something.
- Use `foo.tree` (flat file) instead of `foo/base.tree` for modules without submodules.
