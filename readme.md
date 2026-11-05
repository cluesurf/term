<br/>
<br/>
<br/>
<br/>
<br/>
<br/>
<br/>

<p align='center'>
  <img src='https://github.com/cluesurf/term/blob/make/view/term.svg?raw=true' height='192'>
</p>

<h3 align='center'>
  term
</h3>
<p align='center'>
  A reactive modeling language Ψ
</p>

<br/>
<br/>
<br/>

## Introduction

Term is a programming framework built on a simple, indentation-based
syntax (the [tree](https://github.com/cluesurf/tree) format). You write
the logic once, and one source compiles to idiomatic Rust, TypeScript,
Kotlin, and Swift, so the same program runs in the browser, on Node, on
native servers, and on iOS and Android. It is dependently typed with a
rich type system, ships with a full toolchain (compiler, package
manager, and language server), and is designed so the compiler can reach
near-optimal native code on each target without the author giving up a
clean, readable surface.

Every platform has its own language, its own build tools, its own
ecosystem. Writing an app that runs on servers, browsers, iOS, and
Android means learning four toolchains, maintaining four codebases, and
watching them drift apart. The logic is the same. The plumbing is not.

Dart, through Flutter, has a comparable multi-platform reach but
different goals: Term emits each platform's native idioms rather than
shipping one runtime, and puts a formal type system and proof checker at
the center. Kind is the closer relative on that side, a dependently
typed language with a small kernel, while Term aims more squarely at
building real cross-platform applications.

You write the usual types, classes, functions, and data models. Beyond
that, templates can parse the tree AST directly, so the boilerplate of
building a structure of any shape is generated rather than written by
hand.

The kernel underneath is a small dependent type theory: quantitative
type theory (each value tracks how many times it is used), observational
equality, a cumulative universe hierarchy, and self types. On top of it,
a `.tree` file can state a theorem and prove it by structural induction,
rewriting, and a fixed set of proof steps, and the kernel checks the
proof. The same checker verifies ordinary code, discharging assertions
through decision procedures for linear arithmetic, ring identities,
congruence closure, and nonlinear non-negativity.

Most types are inferred, and a language server gives live diagnostics,
hovers, completion, and go-to-definition, with a parser that recovers
from errors instead of stopping at the first one. Compilation is
incremental, rebuilding only the modules that changed, and the package
manager follows the pnpm model, with a content-addressed store and
linked dependencies.

Doing this optimally is the hard part. Because meaning is fixed by the
type system rather than by how the code is phrased, the backend is free
to specialize, monomorphize, and lower aggressively per target, so speed
comes from the compiler rather than from the author writing awkward
code.

On the application side, the standard library is written in `.tree`, and
each part maps to its native counterpart. It covers:

- the usual primitives
- collections
- IO
- text
- time
- cryptography

The web stack is
reactive in the fine-grained style, updating the DOM directly through
signals rather than diffing a virtual DOM, with server-side rendering,
client takeover, and hot module reload.

## Toward Optimal Programs

The goal with Term is to iterate and refine code toward maximal
performance while keeping it clearly readable on the other end. These
have always been treated as a trade-off: you write it the way you want
to read it, or you contort it into the shape the machine wants. Term is
built on the premise that they are two representations of one meaning,
and that the translation between them is the compiler's job, not the
author's.

With AI in the loop, that translation becomes an almost automated
process. You write the program as you want to read it. An agent then
iterates on the lowering: profiling the emitted Rust, TypeScript,
Kotlin, or Swift, trying alternative specializations, measuring, and
keeping what wins. Because the type system fixes the meaning precisely,
every rewrite can be checked against the source for equivalence, so the
loop can run unattended without drifting from what you wrote. The proof
kernel makes this stronger than testing: a transformation is not just
plausible, it is verified.

Compilers already do this within a fixed budget of built-in passes. The
difference is that the search no longer has to stop where the pass list
ends. Optimization becomes an open-ended refinement process that
accumulates: each program converges toward the best known lowering for
its targets, and improvements found for one program feed back into the
shared patterns used by all of them. The readable source stays the
single artifact you maintain. Everything below it is regenerated,
re-verified, and only ever gets faster.

The end state is that the performance ceiling of a Term program is the
performance ceiling of the hardware, not of the author's willingness to
write unreadable code. You describe the program once, clearly, and the
toolchain carries it the rest of the way to essentially optimal machine
behavior on every platform it touches.

## Install

Term installs as one command, `term`, with one line in a shell:

```sh
eval "$(curl -fsSL https://term.surf/load | sh)"
```

or, with Homebrew:

```sh
brew install cluesurf/tool/term
```

Both install the same signed release, `@term/code`, from
`ghcr.io/cluesurf/term/code`, built for:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64`
- `linux-arm64`
- `windows-x64`
- `windows-arm64`

Each checks the download's sha256 against the registry's digest, and the
release signature against the `@term` key set, before anything goes on
your `PATH`. It writes under `~/.base/@term/code/`, and adds one marked
line to your shell's profile putting its `call/` folder, which holds the
`term` command, on `PATH` for new terminals, once. `TERM_LOAD_PATH=0` edits no profile and prints the line
instead.

Term runs on Node.js 22.3 or newer.

```sh
term --version     # 2.9.2
term self update   # the newest release, verified, beside the current one
term self back     # back to the previous version, no download
```

A Homebrew install updates with `brew upgrade cluesurf/tool/term`.
Windows, apt and dnf are under [Installing on each platform](#installing-on-each-platform).

The guides, from a first program to proofs, native apps and the package
registry, are at [term.surf/guides](https://term.surf/guides).

## Packages

This repository is a monorepo. Each part of the ecosystem is a deck (a
package) under `deck/`. A deck's name comes from the `deck <name>` line
in its own `deck.tree`, not from `package.json`, and the decks import
each other by that name (`@term/base/code/list`), linked locally through
`term link`.

The compiler, CLI, language server and package manager began in
TypeScript (under each deck's `code/`), and are being ported to `.tree`
one module at a time ([Self-hosting](#self-hosting)). The standard
library, the app framework and everything else are written in `.tree`
and compiled by the compiler itself.

## Finding your way around

The repository's folders, and what each one holds:

```
.
├── deck/                 every package
│   ├── make/             @term/make   the compiler
│   │   └── code/
│   │       ├── parser/   .tree text to a generic tree, and diagnostic codes
│   │       ├── compile/  mill to typed AST, then one emitter per backend
│   │       │             (typescript.ts, rust.ts, kotlin.ts, swift.ts, wgsl.ts)
│   │       ├── check/    type inference, the kernel, the prover, contracts
│   │       ├── ir/       the optimizer's passes
│   │       ├── lint/     lint rules
│   │       └── format/   the formatter
│   ├── mill/             @term/mill   every grammar
│   │   ├── code/tree/    the tree dialects, a mine.tree and mint.tree each (code, view, host, zone, ...)
│   │   ├── code/text/    text format readers (json, hex, ...) and embedded grammars (note)
│   │   ├── code/blob/    binary format readers (gzip, pdf, font/otf, ...)
│   │   └── code/feed.tree  the byte and text cursors every format reader reads
│   ├── call/             @term/call   the CLI, built to host/line.js
│   │   └── code/         line/base.tree is the console, make.ts the build driver,
│   │                     test.ts the test runner, hold.ts the proof gate
│   ├── flow/             @term/flow   the language server
│   ├── deck/             @term/deck   the package manager
│   ├── base/             @term/base   the standard library, all .tree
│   │   ├── code/         one file per type (list.tree, text.tree, ...)
│   │   │   ├── mask/     traits
│   │   │   ├── proof/    equality and proof lemmas
│   │   │   └── native/   per-platform impls (node, browser, rust, swift, kotlin, shared)
│   │   ├── test/         stdlib tests
│   │   └── hold.json     the proof baseline `term hold` reads
│   ├── site/             @term/site   app framework: DOM, http, graphics
│   ├── face/             @term/face   headless UI components
│   ├── bind/             @term/bind   typed platform bindings, the largest deck
│   ├── host/             @term/host   the data dialect, read at run time
│   ├── cask/             @term/cask   native app shell: window, WebView, bridge
│   ├── mark/             @term/mark   the benchmark runner behind term mark
│   ├── scan/             @term/scan   dependency and advisory scanning
│   ├── save/             @cluesurf/save  version control for structured data
│   └── test/             @term/test   fuzzing, benchmarks, model checking
├── mark/                 the benchmark programs term mark times
├── task/                 build, release and gate tooling (task/term/test.ts is the gate)
├── test/                 the TypeScript suites, by area (parser/, check/,
│                         compile/, call/, native/, ...)
├── host/line.js          the built CLI. Rebuild it after editing any .ts
├── link/                 locally linked decks
└── deck.tree             this workspace's own declaration
```

Where to start digging:

| you want | open |
| --- | --- |
| what a keyword means | [term.surf/guides](https://term.surf/guides), then the dialect in `deck/mill/code/tree/` |
| why a file fails to compile | `deck/make/code/check/` |
| what a backend emits | `deck/make/code/compile/<target>.ts` |
| what a CLI command does | `deck/call/code/line/`, then the file it dispatches to |
| a stdlib type or task | `deck/base/code/<name>.tree` |
| the tests for any of it | `test/<area>/` |

Design notes, plans and the roadmap are kept outside this repository.
What a user needs is in [the guides](https://term.surf/guides) and in
the reference below.

## How It Works

The compiler, `make`, takes `.tree` source through five stages and
emits one program per target:

```
.tree source
    ↓
make (compiler): parse → mill → resolve → check → emit
    ├─→ TypeScript  Node, the browser, Cloudflare Workers
    ├─→ Rust        Linux and Windows apps, servers, CLIs
    ├─→ Swift       macOS, the iOS simulator
    ├─→ Kotlin      Android
    ├─→ WGSL        the GPU, numbers and arrays only (experimental)
    └─→ HVM         the pure fragment only (experimental)
```

The compiler parses `.tree` files into a surface AST, mills them into a
typed AST (a mill is the grammar that reads one dialect, one vocabulary
of `.tree` file, into typed values), resolves names, and type-checks through a gradual,
bidirectional inference pass that elaborates into a dependent kernel for
soundness. Each backend then emits idiomatic output for its platform.
Generics, traits, async, and effects lower to the natural construct on
each target: native traits on Rust, protocols on Swift, interfaces on
Kotlin, and monomorphization on WGSL.

The CLI ([call](./deck/call)) drives the whole pipeline and ships a dev
server with hot module reload. The language server ([flow](./deck/flow))
reuses the same analysis for diagnostics, hover, and go-to-definition.

## Developing Term

Working on Term itself takes these tools:

- Node
- pnpm
- Rust
- Swift
- a JDK
- Kotlin
- Maven
- the Android SDK and the iOS simulator, for the mobile suites

One command checks them all on macOS, Linux or Windows, and installs what is missing with
`--commit`:

```
sh task/dev/bootstrap/start.sh check
sh task/dev/bootstrap/start.sh install --commit
powershell -ExecutionPolicy Bypass -File task\dev\bootstrap\start.ps1 check
```

The rest of the workflow is under [Building from a clone](#building-from-a-clone).

## Getting Started

The commands a project uses from its first day, each with what it does:

```sh
term wake hello          # a new project in ./hello
cd hello
term boot                # build it and run it, rebuilding on every save
term make                # build it
term test                # run its tests, holds and rules
term save @scope/name    # add a dependency to deck.tree, then install
term load                # install every dependency, verified against lock.tree
term bind                # log in to term.surf with Google, to publish
term host                # publish this package to its scope's registry
term --help              # every verb, one line each
```

## Example

A task is a function. This one, `double`, takes a number and returns it
added to itself:

```tree
task double
  take value, like number

  like number

  back add(value, value)
```

`term make --emit <backend> code/double.tree` prints one program as one
backend's source. The body of `double` on each:

```
node     return __termInt(value + value)
rust     i64::checked_add(value, value).expect("excess: a number past i64")
swift    return (value + value)
kotlin   return Math.addExact(value, value)
```

Each stops on an overflow rather than wrapping, in its platform's own
way: Swift's `+` traps, Kotlin's `addExact` throws, Rust's `checked_add`
panics through `expect`, and on Node `__termInt` raises the standard
library's `excess` once the sum passes `Number.MAX_SAFE_INTEGER`.

## Reference

Everything below describes Term 2.9.2 as it is in this repository: what
each construct is, how it is written, what it compiles to, and where it
stops. Every `tree` sample on this page compiles with `term make` (or
runs with `term test` when it holds `test` blocks). The counts were taken
from this repository, not estimated. Each part links the guide page that
goes further.

- [Notation](#notation): how a line is read, and every word the samples use
- [The two spellings](#the-two-spellings): lean and base
- [A first program](#a-first-program)
- [The language](#the-language): values, arithmetic, variables, tasks, branching, collections, loops, forms, matching, exceptions, modules, async, templates, marks, naming
- [Types](#types): annotations, generics, inference, masks, gradual types, the kernel
- [Proofs](#proofs): the hold gate, contracts, theorems, steps, induction, claims, indexed families, Lean
- [Tests, laws, benchmarks and fuzzing](#tests-laws-benchmarks-and-fuzzing)
- [Backends](#backends): what each emits, what differs, targets, WGSL, HVM, LLVM and WebAssembly
- [The standard library](#the-standard-library), area by area
- [Native code and docks](#native-code-and-docks)
- [Dialects, mills and roles](#dialects-mills-and-roles), data files and documents
- [Applications](#applications): `@term/site`, `@term/face`, `@term/cask`, `@term/bind`
- [Parsers](#parsers): text, bytes and grammars
- [Packages and the registry](#packages-and-the-registry)
- [The command line](#the-command-line): every verb, grouped
- [Installing on each platform](#installing-on-each-platform), and versions of Term
- [The editor and the language server](#the-editor-and-the-language-server)
- [Self-hosting](#self-hosting)
- [Status](#status): what works, and what is missing
- [Building from a clone](#building-from-a-clone), and contributing

## Notation

A `.tree` file is lines of words. The parser builds the same tree for
every file, and three rules shape it:

| layout | meaning |
| --- | --- |
| a space | the next word nests under the one before it |
| a comma | pops one level, so what follows is a sibling of the part before |
| an indent | the indented line is a child of the line above |
| `# text` | a comment. A comment directly above a definition is its documentation, shown on hover |
| `<text>` | a text literal. `{x}` inside it interpolates a value. `<<...>>` is raw text, with no escapes |
| `f(a, b)` | a call written where a value goes |
| `a/b` | a path: a step into a module or into a value, below |

So `take value, like number` is a `take` with two children, `value` and
`like number`, and `back add(value, value)` returns the call's result.
What the words mean comes from the file's dialect, the vocabulary its
[role](#dialects-mills-and-roles) (the kind of file it is) allows, and in ordinary code from the table
below. Nearly every word is four letters, a deliberate small vocabulary
shared by the language and its tools.

### Paths

A path is words joined by `/`, each step going one level in. One spelling
serves two jobs: naming a module to import, and reading a value.

| write | means |
| --- | --- |
| `load @term/base/list` | a module in a package: the package `@term/base`, then the file `list.tree` in its code folder |
| `load ./parse/read` | a module beside this file: `parse/read.tree`, else `parse/read/base.tree` |
| `p/x` | the field `x` of the record `p`. The base spelling is `read p/x` |
| `xs/0` | the first item of the list `xs` |
| `xs/{i}`, `h/{key}` | an item by a computed index, a hash value by a computed key |
| `p/home/city` | steps chain: the field `city` of the field `home` |
| `greet(who)/text` | a field of what a call returned |
| `found/push x` | a call of the task `push` on `found`, a method call |

### Definitions

The words that define things in ordinary code: tasks, their inputs,
variables, forms and imports.

| word | meaning |
| --- | --- |
| `task name` | a function. Its `take` lines are its inputs, a bare `like` line its result type |
| `take x, like T` | an input named `x` of type `T`, passed by name or position |
| `slot x, like T` | an input or field given only by position |
| `fall v` | the default of an input or field |
| `back x` | returns `x` (lean). The base spelling is `send back, read x` |
| `save x, v` | binds or rebinds the variable `x` |
| `host x, v` | a constant, in a task or at the top of a module |
| `form name` | a record (its `link` fields) or a sum type (its `case` variants) |
| `link f, like T` | a field of a form. `need false` makes it optional |
| `case name` | a variant of a form, an arm of a `sift`, or one backend of a `bind` |
| `make name` | builds a record or a variant. `bind f, v` fills a field |
| `mask name` / `wear name` | a set of tasks a form can supply (a trait), and a form supplying it |
| `head t` | a type parameter. `head t, need m` requires it to wear the mask `m` |
| `load path` / `find name` | imports a module, then one name from it. `find a, name b` renames |
| `mark word` | metadata: `mark async`, `mark private`, `mark unsafe`, `mark draft`, `mark stable` |
| `note <text>` | a sentence of documentation |

### Control

The words that decide which code runs, and how often: branches, matches,
loops, exceptions and async calls.

| word | meaning |
| --- | --- |
| `fork test, c` | an `if`. `hold` holds what runs when `c` is true, `miss` what runs otherwise |
| `hook test, c` | a further condition in a `fork test` chain, an `else if` |
| `sift v` | runs the `case` arm for the variant `v` holds. `hook miss` is every other variant |
| `walk xs` | loops over a list. `take x` names the item, `take at` its position |
| `walk size` | counts from `bind base` up to `bind head`, not included |
| `walk test` | loops while its `hook test` holds |
| `turn next` | skips to the next turn of the loop |
| `halt` | ends a loop. `halt <form>` raises an exception, `halt <text>` raises `failure` |
| `fork` + `mark unsafe` | a guarded block. `halt take` under it catches what was raised |
| `tick f(x)` | starts an async call and goes on without waiting |
| `wait f(x)` | awaits a call into native code |

### Proofs, tests and templates

The words that state and prove laws, write tests, and build code from
templates at compile time.

| word | meaning |
| --- | --- |
| `rule name` | a law: a theorem with `seat` variables and a `show` goal, or a claim with `take` lines |
| `seat x, like T` | a variable a law ranges over |
| `show c` | what the law says holds |
| `have c` | in a task, what every caller must ensure. In a law, a condition it is proven under |
| `must c` | what a task promises about `back`, or what a loop keeps true each turn |
| `down e` | a number that falls on every turn of a loop, so the loop ends |
| `fold x`, `calm`, `cite r`, `turn r`, `link` | proof steps: induction, computation, using a law, reading it backwards, chaining two |
| `test <name>` | a test. `want hold, c` checks `c` is true, `want miss, c` that it is false |
| `tree name` / `fuse name` | a template, and a filled-in copy of it |
| `site` / `beam` | a place for a block in a template, and the block passed to it |
| `tell @deck/form` | the message a person sees for an exception |

### Operators

Arithmetic and comparison are calls. There is no infix in ordinary code.

| write | means |
| --- | --- |
| `add(a, b)`, `subtract(a, b)`, `multiply(a, b)` | `a + b`, `a - b`, `a * b`, each stopping on overflow |
| `divide(a, b)` | division. On whole numbers it drops the remainder, toward zero |
| `modulo(a, b)` | the remainder |
| `is-equal(a, b)`, `is-unequal(a, b)` | `==` and `!=`, by structure |
| `is-above(a, b)`, `is-below(a, b)` | `>` and `<` |
| `is-minimum(a, b)`, `is-maximum(a, b)` | `>=` and `<=` |
| `and(a, b)`, `or(a, b)`, `not(a)` | `&&`, `\|\|` and `!` |
| `xs/0`, `p/x`, `xs/{i}` | an item by index, a field, an item by a computed index |

## The two spellings

Term has two spellings of one language. The **lean** spelling drops the
words a reader can infer: `text` before a literal, `code` before a
number, `read` before a variable, `call` before a call. The **base**
spelling writes every node out. Both compile to the same program, and
every sample on this page is lean except where it says otherwise.

Base:

```tree
task total-positive
  take xs, like list, like number

  like number

  save sum, code 0

  walk list, read xs
    hook next
      take site, name x
      fork test
        hook test, call is-above, read(x), code 0
        hook hold
          save sum, call add, read(sum), read x
  send back, read sum
```

Lean:

```tree
task total-positive
  take xs, like list, like number

  like number

  save sum, 0

  walk xs
    take x
    fork test, is-above x, 0
      hold
        save sum, add(sum, x)
  back sum
```

The rewrites between them, each checked by building both spellings and
comparing the emitted TypeScript:

| base | lean |
| --- | --- |
| `text <red>` | `<red>` |
| `code 0` | `0` |
| `read n`, `read p/x` | `n`, `p/x` |
| `call add` over its arguments | `add(a, b)` where a value goes, `add a, b` as a statement |
| `call answer` | `answer()`. A bare `answer` is the task itself, as a value |
| `send back, read sum` | `back sum` |
| `meet and` over two values | `and(a, b)` |
| `fork test` over `hook test` | `fork test, is-above n, 0` |
| `hook hold`, `hook miss` | `hold`, `miss` |
| `walk list, read xs` over `hook next` over `take site, name x` | `walk xs` over `take x` |
| `fork case, s` | `sift s` |

A file whose role carries `mark lean` goes further: a field is filled by
its label (`height 3` for `bind height, code 3`), a list argument is a
row of values, and a record is built by naming the form:

```deck
role code
  mark lean
  take @/code/**/*.tree
```

A file of base code is converted with `pnpm term:lean-convert <file> --commit` in a clone of this repository, never
by hand. [The lean spelling](https://term.surf/guides/language/syntax/lean),
[The base spelling](https://term.surf/guides/language/syntax/base).

## A first program

A program's entry point is a task named `boot` (a task is a function),
and `log` from the standard library prints a line. The first things a
newcomer looks for:

| standard concept | in Term | example |
| --- | --- | --- |
| source file | a `.tree` file | `code/boot.tree` |
| new project, `cargo new` | `term wake` | `term wake hello` |
| `main` | `task boot` | `task boot` |
| print | `log` | `log <hello from term>` |
| run | `term boot` | `term boot` |
| compile | `term make` | `term make` |
| REPL | `term walk` | `term walk` |
| project manifest | `deck.tree` | `deck hello` |
| package | a deck | |
| build output | `host/` | |

```tree
load @term/base/console
  find log

task greet
  take name, like text

  like text

  back <hello, {name}>

task boot
  mark async
  log <hello from term>
  log greet(<ada>)
```

Saved as `code/boot.tree` in a project whose `deck.tree` says
`boot ./code/boot`, `term boot` builds it and runs its `boot` task:

```
● boot demo
  term 2.9.2 · development
✓ build code/boot.tree
  335ms
● log demo
  ⇒ hello from term
    hello, ada
✓ boot Done
  up 468ms
```

`term wake demo` writes such a project: `deck.tree` with its `boot`
line, `code/boot.tree`, a `readme.md` and a `.gitignore`. Build output
goes to `host/`, and everything Term keeps for a project (caches, the
build graph, the project memory) goes under `.base/@term/code/`.

With `greet(36)` in place of `greet(<ada>)`, `term make` refuses the
line, with the same message the editor shows:

```
● make demo
  term 2.9.2 · 1 file
✗ check Argument: expected text, found number type-mismatch
  file code/boot.tree:14:13
  13 │   log <hello from term>
  14 │   log greet(36)
     │             ━━
  next make the value match the expected type, or adjust the annotation
✗ build typescript
  169ms · 0/1 files · 0 written · 0 units built · 0 reused
✗ make Build failed
  142ms · 1 error
```

## The language

Each construct a programmer from TypeScript, Rust or Python looks for,
and the word Term spells it with. The parts below take them one at a
time.

| standard concept | in Term | example |
| --- | --- | --- |
| function | `task` | `task double` |
| parameter | `take` | `take n, like number` |
| default value | `fall` | `take step, like number, fall 1` |
| named argument | `bind` | `bind step, 10` |
| return | `back` | `back add(n, 1)` |
| variable | `save` | `save total, 0` |
| constant | `host` | `host tax, 2` |
| string interpolation | `{x}` inside text | `<hello, {name}>` |
| struct, record | `form` with `link` fields | `link name, like text` |
| create an instance | `make`, with a `bind` per field | `make user` over `bind name, <ada>` |
| optional field | `need false` | `link age, like number, need false` |
| enum, sum type | `form` with `case` variants | `case circle` |
| pattern match | `sift` | `sift s` over `case circle` |
| if / else | `fork test`, with `hold` and `miss` | `fork test, is-below n, 0` |
| else if | `hook test` | `hook test, is-minimum score, 80` |
| for each | `walk` over a list | `walk items` over `take value` |
| counted loop | `walk size` | `walk size` over `bind base, 1` and `bind head, 5` |
| while | `walk test` | `walk test` over `hook test, is-above at, 1` |
| break, continue | `halt`, `turn next` | `turn next` |
| throw | `halt` | `halt absence, bind thing, <name>` |
| `throws` clause | `halt` on the signature | `halt excess` |
| try / catch | a `fork` whose first line is `mark unsafe`, then `halt take` | `halt take` over `take problem` |
| import | `load`, then `find` | `load @term/base/list` over `find size` |
| import alias | `find a, name b` | `find get, name list-get` |
| private | `mark private` | `mark private` |
| async / await | `mark async`. A call to it is awaited with nothing written | `mark async` |
| start without awaiting | `tick` | `tick write-log(line)` |
| function as a value | the task's bare name | `apply-twice(a, double)` |
| generics | `head` | `head t` |
| interface, trait | `mask`, and `wear` on a form | `mask scorer` |
| macro, template | `tree`, filled in by `fuse` | `fuse is-tag, green, 1` |
| annotation, attribute | `mark` | `mark async` |
| comment | `#` | `# a full-line comment` |
| doc comment | a `#` comment directly above a definition, or `note` | `note <Twice the number it is given.>` |
| foreign function | `load` of a host module | `load <node:path>, name path` |
| `null` | none: `need false` on a field, or `like maybe` | |
| infix operators | none: each is a call | `add(a, b)`, `is-equal(a, b)` |

### Values and literals

A literal is a value written straight into the code: a number, a piece
of text, a boolean. Text sits between `<` and `>`.

```tree
host site, <Term>

task literals
  like text

  save n, -7
  save f, 1.5
  save h, 0x1f
  save a, 0u0041
  save yes, true
  back <welcome to {site}, {n}>
```

| write | is |
| --- | --- |
| `42`, `-7` | a whole number (`number`) |
| `1.5` | a `float` |
| `0x1f` | a number in hex |
| `0u0041` | a code point |
| `true`, `false` | a `boolean` |
| `<text>` | a `text`. `\< \> \{ \} \n \r \t \e \\` are its only escapes |
| `<<raw>>` | raw text, with no escapes and no interpolation |
| `<a {x} b>` | interpolation. A module constant that folds is filled at compile time, anything else at run time |

A `number` is a whole number with one range on every backend: `i64` on
Rust, Swift and Kotlin, and the safe integers on TypeScript. Arithmetic
that leaves it raises `excess` or `shortage` rather than wrapping.
[Values and literals](https://term.surf/guides/language/values).

### Arithmetic and comparison

Arithmetic and comparison are ordinary calls, such as `add(a, b)` and
`is-above(a, 10)`, since Term has no infix operators.

```tree
task compare
  take a, like number
  take b, like number

  like boolean

  save sum, add(a, b)
  save rest, modulo(subtract(24, a), b)
  save half, divide(a, 2)
  save same, is-equal(a, b)
  save big, is-above(a, 10)
  save least, is-minimum(a, 1)
  back and(same, not(big))
```

A long formula is a nest of calls. A numeric literal is never a method
receiver: write `subtract(24, a)`. A division by something the build
cannot show is non-zero is an obligation the [hold gate](#the-hold-gate)
counts (the check that fails on any unproven read, division or loop). [Arithmetic and comparison](https://term.surf/guides/language/operators).

### Variables

A variable is a name bound to a value with `save`, and a constant is one
bound with `host`, which never changes.

```tree
form account
  link email, like text

task total-price
  take price, like number
  take count, like number

  like number

  host tax, 2
  save total, multiply(price, count)
  save total, add(total, tax)
  back total

task pick
  take user, like account
  take names, like list, like text
  take at, like number

  like text

  save mail, user/email
  save first, names/0
  back names/{at}
```

`save` binds and rebinds. `host` is a constant, and `term lint` offers
to turn a `save` that is never rebound into a `host` (rule `L004`). A
path reads into a value: `user/email` a field, `names/0` an item,
`names/{at}` an item at a computed index.
[Variables](https://term.surf/guides/language/variables).

### Tasks

A task is a function. Its `take` lines are its inputs, a bare `like`
line is the type it returns, and `back` returns a value.

```tree
task step-up
  take value, like number
  take step, like number, fall 1

  like number

  back add(value, step)

task pair
  slot left, like number
  slot right, like number

  like number

  back subtract(left, right)

task double
  take input, like number

  like number

  back multiply(input, 2)

task apply-twice
  take value, like number
  take change
    like task
      take input, like number
      like number

  like number

  save once, change(value)
  back change(once)

task use-step
  take n, like number

  like number

  save a, step-up(n)

  save b
    call step-up
      bind step, 10
      bind value, n
  save c, apply-twice(a, double)
  back add(b, pair(c, 1))
```

A task is named for what it does (`make-text`, `fits-in-page`). An
input takes a default with `fall`, a named argument is `bind name,
value`, and `slot` inputs are given only by position. A task is a value:
`double` passes the task, `double()` calls it with no arguments.
[Tasks](https://term.surf/guides/language/tasks).

### Branching

A `fork test` is an if: the code under `hold` runs when the test is
true, the code under `miss` runs otherwise, and each `hook test` adds an
else-if.

```tree
task sign-label
  take n, like number

  like text

  fork test, is-below n, 0
    hold
      back <negative>
    miss
      back <not negative>

task grade
  take score, like number

  like text

  fork test
    hook test, is-minimum score, 90
    hold
      back <A>
    hook test, is-minimum score, 80
    hold
      back <B>
    miss
      back <C>

task size-label
  take a, like number

  like text

  back
    fork test, is-above a, 10
      hold
        <big>
      miss
        <small>
```

A `fork` is a statement, or a value when it stands where a value goes,
as in `size-label`. [Branching](https://term.surf/guides/language/branching).

### Lists, hashes and sets

A list is an ordered run of values, a hash maps keys to values (a
dictionary), and a set holds each value once. Each comes from its own
standard library module.

```tree
load @term/base/list
  find list
  find sort

load @term/base/ordering
  find from-numbers

load @term/base/hash
  find hash

load @term/base/set
  find set

task collect
  like number

  save items, make list, 3, 1
  push items, 2
  save first, items/0
  save sorted, sort(items, from-numbers)
  save ages, make hash
  set ages, <ada>, 36
  save age, get-or-default(ages, <ada>, 0)
  save seen, make set, bind items, make hash
  insert seen, <red>
  back add(first, age)
```

A list that mixes kinds of value says so: `like list, like unknown`. A
hash keeps its keys in the order they were set. Reading past the end of
a list stops the program, and a read the build cannot show is in bounds
is an obligation for the hold gate.
[Lists, hashes and sets](https://term.surf/guides/language/collections).

### Loops

A loop is a `walk`, in one of three kinds: over a list (`walk xs`),
counting through a range (`walk size`), or while a test holds
(`walk test`). `turn next` skips to the next turn, and `halt` ends the
loop.

```tree
task total
  take items, like list, like number

  like number

  save total, 0

  walk items
    take value
    take at
    fork test, is-below value, 0
      hold
        turn next
    fork test, is-above value, 100
      hold
        halt
    save total, add(total, value)
  back total

task count-up
  like number

  save total, 0

  walk size
    bind base, 1
    bind head, 5
    hook next
      take site, name i
      save total, add(total, i)
  back total

task halvings
  like number

  save at, 100
  save turns, 0

  walk test
    hook test, is-above at, 1
    hold
      save at, divide(at, 2)
      save turns, add(turns, 1)
  back turns
```

`walk xs, name outer` names a loop, so a `halt` or `turn next` in an
inner loop can reach it. A loop meant to run forever carries
`mark roam` on its task, which the termination check reads.
[Loops](https://term.surf/guides/language/loops).

### Forms

A form is a type you define: a record with named fields (`link`), or a
sum type with variants (`case`). `make` builds one, with a `bind` per
field.

```tree
form user
  link name, like text
  link email, like text
  link age, like number, need false
  link role, like text, fall <member>

form point
  slot x, like number
  slot y, like number

form shape
  case circle
    link radius, like number
  case square
    link side, like number

form counter
  link value, like number
  task bump
    take self

    like counter

    back make counter, bind value, add(self/value, 1)

task build
  like text

  save ada
    make user
      bind name, <ada>
      bind email, <ada@example.com>
  save p, make point, 3, 4
  save c, make circle, bind radius, 1
  save k, make counter, bind value, 0
  save once, bump(k)
  back ada/role
```

A form is a record when it has `link` fields and a sum type when it has
`case` variants. A task inside a form is its method, called like any
task. On TypeScript a sum type is a tagged union, on Rust an `enum`, on
Swift an `enum` with associated values, and on Kotlin a `sealed class`
([Backends](#backends) shows one). `mark hide` keeps a form's
construction to its own file, and `mark sole` makes a value usable at
most once. [Forms](https://term.surf/guides/language/forms).

### Matching

A `sift` is a match: it looks at which variant of a sum type a value
holds, and runs the `case` arm written for that variant.

```tree
form shape
  case circle
    link radius, like number
  case square
    link side, like number
  case point

form box
  case full
    like text
  case empty

task area
  take s, like shape

  like number

  sift s
    case circle
      back multiply(3, multiply(radius, radius))
    case square
      back multiply(side, side)
    case point
      back 0

task corners
  take s, like shape

  like number

  back sift s
    case square
      4
    hook miss
      0

task pair-of
  take a, like box
  take b, like box

  like text

  sift a
    case full
      link left
      sift b
        case full
          link right
          back <{left} and {right}>
        case empty
          back left
    case empty
      back <nothing>
```

An arm reads its case's fields by name, or renames one with `link`. The
arms must cover every case, or `hook miss` covers the rest.
[Matching](https://term.surf/guides/language/matching).

### Exceptions

An exception is a form a task raises with `halt` when it cannot go on.
A guarded block, a `fork` whose first line is `mark unsafe`, catches it
under `halt take` (a try and its catch).

```tree
load @term/base/exception
  find excess

form upload-excess
  like excess
    bind note, <Upload too large>
    bind thing, <upload>
    link policy, like text

task store
  take size, like number

  like number

  fork test, is-above size, 5
    hold
      halt excess
        bind thing, <upload>
        bind limit, 5
        bind actual, size
  back size

task try-store
  take size, like number

  like text

  fork
    mark unsafe
    save kept, store(size)
    back <stored {kept}>
  halt take
    take problem
    back <refused: {problem/note}>

tell @term/base/excess
  note <File too large>
  link limit
```

The standard library defines seventeen exceptions, each a form
`like exception` with a `thing` field and fields of its own:

- `defect`
- `omission`
- `excess`
- `shortage`
- `mismatch`
- `exclusion`
- `absence`
- `conflict`
- `refusal`
- `anonymity`
- `denial`
- `overload`
- `outage`
- `timeout`
- `overage`
- `failure`
- `bundle`

A task may list what it
raises (a `halt excess` line in its signature), and the build holds it
to that list. `halt kink` passes a callee's exception on. A `tell`
says what a person sees for one. A raise is caught the same way on all
four backends, and its `flow` holds the same Term frames on each.
`term roll exception --path` lists every exception a build can raise and
where each comes out. [Exceptions](https://term.surf/guides/language/errors),
[The seventeen exceptions](https://term.surf/guides/library/exceptions).

### Modules and imports

A module is one `.tree` file. `load` imports a module, and each `find`
under it takes one name from it.

```tree
load @term/base/console
  find log

load @term/base/list
  find size
  find get, name list-get

task double
  mark private

  take n, like number

  like number

  back multiply(n, 2)

task boot
  save names, make list, <ada>, <bob>
  save first, list-get(names, 0)
  log <{length(names)} names, first {first}, {double(2)}>
```

`load ./util` reads `util.tree`, then
`util/base.tree`, then `util/note.tree`. A package path
`@scope/name/<path>` resolves in the package's code root first, then
the package root. `find a, name b` renames an import, and `mark private`
keeps a task inside its file. Names are scoped to their module and reach
others only through `load` and `find`.
[Modules and imports](https://term.surf/guides/language/modules).

### Async

An async task is one that can wait, for a file or the network, without
stopping the rest of the program. It carries `mark async`.

```tree
dock load
  load <node:fs/promises>, name fs-promise

task read-text
  mark async
  take path, like text

  like text

  back fs-promise/read-file(path, <utf8>)

task write-log
  mark async
  take line, like text

  like void

  wait fs-promise/append-file(<app.log>, line)

task handle
  take line, like text

  like text

  tick write-log(line)
  back <handled {line}>

task read-deck
  like text

  save body, read-text(<deck.tree>)
  back body
```

`mark async` on a task makes it async, and a call to it from a task is
awaited with nothing written. A task that calls an async task becomes
async itself. `tick` starts one and goes on. `wait` is written only on a
call into native code, and a module whose functions all answer promises
says so once with `mark async` under its load line. On TypeScript an
async task is a `Promise`, on Rust a future on a small executor of
Term's own, on Swift an `async` function started as a `Task`, and on
Kotlin a coroutine. On every backend the jobs run on one thread, each
until it waits. Concurrency (`gather`, `spawn`, channels) is
in the [standard library](#the-standard-library).
[Async](https://term.surf/guides/language/async).

### Templates

A template is a `tree`: a pattern of code with holes, written once. Each
`fuse` fills its holes and pastes the result in at compile time, the
role a macro plays elsewhere.

```tree
tree is-tag
  take name
  take tag
  hook fuse
    task is-{name}
      take value, like number

      like boolean

      back is-equal(value, code {tag})

fuse is-tag
  bind name, red
  bind tag, 0

fuse is-tag, green, 1

tree record-of
  take name
  hook fuse
    form {name}
      site fields

fuse record-of
  bind name, spot
  beam fields
    link x, like number
    link y, like number

task check
  like boolean

  back and(is-red(0), is-green(1))
```

A template works on the tree itself, before checking, so it can write
tasks, forms or any other definition. A hole holds one word or literal,
and a block passes through `site` and `beam`.
[Templates](https://term.surf/guides/language/templates).

### Marks and notes

A mark is metadata on a definition, such as `mark private` or
`mark async`, and a `note` is a sentence of documentation for it.

```tree
task double
  mark private

  note <Twice the number it is given.>
  take n, like number

  like number

  back multiply(n, 2)

task old-double
  mark deprecated

  take n, like number

  like number

  back double(n)
```

| mark | on | does |
| --- | --- | --- |
| `async` | a task | makes it async |
| `private` | a task | keeps it to its file |
| `unsafe` | the first line of a `fork` | makes the fork a guarded block |
| `draft` | a file | shelves it: the build skips it |
| `deprecated` | a task | warns each caller |
| `roam` | a task | says a loop in it is meant to run forever |
| `open` | a claim | leaves it unproven on purpose |
| `stable`, `unstable` | a module | whether v1 promises it |
| `hide`, `sole` | a form | construction kept to its file, and use at most once |
| `lean` | a role | the lean spelling with labels |

[Marks and notes](https://term.surf/guides/language/notes).

### Naming

Names are kebab-case. A task is a verb (`fits-in-page`), and a form, view
or value is a noun. A task and a form may share a name. Tasks are never
prefixed with their module's name, and a name that would collide is
imported under another with `find a, name b`, never renamed at its
definition. [Naming](https://term.surf/guides/language/naming).

## Types

Every build checks the types of the whole program before it writes
anything. Each part of a type system, and the word Term spells it with:

| standard concept | in Term | example |
| --- | --- | --- |
| type annotation | `like` | `take ratio, like float` |
| return type | a bare `like` line under the task | `like number` |
| list type, `number[]` | `like list`, then the item type | `like list, like number` |
| map type | `like hash`, then the value type | `like hash, like text` |
| function type | `like task` | `take body, like task` |
| generic type parameter | `head` | `head t` |
| generic type, applied | the form's name, then the argument | `like chain t` |
| interface, trait, protocol | `mask` | `mask scorer` |
| implements | `wear` on the form | `wear scorer` |
| `self` | `take self` | `take self` |
| trait bound, `T: Scorer` | `need` on the parameter | `head t, need scorer` |
| union type | a `form` with `case` variants | `case circle` |
| `unknown` | `like unknown` | `take a, like unknown` |
| `any` | `like dynamic` | `take value, like dynamic` |
| type inference | write no `like` | `save count, 3` |
| dependent types | the kernel, a second checker, and a value in a type | `head n, like nat` |

### Annotations and generics

An annotation is a `like` line, which gives a type. A generic is a task
or form with a `head t` line, a type parameter filled in at each use.

```tree
form player
  link name, like text
  link scores, like list, like number
  link ages
    like hash, like text
      like number

task identity
  head t
  take value, like t

  like t

  back value

task half
  take ratio, like float

  like float

  back divide(ratio, 2.0)

form chain
  head t
  case chain-end
  case chain-node
    link item, like t
    link rest, like chain t

task each-number
  take items, like list, like number
  take visit
    like task
      take value, like number
      like void

  like void

  walk items
    take item
    visit item
```

| write | holds |
| --- | --- |
| `like text` | a string |
| `like number` | a whole number: `i64` on Rust, Swift and Kotlin, the safe integers on TypeScript |
| `like float` | a 64-bit float. `f32` and `f64` are names for it |
| `like boolean` | `true` or `false` |
| `like void` | no value |
| `like bytes` | a byte buffer |
| `like list, like T` | a list of `T` |
| `like hash, like K` over `like V` | a map from `K` to `V` |
| `like task` over `take` and `like` lines | a task value with that signature |
| `integer`, `natural-number`, `size`, `u8` to `u128`, `i8` to `i128` | `number` with a range. A literal outside the range is refused |
| `like unknown` | any value, checked where it is used |
| `like dynamic` | the host's own `any`, for native code |

A width is a range, not a different representation: a literal outside
it is refused, and a computed value is held to it with
`TERM_WIDTH_RANGES=1`. [Annotations and generics](https://term.surf/guides/types/annotations).

### Inference

Inference is the build working out a type you did not write, from the
value or the call it comes from.

```tree
load @term/base/list
  find push

task names
  like list

  save found, make list
  push found, <ada>
  push found, <grace>
  back found

task same
  head t
  take value, like t

  like t

  back value

task use-same
  like number

  save count, 3
  save a, same(1)
  save b, same(<one>)
  back add(a, count)
```

A local is typed by its value, an empty list by its first push, and a
generic task is instantiated at each call. Inference is bidirectional,
and the editor shows each inferred type as an inlay hint.
[Inference](https://term.surf/guides/types/inference).

### Masks

A mask is a set of tasks a form can supply (a trait or interface), and
`wear` on a form says it supplies them.

```tree
mask scorer
  task score
    take self

    like number

form player
  link points, like number
  wear scorer
    task score
      take self

      like number

      back self/points

task double-score
  head t, need scorer
  take x, like t

  like number

  back multiply(score(x), 2)

task demo
  like number

  save ada, make player, bind points, 7
  back double-score(ada)
```

A mask plays the role a trait plays in
Rust, a protocol in Swift and an interface in Kotlin, and each backend
emits it as that construct. The arithmetic masks in
`@term/base/arithmetic` let `add(a, b)` reach a form's own addition, as
the big integer, big decimal, rational and complex forms do.
[Masks](https://term.surf/guides/types/masks).

### Unknown and dynamic

`like unknown` is a value of any type, checked where it is used, and
`like dynamic` is the host language's own `any`, for native code.

```tree
load @term/base/list
  find push

dock type
  load <any>, name socket-handle

task same-value
  take a, like unknown
  take b, like unknown

  like boolean

  back is-equal(a, b)

task fill
  take row, like list, like unknown

  like void

  push row, <ada>
  push row, 7

task keep-socket
  take handle, like socket-handle

  like socket-handle

  back handle
```

`unknown` is the gradual type: `any` on TypeScript, `Rc<dyn Any>` on
Rust, `Any` on Swift and Kotlin. A `sift` over its type, or
`fork test, is-text(value)`, narrows it to `number`, `float`, `text` or
`boolean`. `dock type` with `load <any>` declares an opaque native
handle. [Unknown and dynamic](https://term.surf/guides/types/gradual).

### The kernel

The kernel is a second, dependent type checker behind the ordinary one.
It checks proofs, such as the law below that `double(n)` equals
`add(n, n)` for every `n`.

```tree
task double
  take n, like number

  like number

  back add(n, n)

rule double-is-sum
  seat n, like number
  show is-equal double(n), add(n, n)
```

Under the surface checker sits a small dependent type theory:
quantitative type theory (each binder carries how many times it is
used), observational equality, a cumulative universe hierarchy and self
types. Each task the kernel can represent is elaborated into one term
and checked there. A task it cannot represent (a loop that saves into a
name twice, a native call) is declined and checked statement by
statement, and `term hold` lists every decline with its reason. The
decision procedures beside it cover:

- linear arithmetic (with Presburger arithmetic for the integers)
- ring identities
- congruence closure
- sums of squares
- Sturm sequences
- cylindrical algebraic decomposition

Linear
refutations and sum-of-squares certificates are replayed by the checker.
[The kernel](https://term.surf/guides/types/kernel).

## Proofs

A Term program can state what it guarantees and have the build prove
it. Proofs are opt in, apart from one floor every program meets: tier
0, below.

Each idea of a proof assistant such as Lean, Coq or Agda, and the word
Term spells it with. A `rule` is a law (a theorem), and its proof is the
step lines under its `show`.

| standard concept | in Term | example |
| --- | --- | --- |
| theorem, lemma | `rule` | `rule add-zero` |
| universally bound variable, `∀ a : ℕ` | `seat` | `seat a, like nat` |
| the statement to prove | `show` | `show is-equal add(a, 0), a` |
| hypothesis | `have`, with a name | `have positive, is-above n, 0` |
| existential witness | `find` | `find x` over `like integer` and `3` |
| axiom | `base true` on a rule | `base true` |
| proof by computation, `rfl` | `calm` or `melt` | `calm hold` |
| case split | `fold` on a form whose cases do not recur | `fold g` |
| induction | `fold` | `fold n` |
| induction hypothesis | given to every case by `fold`, nothing written | |
| rewrite with a lemma, `rw [h]` | `cite` | `cite unfolds` |
| rewrite right to left, `rw [← h]` | `turn` | `turn unfolds` |
| transitivity, `calc` | `link` over two `cite` lines | `link` |
| apply a proven theorem | `cite` the rule | `cite doubles` |
| automation, `simp`, `omega` | nothing written: the provers close arithmetic. `seek` searches for an equality | `seek` |
| a lemma inside a function | a `hold` with a name | `hold unfolds, is-equal(double(n), add(n, n)), melt both` |
| QED, goal closed | nothing: the build passes. An unproven goal stops it, exit 1 | |
| `sorry`, `admit` | `mark open` on a claim | `mark open` |
| proposition as a type, proof as a term | a claim, `rule` with `take` lines, proved by the `task` of the same name | `rule flip` and `task flip` |
| implicit type argument | `head` | `head a` |
| propositional equality, `refl` | `equal` from `@term/base/proof/equal`, `make equal/refl` | `back make equal/refl, bind c, c` |
| precondition, `requires` | `have` in a task | `have is-above n, 0` |
| postcondition, `ensures` | `must` on `back` | `must is-minimum back, 0` |
| loop invariant | `must` under a `walk test` | `must is-maximum i, n` |
| termination measure, `decreases` | `down` | `down subtract(n, i)` |
| `partial def`, a loop meant to run forever | `mark roam` | `mark roam` |
| a tactic language | none: a step is one word from a closed list | |

### The hold gate

`term hold` builds the project and fails while anything is unproven.
With nothing written, it already owes, for every task, that each
division is by something other than zero and each list read is inside
its list (tier 0, the level SPARK calls silver).

```tree
task average
  take items, like list, like number

  like number

  save sum, 0

  walk items
    take item
    save sum, add(sum, item)
  save mean, divide(sum, items/length)
  back mean
```

`term make` builds this and counts the one obligation it could not
prove. `term hold` refuses it:

```
● hold demo
  term 2.9.2 · 1 file
✗ prove This division is not shown to be by something other than zero: it does
  not follow from what is known here unproven
  file code/main.tree:11:14
  10 │     save sum, add(sum, item)
  11 │   save mean, divide(sum, items/length)
     │              ━━━━━━━━━━━━━━━━━━━━━━━━
  next add the assumption it needs (e.g. a natural-number bound), or weaken the
    claim
● prove What the kernel did with the tasks
  0 proven as one term · 0 checked statement by statement · 1 declined
  An expression the kernel cannot represent: 1
● trust What the proofs rest on and nothing here proves
  0 impure tasks · 0 axioms · 0 recursions not shown to end · 0 marked roam
  An impure task reaches native code, is async, or has no body. One assumption:
    native code handed only scalars reaches no Term value.
● certify Every linear refutation and sum-of-squares certificate replayed by the
  checker
  0 found by the search and refused
  Sturm and CAD are trusted as written.
✗ hold Does not hold
  222ms · 0/1 obligations proven · 0 in the baseline
  1 not proven and not in hold.json
```

| command | does |
| --- | --- |
| `term hold` | fail while any claim is open or any tier-0 obligation is unproven |
| `term hold --commit` | write today's unproven obligations into `hold.json`, a baseline that only shrinks |
| `term hold --cross` | also emit every file on all four backends |
| `term hold --lean` | have Lean 4 re-check every claim's term, a second kernel that shares no code with Term |
| `term hold --report` | one page: each law in `laws.tree`, whether it holds, what it rests on, and its statement in English |

The report also lists what the proofs trust: impure tasks (native code,
async, no body), axioms, recursions not shown to end, and tasks marked
`roam`. [The hold gate](https://term.surf/guides/proofs/hold).

### Contracts

A contract is what a task needs and promises, checked at every call:
`have` is a precondition, `must` a postcondition or a loop invariant,
and `down` a number that falls each turn so a loop ends.

```tree
task step-down
  take n, like integer

  have is-above n, 0
  must is-minimum back, 0
  like integer

  back subtract(n, 1)

task count-up
  take n, like integer

  have is-minimum n, 0
  like integer

  save i, 0

  walk test, down subtract(n, i)
    must is-maximum i, n
    hook test, is-below i, n
    hold
      save i, add(i, 1)
  back i
```

`back` in `must is-minimum back, 0` names the task's result. Each call
site owes the callee's `have`, and the
arithmetic provers close it or the build names it.
[Contracts](https://term.surf/guides/proofs/contracts).

### Theorems

A theorem is a `rule`: a law that must hold for every value of its
variables, proven when the file builds. Each `seat` line names a
variable it holds for, a for-all, and `show` states the goal.

```tree
rule add-zero
  seat a, like number
  show is-equal add(a, 0), a

rule above-after-step
  seat n, like integer
  have positive, is-above n, 0
  show is-above add(n, 1), 1

rule some-double
  find x
    like integer
    3
  show is-equal add(x, x), 6

rule no-root-of-two
  seat x, like integer
  base true
  show is-unequal multiply(x, x), 2
```

`have` names a hypothesis the law is proven under, and `find` proves
one value exists. `base true` takes a law as
an axiom, which the report lists. A false law over small integers is
refuted with the values that break it.
[Theorems](https://term.surf/guides/proofs/theorems).

### Proof steps and induction

A proof step is one line under a `show` that tells the checker how to
close a goal its provers cannot reach alone. Most goals need none.
Induction is the step `fold`. The map from a proof assistant's moves:

| standard concept | in Term | example |
| --- | --- | --- |
| theorem, lemma | `rule` | `rule plus-zero` |
| universally bound variable | `seat` | `seat n, like nat` |
| the goal | `show` | `show hold, is-equal plus(n, make zero), n` |
| hypothesis | `have`, with a name | `have positive, is-above n, 0` |
| inductive type | `form` with `case` variants | `form nat` over `case zero` and `case succ` |
| proof by computation, `rfl` | `calm` or `melt` | `calm hold` |
| case split | `fold` on a form whose cases do not recur | `fold g` |
| `induction n` | `fold` | `fold n` |
| induction on two variables | `fold` with both names | `fold a b` |
| induction hypothesis | given to every case by `fold`, nothing written | |
| a lemma every case may use | `cite` under the `fold`, as its child | `cite plus-zero` |
| rewrite with a lemma, `rw [h]` | `cite` | `cite unfolds` |
| rewrite right to left, `rw [← h]` | `turn` | `turn unfolds` |
| transitivity, `calc` | `link` over two `cite` lines | `link` |
| `simp`, `omega`, `auto` | nothing written: the provers close arithmetic. `seek` searches for an equality | `seek` |
| a lemma inside a function | a `hold` with a name | `hold unfolds, is-equal(double(n), add(n, n)), melt both` |
| QED | nothing: the build passes. An unproven goal stops it, exit 1 | |
| `sorry` | `mark open` on a claim, a `rule` with no `show` | `mark open` |

Below, `form nat` is a natural number, `zero` or one more than a
`prior`, and `plus` adds two by matching on the first with `sift`.

```tree
form nat
  case zero
  case succ
    link prior, like nat

task plus
  take a, like nat
  take b, like nat

  like nat

  sift a
    case zero
      back b
    case succ
      link prior
      back make succ, bind prior, plus(prior, b)

rule plus-zero
  seat n, like nat
  show hold, is-equal plus(n, make zero), n
  fold n

rule plus-succ
  seat a, like nat
  seat b, like nat
  show hold
    is-equal
      plus a
        make succ, bind prior, b
      make succ, bind prior, plus(a, b)
  fold a

rule plus-commutes
  seat a, like nat
  seat b, like nat
  show hold, is-equal plus(a, b), plus(b, a)
  fold a
    cite plus-zero
    cite plus-succ
```

| step | does |
| --- | --- |
| `calm hold` | computes both sides and compares them |
| `fold n` | induction on `n`, one goal per case, with the hypothesis for each recursive field |
| `cite r` | uses a proven law |
| `turn r` | uses a law read right to left |
| `link` over two `cite` lines | chains `a = m` and `m = b` |
| `hold name, c, melt both` | a named lemma inside a task, closed by unfolding both sides |

[Proof steps](https://term.surf/guides/proofs/steps), [Induction](https://term.surf/guides/proofs/induction).

### Claims and indexed families

A claim is a proposition written as a type, and its proof is a program
of that type, as in Agda or Coq. The claim is a `rule` with `take` lines
and a result `like`, and the `task` of the same name proves it.

```tree
load @term/base/proof/equal
  find equal

rule flip
  head a
  take x, like a
  take y, like a
  take proof
    like
      equal a
      head read x
      head read y
  like
    equal a
    head read y
    head read x

task flip
  take x
  take y
  take proof

  sift proof
    case refl
      link c
      back make equal/refl, bind c, c
```

`rule flip` states that equality turns around, and `task flip` proves
it, a program the kernel (Term's dependent type checker) checks as one
term. A form can carry a
value in its type (`head n, like nat`), so a vector's length is part of
its type and `first` can refuse an empty one at the call. `mark open`
leaves a claim unproven on purpose, and the gate counts it.
[Claims](https://term.surf/guides/proofs/claims),
[Equality and indexed families](https://term.surf/guides/proofs/equality).

### What a proof covers

A proof is about the program's meaning on whole numbers with no limit.
Every backend stops an operation on `number` that leaves its range, so a
proof holds of every run that does not stop, and nothing proves a run
does not stop. The backends are tested against each other, not
verified. `term knit` runs the loop the other way: from a spec in words,
a model writes the code, the laws and the proofs until `term hold`
holds, and every law is reported in English from its Term form.

## Tests, laws, benchmarks and fuzzing

Each kind of check a programmer from Jest, pytest or cargo looks for,
and how Term spells it:

| standard concept | in Term | example |
| --- | --- | --- |
| unit test | `test` with a name | `test <trim drops the outer spaces>` |
| assertion | `want hold`, or `want miss` for false | `want hold, is-equal length(parts), 3` |
| run the tests | `term test` | `term test test/double.tree` |
| property-based test, sampled | a `test` that starts with `take` lines | `take n, like number` |
| a property proven for every input | a law, `rule` with `seat` and `show` | `rule double-is-sum` |
| benchmark | a task named `time-` something, run by `term time` | `task time-split` |
| fuzzing your own code | none. `term hunt` fuzzes the compiler | `term hunt` |
| mocks, snapshots, coverage | none | |

### Tests

A test is a name and a check of what should be true: `test <name>`
opens it, and `want hold, c` checks that `c` is true.

```tree
load @term/base/text
  find split
  find trim

load @term/base/list
  find length

load @term/base/console
  find log

test <trim drops the outer spaces>
  want hold, is-equal trim(<  a b  >), <a b>

test <an empty text is not a space>
  want miss, is-equal <>, < >

test <split keeps empty fields>
  save parts, split(<a,,b>, <,>)
  log <parts: {length(parts)}>
  want hold, is-equal length(parts), 3
```

`want miss, c` checks that `c` is false. `term test` runs every `test`
under `code/` and `test/`, here with the file saved as `test/text.tree`:

```
● test demo
  term 2.9.2 · 1 file
✓ test test/text.tree
  13:28:08.762 · 2.67s · 3 tests · 3 passed
  ⇒ parts: 3
✓ test Tests passed
  13:28:08.821 · 2.75s · 3 tests · 3 passed
```

| command | does |
| --- | --- |
| `term test` | every test in the project |
| `term test double` | the files whose path or text holds `double` |
| `term test test/double.tree` | one file |
| `term test --quiet` | only failures and the verdict |
| `term test --env rust` | the same tests built and run on Rust (or `swift`, `kotlin`) |

A test that starts with `take` lines is sampled: its body runs on a
hundred generated inputs of `number`, `text`, `boolean` and lists of
them, and a failure is shrunk to the smallest input that still fails.
[Writing tests](https://term.surf/guides/tests/writing), [Running tests](https://term.surf/guides/tests/running).

### Laws

A law is a property that must hold for every input, the claim a
property-based test samples. Term proves it instead: a `rule` whose
`seat` lines name its variables and whose `show` states the property,
checked when the file is tested.

```tree
task double
  take n, like integer

  like integer

  back multiply(n, 2)

test <double of three is six>
  want hold, is-equal double(3), 6

rule double-is-sum
  seat n, like integer
  show is-equal double(n), add(n, n)
```

The test checks `double` at `3`. The law covers every integer, and no
input is drawn. One the provers refute fails with the values
that break it, and one they cannot reach is reported as not proven.
[Laws](https://term.surf/guides/tests/laws),
[Laws that decide themselves](https://term.surf/guides/proofs/decide).

### Benchmarks

A benchmark is a task named `time-` something, with no inputs, that
`term time` runs many times and times.

```sh
term time --save main                                   # time the time- tasks, keep a baseline
term time --compare main --fail-on-regression 5         # fail past 5%
term time --history time-split                          # one benchmark's history
term time --cpu code/bench.tree --top 10               # profile one file's hottest tasks
```

`term time` runs them on Node. `term mark` compares Term's emitted code
with hand-written code on each backend, using the 16 programs under
`mark/`, among them:

- binary trees
- fannkuch-redux
- fasta
- k-nucleotide
- mandelbrot
- queens
- spectral-norm

```sh
term mark list
term mark --only sieve --target rust --runs 10 --quick
term mark --target node,rust,swift,kotlin --check     # fail on a regression
```

[Benchmarks](https://term.surf/guides/tests/benchmarks),
[term mark](https://term.surf/guides/commands/mark).

### Fuzzing

`term hunt` looks for compiler bugs, starting from the project's own
files. It runs a fuzzer that mutates the files and keeps any input that
produces a diagnostic not seen before, and oracles that each watch for
one kind of bug:

- a crash
- a hang
- a format round trip that changes the program
- a non-deterministic build
- a backend that refuses what the checker accepted
- a slow compile

```sh
term hunt                       # 4 seeds of 3000 runs
term hunt --runs 200 --seeds 2
term hunt --json
```

`@term/test` holds the rest of the verification tooling:

- property generators and shrinking
- a bounded prover
- model checking (bounded, IC3, CEGAR, temporal properties)
- program synthesis
- an SMT bridge to Z3

[Fuzzing](https://term.surf/guides/tests/fuzzing).

### One program, every backend

A backend is a language the compiler writes a program out in. Each
check above runs on TypeScript first, and reaches the other backends as
follows:

| command | TypeScript | Rust, Swift, Kotlin |
| --- | --- | --- |
| `term test` | built and run on Node | built and run with `--env rust`, `--env swift` or `--env kotlin` |
| `term time` | built and run on Node | not built |
| `term hold --cross` | emitted | emitted, never compiled or run |
| `term make <file> --emit <backend> --run` | built and run | built with the platform's toolchain and run |
| `term make --target <platform>` | | an application, built with the platform's toolchain |

[One program, every backend](https://term.surf/guides/tests/backends).

## Backends

A backend is a language the compiler writes a program out in. Term has
four stable backends and two experimental ones:

| backend | state | writes | needs |
| --- | --- | --- | --- |
| TypeScript | stable | one `.ts` per module in `host/` | Node, to run it |
| Rust | stable | a cargo project with the standard library's crates | `cargo` |
| Swift | stable | one Swift program, or an `.app` | `swiftc`, on macOS |
| Kotlin | stable | a jar, or an Android app | `kotlinc`, and the Android SDK for an app |
| WGSL | experimental | a GPU shader | nothing |
| HVM | experimental | an HVM program | nothing |

A whole-project `term make` emits TypeScript. One file and everything it
loads reaches any backend through `--emit`, every program of a project
through `--env`, and an application through `--target`.

### What one program becomes

One program, a sum type and a match over it, as each of the four stable
backends writes it out:

```tree
form shape
  case circle
    link radius, like number
  case square
    link side, like number

task area
  take s, like shape

  like number

  sift s
    case circle
      back multiply(3, multiply(radius, radius))
    case square
      back multiply(side, side)
```

From `term make --emit <backend> code/area.tree`, without the runtime
helpers each output carries above it:

TypeScript:

```ts
export type Shape =
  | { form: "circle"; radius: number }
  | { form: "square"; side: number }

export function area(s: Shape): number {
  if (s.form === "circle") {
    const radius = s.radius
    const __n0 = 3 * __termInt(radius * radius); if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); return __n0
  } else {
    const side = s.side
    const __n1 = side * side; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); return __n1
  }
}
```

Rust:

```rust
enum Shape {
    Circle { radius: i64 },
    Square { side: i64 }
}

fn area(s: &Shape) -> i64 {
    match s {
        Shape::Circle { radius } => {
            let radius = *radius;
            i64::checked_mul(3, i64::checked_mul(radius, radius).expect("excess: a number past i64")).expect("excess: a number past i64")
        }
        Shape::Square { side } => {
            let side = *side;
            i64::checked_mul(side, side).expect("excess: a number past i64")
        }
    }
}
```

Swift:

```swift
enum Shape {
  case circle(radius: Int)
  case square(side: Int)
}

func area(s: Shape) -> Int {
  switch s {
    case let .circle(radius):
      return (termMultiply(3, (termMultiply(radius, radius))))
    case let .square(side):
      return (termMultiply(side, side))
  }
}
```

Kotlin:

```kotlin
sealed class Shape
data class ShapeCircle(val radius: Long) : Shape()
data class ShapeSquare(val side: Long) : Shape()

fun area(s: Shape): Long {
    when (s) {
        is ShapeCircle -> {
            val radius = s.radius
            return termMultiply(3L, termMultiply(radius, radius))
        }
        is ShapeSquare -> {
            val side = s.side
            return termMultiply(side, side)
        }
    }
    throw IllegalStateException("unreachable")
}
```

### What is the same on all four, and what differs

The four stable backends run a program with one meaning, and each
writes its parts in its own platform's construct:

| | TypeScript | Rust | Swift | Kotlin |
| --- | --- | --- | --- | --- |
| `number` | a JavaScript number held to the safe integers | `i64` | `Int` | `Long` |
| overflow | `__termInt` raises `excess` | `checked_*` panics through `expect` | `+` traps, or `termMultiply` stops | `Math.*Exact` throws |
| a sum type | a tagged union | an `enum` | an `enum` with associated values | a `sealed class` |
| a mask | an interface | a trait | a protocol | an interface |
| `unknown` | `any` | `Rc<dyn Any>` | `Any` | `Any` |
| async | `Promise` | Term's executor | `async` | coroutines |
| text length | code points | `chars().count()` | `unicodeScalars.count` | `codePointCount` |

An exception raised on one backend is caught on all four, with one
carrier type each. A task with no body emits a stub that stops when
called. A list's and a map's members are one table
(`compile/lowered-members.ts`), and a host method outside it is refused
on Rust, Swift and Kotlin before emit. The Rust backend moves a value on
its last use and borrows where it can prove it safe, and keeps
`Rc<RefCell<...>>` handles where it cannot.

### Environments and targets

An environment is the place the emitted TypeScript runs, and `term make`
emits it for one of four:

- `node`: plain `term make` and `term boot`
- `browser`: `term boot --env browser`
- `cloudflare`: `term cast`
- `webview`: the page inside a native app

A native module is picked per environment from `native/<platform>/`,
falling back in a fixed order. `ios`, for one, tries these folders in
turn:

- `ios`
- `apple`
- `toolkit`
- `swift`
- `memory`

A target is a native application for one platform, built with
`term make --target <platform>`:

| `--target` | backend | builds on | proven by |
| --- | --- | --- | --- |
| `macos` | Swift | macOS | built and run |
| `ios` | Swift, for the simulator | macOS | launched on the arm64 simulator |
| `uikit` | Swift, archived for a device | macOS | archived. No device install yet |
| `android` | Kotlin | any machine with `kotlinc` and the SDK | a debug-signed APK on the emulator |
| `linux` | Rust | Linux | built in Docker with GTK 4 and WebKitGTK 6, run under Xvfb |
| `windows` | Rust | Windows | built and run on Windows 11 with WebView2 |

### WGSL, HVM, LLVM and WebAssembly

`--emit wgsl` writes a GPU shader and `--emit hvm` a program for the
interaction-combinator runtime. Each lowers a numeric part of the
language (numbers, booleans, arithmetic, branches, calls, and loops on
WGSL or recursion on HVM), and refuses anything else at its line.
`--emit llvm` and `--emit wasm` go through the program's Rust: rustc
writes the IR and the WASI module.

```sh
term make --emit rust code/main.tree --run    # build with rustc and run
term make --emit llvm code/main.tree          # LLVM IR on stdout
term make --emit wasm code/main.tree --run    # a WASI module, run by Node's WASI
term make --env kotlin --build                # every program of the project, built
```

[Backends](https://term.surf/guides/applications/backends),
[Targets](https://term.surf/guides/applications/targets).

## The standard library

`@term/base` is written in `.tree`: 985 files, of which 493 are public
modules across 111 areas and 492 are per-platform implementations under
`code/native/<platform>/`, one folder per platform:

- `node`
- `browser`
- `javascript`
- `webview`
- `rust`
- `swift`
- `kotlin`
- `shared`

106 modules carry `mark stable`
(what v1 promises), 190 `mark unstable`, and 65 are shelved with
`mark draft`. Its own tests are 1,426 `test` blocks in 178 files, run on
all four backends by the repository gate. Each module's generated
reference is at `term.surf/@term/base/guides/<module>`.

The everyday library calls, and where Term keeps each. A `load` line
imports a module and each `find` under it takes one name.

| standard concept | in Term | example |
| --- | --- | --- |
| print a line | `log`, from `@term/base/console` | `log <hello>` |
| array, list | `make list` | `save items, make list, 3, 1` |
| append | `push` | `push items, 2` |
| map, dictionary | `make hash` | `set ages, <ada>, 36` |
| read a key with a fallback | `get-or-default` | `get-or-default(ages, <ada>, 0)` |
| set | `make set` | `insert seen, <red>` |
| string | `text`, from `@term/base/text` | `split(raw, <,>)` |
| regular expression | a raw text pattern | `find-matches(<<\b[A-Z]\w*>>, input)` |
| `Option`, a value that may be missing | `maybe` | `unwrap-or(first(names), <nobody>)` |
| parse a number | `parse-integer` | `parse-integer(<140>)` |
| HTTP request | `fetch` | `fetch(<https://example.com/>)` |
| read a file | `read-text` | `read-text(<notes.txt>)` |
| run a subprocess | `run` | `run(<echo>, words)` |
| `Promise.all` | `gather` | `gather(works)` |
| standard exceptions | seventeen forms, raised with `halt` | `halt absence, bind thing, <name>` |

| area | modules | holds |
| --- | --- | --- |
| collections | `list`, `hash`, `set`, `sorted-map`, `sorted-set`, `bitset`, `pair`, `range`, `maybe`, `result`, `ordering` | sequences, maps that keep insertion order, sets, ordered maps, options |
| text | `text` and `text/*` (105 files), `rune` | split, trim, case, code points, graphemes, number formatting |
| patterns | `regex`, `pattern/*` | a regular expression engine of Term's own, tested against all four backends |
| numbers | `math`, `integer/*`, `float/*`, `decimal`, `rational`, `complex`, `statistics`, `random/*`, `bit` | checked, wrapping and saturating fixed widths, big integers, exact decimals, seeded randomness |
| formats | `json`, `csv`, `toml`, `url`, `uuid`, `gzip`, `bytes` | read and write |
| files | `file/*`, `path` | read, write, append, bytes, existence, joins and normalization |
| time | `calendar`, `clock`, `duration`, `timezone`, `plain-date`, `date`, `time` | RFC 3339, time zones, a monotonic clock, sleep |
| processes | `process/*`, `environment`, `console`, `log`, `terminal` | run a program, environment variables, standard output and error |
| network | `network/*` (32 files), `socket`, `ssl` | HTTP fetch, an HTTP server, requests and responses |
| concurrency | `task`, `channel`, `mutex`, `atomic`, `supervisor` | gather, spawn, timeouts, channels |
| cryptography | `cryptography/*` | SHA-2 digests, HMAC, PBKDF2 passwords, AES-256-GCM, secure random bytes |
| exceptions | `exception`, `error`, `kink` | the seventeen exceptions and their traces |
| proofs | `proof/*` | equality and the lemmas proofs cite |
| masks | `arithmetic`, `mask/*` | the arithmetic traits, and older masks shelved |
| colors | `color/*` (29 files) | color spaces and conversions |

### Collections

The collections are lists, hashes (maps that keep insertion order),
sets, and `maybe` for a value that may be missing. This program counts
words, sorts them and reads an item with a fallback:

```tree
load @term/base/list
  find list
  find get
  find first
  find sort
  find sort-by
  find join

load @term/base/hash
  find hash
  find get-or-default
  find set
  find keys

load @term/base/maybe
  find maybe
  find unwrap-or

load @term/base/ordering
  find from-texts

load @term/base/console
  find log

form fruit
  slot name, like text
  slot price, like number

task price-of
  take item, like fruit

  like number

  back item/price

task boot
  save words, make list, <b>, <a>, <b>
  save counts, make hash

  walk words
    take word
    save seen, get-or-default(counts, word, 0)
    set counts, word, add(seen, 1)
  log join(keys(counts), <,>)
  log join(sort(words, from-texts), <,>)

  save fruits
    make list
      make fruit, <pear>, 3
      make fruit, <fig>, 5
  save cheap, sort-by(fruits, price-of)
  save names, make list, <Ada>, <Grace>
  log unwrap-or(first(names), <nobody>)
  log get(names, 1)
```

[Collections](https://term.surf/guides/library/collections).

### Text and patterns

A `text` is a string, and a pattern is a regular expression, run by an
engine of Term's own. This program splits, trims and matches text:

```tree
load @term/base/text
  find split
  find trim
  find to-upper-case
  find char-count
  find substring

load @term/base/text/unicode
  find grapheme-slice

load @term/base/regex
  find replace-matches
  find find-match
  find match-named

load @term/base/maybe
  find unwrap-or

load @term/base/list
  find list
  find map
  find join

load @term/base/console
  find log

task boot
  save raw, < a, b ,c >
  save parts, split(raw, <,>)

  save clean
    map parts
      task
        take part, like text

        like text

        back to-upper-case(trim(part))
  log join(clean, <, >)
  save name, <𝄞𝄢 clefs>
  log <{substring(name, 0, 2)} of {char-count(name)}>
  save thumb, <👍🏽 ok>
  log grapheme-slice(thumb, 0, 1)
  save title, <parsing text, step 2>
  log replace-matches(<[^a-z0-9]+>, title, <->)

  sift find-match(<<(?<year>\d{4})-(?<month>\d\d)>>, <due 2026-10>)
    case some
      log unwrap-or(match-named(value, <year>), <?>)
    case none
      log <no date>
```

Text counts and cuts by code point on every backend, and
`text/unicode` by grapheme. The regular expression engine supports
named groups, Unicode properties and inline flags such as `(?i)`, and a
pattern that does not parse raises `regex-mismatch` with where and why.
[Text](https://term.surf/guides/library/text), [Patterns](https://term.surf/guides/library/patterns).

### Numbers

The number modules parse and bound numbers, give fixed widths such as
32-bit integers that wrap, check or saturate on overflow, and supply
floats and seeded randomness:

```tree
load @term/base/text/number
  find parse-integer

load @term/base/math
  find clamp

load @term/base/integer/32
  find i32-add
  find i32-checked-add
  find i32-saturating-add

load @term/base/maybe
  find maybe
  find unwrap-or

load @term/base/float
  find hypotenuse

load @term/base/random/seeded
  find random-source
  find seeded-random
  find between

load @term/base/console
  find log

task boot
  save raw, parse-integer(<140>)
  save score, clamp(raw, 0, 100)
  save mask, parse-integer(<ff>, 16)
  log <{score} {mask}>
  save wrapped, i32-add(2147483647, 1)
  save checked, unwrap-or(i32-checked-add(2147483647, 1), -1)
  save saturated, i32-saturating-add(2147483647, 1)
  log <{wrapped} {checked} {saturated}>
  save d, hypotenuse(3.0, 4.0)
  log <{d}>
  save source, seeded-random(42)
  log <{between(source, 1, 6)}>
```

[Numbers](https://term.surf/guides/library/numbers).

### JSON, CSV, URLs and compression

Each data format is a module that reads and writes it. A malformed
input raises an exception the caller can catch and match on, as
`name-of` does here:

```tree
load @term/base/json
  find parse
  find field-text

load @term/base/json/check
  find json-mismatch

load @term/base/exception
  find mismatch

load @term/base/csv
  find parse, name parse-csv

load @term/base/url
  find url
  find make-url

load @term/base/gzip
  find gzip
  find gunzip

load @term/base/bytes
  find from-text
  find to-text

load @term/base/list
  find list
  find size

load @term/base/console
  find log

task name-of
  take input, like text

  like text

  fork
    mark unsafe
    back field-text(parse(input), <name>)
  halt take
    take problem
    sift problem
      case json-mismatch
        back <not JSON at {at}: {reason}>
      case mismatch
        back <a {actual}, not a {expected}>
      case failure
        back <could not read it: {note}>

task boot
  log name-of(<{"name": "Ada"}>)
  save rows, parse-csv(<a,b\nc,d>)
  log <{length(rows)} rows>
  save address, make-url(<https://term.surf:8080/guides>)
  log address/host
  save packed, gzip(from-text(<term term term term>))
  log to-text(gunzip(packed))
```

[JSON, CSV and URLs](https://term.surf/guides/library/formats).

### Files, paths, processes and the environment

These modules reach the operating system: read and write files, join
paths, run another program, and read environment variables.

```tree
load @term/base/file
  find read, name read-text
  find write
  find append
  find exists

load @term/base/path
  find join
  find normalize-path

load @term/base/process/run
  find run

load @term/base/environment
  find variable
  find has-variable

load @term/base/list
  find list

load @term/base/console
  find log

task boot
  write <notes.txt>, <one\n>
  append <notes.txt>, <two\n>
  log read-text(<notes.txt>)
  log <{exists(<notes.txt>)}>
  log join(<srv/app>, <log.txt>)
  log normalize-path(<a/./b/../c/>)
  save result, run(<echo>, make list, <hello>)
  log <code {result/code}: {result/output}>
  log <{has-variable(<HOME>)} {variable(<HOME>)}>
```

`read` is a Term word, so the file module's `read` is imported under
another name. A program that cannot start raises `command-absence`, and
one its `limit` ended raises `command-timeout`.
[Files and paths](https://term.surf/guides/library/files),
[Processes and the environment](https://term.surf/guides/library/processes).

### Time and dates

The time modules build and shift calendar dates, format them in a time
zone, read the clock and sleep:

```tree
load @term/base/calendar
  find make-utc
  find add-days
  find add-months
  find format

load @term/base/timezone
  find offset-minutes
  find format-in-zone

load @term/base/clock
  find now
  find sleep

load @term/base/duration
  find from-milliseconds

load @term/base/console
  find log

task boot
  save start, make-utc(2026, 10, 3, 9, 30, 0)
  log format(add-days(start, 7))
  log format(add-months(start, 1))
  log <{offset-minutes(start, <Europe/Paris>)}>
  log format-in-zone(start, <America/New_York>, <dddd, MMMM D YYYY HH:mm Z>)
  save begin, now()
  sleep from-milliseconds(250)
  log <slept {subtract(now(), begin)} ms>
```

A moment is epoch milliseconds, `now()` is a clock that only moves
forward, and the zone rules come from each platform's time zone data.
[Time and dates](https://term.surf/guides/library/time).

### Network

The network modules make HTTP requests with `fetch` and answer them with
`serve`, an HTTP server that calls a task for each request:

```tree
load @term/base/network/http
  find fetch

load @term/base/hash
  find get-or-default

load @term/base/network/server
  find serve

load @term/base/network/server/request
  find request

load @term/base/network/server/response
  find response
  find make-ok
  find make-status

load @term/base/console
  find log

task answer
  take asked, like request

  like response

  fork test, is-equal asked/path, </missing>
    hold
      back make-status(404)
  back make-ok(<hello from {asked/path}>)

task boot
  save got, fetch(<https://example.com/>)
  log <{got/status} {get-or-default(got/headers, <content-type>, <none>)}>
  serve 8080, <127.0.0.1>, answer
```

A server that cannot be reached raises `outage`, and a request past its
limit raises `timeout`. [Network](https://term.surf/guides/library/network).

### Concurrency

Concurrency is running several tasks at once. `gather` waits for a list
of them, and a channel passes values from one task to another.

```tree
load @term/base/task
  find gather

load @term/base/channel
  find make-channel
  find send
  find receive

load @term/base/clock
  find sleep

load @term/base/list
  find join

load @term/base/console
  find log

form ping
  case ask
    link question, like text
  case stop

task ask-once
  like text

  save gate, make-channel()
  save message, make ask, bind question, <hello>

  call
    send gate, message
  save got, receive(gate)

  sift got
    case ask
      back question
    case stop
      back <stopped>

task boot
  save works
    make list
      task
        like text

        sleep 300
        back <first>
      task
        like text

        sleep 300
        back <second>
  save done, gather(works)
  log join(done, <, >)
  log ask-once()
```

`gather` runs a list of tasks at once and waits for all, `spawn` starts
one and holds its handle, and `wait-within` gives up after a time.
[Concurrency](https://term.surf/guides/library/concurrency).

### Cryptography

The cryptography modules hash data, store and check passwords, encrypt
and decrypt with AES-256-GCM, and make secure random bytes:

```tree
load @term/base/cryptography/digest
  find sha256

load @term/base/cryptography/derive
  find hash-password
  find verify-password

load @term/base/cryptography/cipher
  find encrypt
  find decrypt

load @term/base/cryptography/random
  find bytes

load @term/base/bytes
  find from-text
  find to-text
  find to-hex

load @term/base/console
  find log

task boot
  log to-hex(sha256(from-text(<hello>)))
  save stored, hash-password(<correct horse>)
  log <{verify-password(<correct horse>, stored)}>
  save key, bytes(32)
  save nonce, bytes(12)
  save sealed, encrypt(key, nonce, from-text(<card 4242>), from-text(<user 7>))
  log to-text(decrypt(key, nonce, sealed, from-text(<user 7>)))
```

[Cryptography](https://term.surf/guides/library/cryptography).

## Native code and docks

Native code is code of the host platform (a Node module, a Rust crate, a
Swift framework) that a Term program calls. A dock is the binding that
reaches it: `dock load` imports a host module, and `dock type` names a
host value Term passes around without reading.

```tree
dock load
  load <node:path>, name path

dock type
  load <any>, name url-handle

bind parse-url, take href, like text
  like url-handle
  case node
    <new URL($href)>
  case browser
    <new URL($href)>
  case rust
    <std::rc::Rc::new(url::Url::parse(&$href).unwrap()) as std::rc::Rc<dyn std::any::Any>>
  case swift
    load <Foundation>
    <URLComponents(string: $href)!>
  case kotlin
    <java.net.URI($href)>

task join-path
  like text

  back path/join(<code>, <boot.tree>)

task open-url
  take href, like text

  like url-handle

  back parse-url(href)
```

Three ways reach a platform:

| construct | does |
| --- | --- |
| `dock load` with `load <module>, name x` | imports a host module (`node:fs/promises`, a crate, a framework), then `x/member(...)` calls into it |
| `dock type` with `load <any>, name h` | declares an opaque host value Term passes around and never reads |
| `bind name` with one `case` per backend | one expression per backend, each parameter spliced in as `$name` |
| `code/native/<platform>/<module>.tree` | a whole module per platform, picked by the build's environment |

A public module of the standard library loads
`.../native/{platform}/<name>`, and the build fills `{platform}` with
the environment it is building for. A bind's text is spliced as written,
so its parameters' names must not collide with anything in the text.
`@term/bind` holds 3,092 binding files, typed handles for each host's
APIs, across these platforms:

- `node`
- `browser`
- `javascript`
- `rust`
- `swift`
- `android`
- `ios`
- `macos`
- `linux`
- `windows`
- `raspberry`
- `assembly`

[Native code](https://term.surf/guides/language/native).

## Dialects, mills and roles

Every `.tree` file is read by the same parser, and what its words mean
depends on its dialect, the vocabulary that kind of file is written in.
A file's dialect comes from its role (the kind of file it is, declared
in `role.tree`), or with no role from its content.

| dialect | written in | read as |
| --- | --- | --- |
| code | any `.tree` with tasks and forms | the language on this page |
| data | `host`, `list`, `mesh`, `tree`, `fuse` and literals | JSON-shaped values, compiled to a typed module |
| documents | a page or guide, role `view` | a sandboxed document a host renders |
| routes and commands | a code file whose `hook`s are URL routes (role `site`) or CLI commands (role `call`) | a router or a command table |
| stylesheets | only `face`, `tone` and `base` rules | CSS |
| manifests | `deck.tree`, `role.tree`, `lock.tree` | the package's description |
| grammars | `mine.tree` and `mint.tree`, role `mill` | a dialect's own grammar |
| secrets | `zone.tree` | which values a program may read, and from where |

### Roles

A role names a set of files and the dialect that reads them. Roles are
declared in a `role.tree`:

```deck
role code
  take @/code/**/*.tree

role view
  take @/page/**/*.tree
```

A role may carry `mark lean`, which reads its files in the lean spelling with labels. `term view` checks the files in the `view` role.
[Roles](https://term.surf/guides/language/dsls/roles).

### Mills

A mill is a dialect's grammar, written in Term itself: `mine.tree`
matches the parsed tree and names its parts, and `mint.tree` says what
each match becomes. The code dialect has been read by its own grammar
since 2026-09-01. The compiler's grammar folder, `deck/mill/code/tree/`,
holds 11 dialects:

- `base`
- `book`
- `code`
- `deck`
- `host`
- `line`
- `mill`
- `operand`
- `test`
- `view`
- `zone`

The `note` grammar under
`deck/mill/code/text/` reads infix arithmetic inside `role note`, and
lowers it to the same calls as the code dialect.
[Mills](https://term.surf/guides/language/dsls/mills),
[Tree assembly](https://term.surf/guides/language/syntax/assembly).

### Data files

A data file holds values only, no code, the way a JSON or YAML file
does, and compiles to JSON-shaped values:

```tree
tree service-base
  host env, <prod>
  host retries, 3

host region, <eu>
list ports
  80, 443
host service
  fuse service-base
  host retries, 5
  list members
    mesh
      host name, <ada>
    mesh
      host name, <bob>
```

A data file is `host` keys, `list` lists and `mesh` maps inside a list,
with `tree` anchors copied in by `fuse`. `term make` compiles it to a
typed module, and `@term/host` reads it at run time, in a long and a
compact form:

```sh
term mold data/site.tree --json     # as JSON
term mold data/site.tree --pack     # the compact form
term mold data/small.json           # JSON as the long form
term look data/site.tree            # every key
```

[Data files](https://term.surf/guides/language/data).

## Applications

An application is an ordinary Term project whose entry `term boot` or
`term make --target` knows how to run. Each part a programmer from
React, Express or a CLI library looks for, and how Term spells it:

| standard concept | in Term | example |
| --- | --- | --- |
| `main`, the entry point | `task boot`, run by `term boot` | `task boot` |
| CLI command | `hook` | `hook greet` |
| CLI flag | `take` under the `hook` | `take name, like text` |
| page, component | `view` | `view panel` |
| HTML element | `view` with the tag | `view h1, <Shelf>` |
| prop | `take` on the view, `bind` at the call | `bind title, <To read>` |
| `children` | `site` | `site` |
| HTML attribute, event handler | `seed` | `seed click` |
| state, signal | `make-signal` | `host read-count, make-signal(0)` |
| effect, memo | `make-effect`, `make-memo` | `make-effect` |
| HTTP server | `host` called with a route task and a port | `host(route, port)` |
| CSS class | `face` | `face shelf` |
| SQL query | `query` | `query(<SELECT title FROM book ORDER BY title>, make list)` |
| native window | `open-window` | `open-window(<Shelf>, 720, 540)` |
| cross-compile | `term make --target` | `term make --target macos` |

### A web application

A web application is a set of views (components that render HTML) and a
route task that picks what to render for each URL, served by `host` on a
port:

```tree
load @term/site/dom/dom
  find view

load @term/site/dom/page
  find set-title

load @term/site/view/native/{platform}/host
  find host

load @term/site/http/http
  find request
  find response

load @term/site/view/route-answer
  find answer-nothing

load @term/base/maybe
  find maybe

view home
  take host, like view
  view h1, <Shelf>

task route
  take host, like view
  take request, like request
  like maybe, like response

  fork test, is-equal request/path, </>
    hold
      set-title <Shelf>
      home host
  back answer-nothing()

task boot
  take url, like text
  take port, like u16

  host(route, port)
```

`@term/site` is the application framework. A `view` is a component that
renders on the server and is taken over by the client, and `term boot`
serves it with hot module reload. Reactive state is fine-grained: a
signal's readers update the DOM directly, with no virtual DOM.

| part | module | does |
| --- | --- | --- |
| components | `@term/site/dom/dom` | `view` with `take` props, `site` for the caller's children, `seed` for attributes and events |
| state | `@term/site/view/reactive` | `make-signal`, `read-signal`, `write-signal`, `make-effect`, `make-memo`, `batch` |
| routes | `@term/site/http/http` | a top-level `hook /path` per page, `task post` and the other methods under it, `route-server` for an API |
| forms | `@term/site/http/body` | `read-body`, `fill` into a form, `redirect` |
| styles | a stylesheet file | `face` classes, `tone` themes, `case sm` and `case hover` variants, compiled to CSS |
| databases | `@term/site/base/postgres` | `connect`, `query`, `run`, `field` |
| graphics | `@term/site/graphics` | a drawing surface |

```tree
load @term/site/dom/dom
  find view

load @term/site/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/base/list
  find list

view panel
  take host, like view
  take title, like text
  view section
    seed class, <shelf>
    view h2, title
    site

view home
  take host, like view
  take books, like list
  view panel
    bind title, <To read>
    view ul
      walk list, books
        hook next
          take site, name title
          view li, title

view counter
  take host, like view
  save count, make-signal(0)
  view button
    seed click
      write-signal count, add(read-signal(count), 1)
    <Add one>
  view p
    read read-signal(count)
```

A stylesheet:

```tree
tone base
  have ink, tint rgb, 24, 24, 27
  have paper, tint hex, <fafafa>

tone dark, have ink, tint hex, <f4f4f5>

base style
  find(body)
  have color, <var(--ink)>
  have background, <var(--paper)>

face shelf
  have display, flex
  have gap, 16px

face title, have font-size, 28px
  case sm
    have font-size, 36px
  case hover
    have text-decoration, underline
```

`term cast` builds a server-rendered app into a Cloudflare Worker
(`work/index.ts` and `build/`), uploaded with Cloudflare's own
`wrangler deploy`. [A web application](https://term.surf/guides/applications/web),
[Routes](https://term.surf/guides/applications/web/routes),
[Components](https://term.surf/guides/applications/web/components),
[State](https://term.surf/guides/applications/web/state),
[Styles](https://term.surf/guides/applications/web/styles),
[Databases](https://term.surf/guides/applications/databases).

### `@term/face`

`@term/face` is a library of headless user interface components written
in Term. Headless means each holds its behavior and leaves its look to
the stylesheet. There are 74 of them under `deck/face/code/component/`,
among them:

- `button`
- `dialog`
- `dropdown-menu`
- `combobox`
- `tabs`
- `table`
- `toast`
- `tooltip`
- `select`
- `slider`
- `calendar`
- `sidebar`
- `command-palette`

### Command-line applications

A command-line application is a file of `hook`s, one per command, each
naming the task it runs:

```tree
load @term/base/console
  find log

load @term/base/list
  find size

# Say hello
hook greet
  # who to greet
  take name, like text
    need true
  # say it twice
  take loud
    code l
    like boolean
    bind code false
  task greet

# Work with books
hook book
  # Add a book
  hook add
    # the title
    take words, like list, like text
    task add-book

task greet
  take name, like text
  take loud, like boolean

  log <hello, {name}>

task add-book
  take words, like list

  log <added a title of {length(words)} words>
```

A `hook` is a command, its `take` lines its flags (with `need true`, a
one-letter alias by `code`, a default by `bind code`), and a nested
`hook` a subcommand. The comment above each is its help text.

```sh
term boot code/greet.tree -- greet ada
term boot code/greet.tree --out host/greet       # a runnable command
```

[Command-line applications](https://term.surf/guides/applications/command-line).

### Native applications: `@term/cask`

A native application is a desktop or phone app. `@term/cask` opens a
native window around the platform's WebView and shows a Term page in
it:

```tree
load @term/cask/cask
  find open-window
  find load-bundle
  find load-url
  find on-message
  find activate
  find run

load @term/site/dom/dom
  find view

task dispatch
  take message, like text

  like text

  mark async
  back message

view home
  take host, like view
  view h1, <Shelf>

task boot
  take place, like text
  take remote, like boolean

  like void

  save made, open-window(<Shelf>, 720, 540)
  on-message made, dispatch

  fork test, remote
    hold
      load-url made, place
    miss
      load-bundle made, place
  activate made
  run()
```

A cask is a window, the platform's WebView and a bridge between the page
and the native side, written in Term per platform (WebKitGTK 6 on Linux,
WebView2 on Windows). `term make --target <platform>` builds the app
with the platform's own toolchain, for any of these platforms:

- `macos`
- `ios`
- `android`
- `linux`
- `windows`

Measured on macOS on 2026-10-05: a 237 KB binary, cold start in 298 ms.
Device features (the camera, notifications, the file picker, audio
recording) reach the page through `@term/bind`, behind a permission the
app declares. [Native applications](https://term.surf/guides/applications/native),
[Device features](https://term.surf/guides/applications/device).

### Native views

Besides the WebView cask, a `view` can render to each platform's own
toolkit: SwiftUI and UIKit on Apple platforms, Jetpack Compose on
Android and the desktop, and a terminal renderer on all four backends.
The repository gate builds the same blog program for `macos`, `ios`,
`android` and `compose`. [Native views](https://term.surf/guides/applications/views).

### Documents

A file in the `view` role is a document: a sandboxed page that places
components and asks its host for data by query, and cannot run code of
its own. `term view` checks one, and `term view page/x.tree --find`
prints the queries it asks a host to answer.
[Documents](https://term.surf/guides/applications/documents).

## Parsers

A parser here is a reader for a format a running program is handed,
such as JSON text or the bytes of a font. It is written by hand on a
cursor, a position in the input that each read moves forward, or
generated from a grammar. Each part a programmer from ANTLR, PEG.js or
nom looks for:

| standard concept | in Term | example |
| --- | --- | --- |
| grammar file | `mine.tree` | `code/version/mine.tree` |
| grammar rule | `mine` with a name | `mine digits` |
| reference another rule | `mine form, form` | `mine form, form digits` |
| literal | `mine char` | `mine char, <.>` |
| repetition | `mine list` | `mine list` |
| character class | `mine range`, with `bind base` and `bind head` | `mine range` |
| capture | `send` under what it names | `send major` |
| semantic action | `mine value` | `mine value` |
| parser generator | `term make` | `term make` |
| hand-written parser, lexer | a cursor | `save cursor, make-text-cursor(input)` |
| parser combinators | none | |
| a grammar for a new kind of `.tree` file | a mill: `mine.tree` matches, `mint.tree` builds, under role `mill`. Mills ship inside the compiler | |

The reader below reads a number one digit at a time on a text cursor:

```tree
load @term/mill/feed
  find text-cursor
  find make-text-cursor
  find peek-text-cursor
  find peek-text-cursor-code
  find read-text-cursor
  find get-text-cursor-position

load @term/mill/text/json/code
  find read-json
  find write-json

load @term/base/list
  find push

load @term/base/console
  find log

task read-number
  take cursor, like text-cursor

  like number

  save start, get-text-cursor-position(cursor)
  save value, 0

  walk test
    hook test
      and is-minimum(peek-text-cursor-code(cursor), 48)
        is-maximum(peek-text-cursor-code(cursor), 57)
    hold
      save digit, subtract(peek-text-cursor-code(cursor), 48)
      read-text-cursor cursor
      save value, add(multiply(value, 10), digit)
  fork test, is-equal get-text-cursor-position(cursor), start
    hold
      halt <expected a digit at {start}>
  back value

task boot
  save value, read-json(<[1,2,{"a":true}]>)
  log write-json(value)
```

`@term/mill` reads formats at run time. `feed.tree` holds a text cursor
and a byte cursor with a writer (`read-byte`, `read-bytes`, `seek`,
`write-int` in either byte order), and the readers are written on them.
Grammars for text formats live under `deck/mill/code/text/`, among them:

- JSON
- CSV
- CSS
- HTML
- XML
- SQL
- URIs
- HTTP
- email addresses
- dates

Grammars for binary formats live under `deck/mill/code/blob/`:

- fonts
- archives
- images
- documents
- executables

A format can also be written as a
`mine` grammar, and the generator writes its reader. Only the formats
with a working reader are listed in the guide: JSON, the OpenType
tables `cmap`, `glyf` and `maxp`, and the others it names. Most binary
grammars are drafts. [Parsing text](https://term.surf/guides/parsers/text),
[The cursor](https://term.surf/guides/parsers/cursor),
[Parsing binary](https://term.surf/guides/parsers/binary),
[Grammars](https://term.surf/guides/parsers/grammars).

## Packages and the registry

A package in Term is a deck: a folder with a `deck.tree` manifest, which
another project names in a `link` line and then loads from. Each part a
programmer from npm or Cargo looks for:

| standard concept | in Term | example |
| --- | --- | --- |
| package | a deck | `deck @alice/tools` |
| manifest, `package.json`, `Cargo.toml` | `deck.tree` | `deck.tree` |
| version | `mark` | `mark <1.4.2>` |
| description | `head` | `head <Small tools for Alice>` |
| license | `lock` | `lock mit` |
| entry point | `boot` | `boot ./code/boot` |
| dependency | `link` | `link @alice/tools, mark <0.1.x>` |
| version range | the text after `mark` | `mark <^1.2.0>` |
| lock file | `lock.tree` | `lock.tree` |
| install | `term load` | `term load` |
| add a dependency | `term save` | `term save @alice/tools ^1.2.0` |
| remove one | `term toss` | `term toss @alice/tools` |
| a local folder, `npm link` | `term link` | `term link vendor/tools` |
| bump the version | `term move mark` | `term move mark` |
| publish | `term host` | `term host --dry` |
| audit | `term seek --audit` | `term seek --audit` |

### The manifest

The manifest is the deck's `deck.tree`, one line per field:

```deck
deck @alice/tools
  mark <1.4.2>
  head <Small tools for Alice>
  lock mit
  site <https://github.com/alice/tools>
  mind <Alice Example>, base <alice@example.com>
  make <text>
  code ./src
  boot ./code/boot
  link @bob/parse, mark <^1.2.0>
  need @term/code, mark <2.9.x>
```

| line | means |
| --- | --- |
| `deck <name>` | the package's name, scoped as `@scope/name` |
| `mark <v>` | its version |
| `head <text>` | a one-line description |
| `lock <id>` | its license |
| `site <url>` | its source |
| `mind <name>, base <mail>` | an author |
| `make <word>` | a keyword |
| `code ./dir` | the code root, `./code` by default |
| `boot ./file` | what `term boot` runs |
| `link @x/y, mark <range>` | a dependency. A range is exact, `1.4.x`, `^1.2.0`, `~1.2.0`, or two joined by `\|` |
| `need @term/code, mark <range>` | the version of Term this project builds with |
| `base scope, <registry>` | sends a scope to another registry |

`lock.tree` pins every resolved version and its hash, and `term lint`
warns on a manifest line no tool reads (`L055`).
[The deck.tree manifest](https://term.surf/guides/packages/manifest),
[Versions](https://term.surf/guides/packages/versions).

### Installing, linking and publishing

Installing fetches every dependency a manifest links, linking uses a
deck from a folder on this machine instead, and publishing uploads a
signed release of the deck to its scope's registry:

```sh
term load                        # install every link, verified against lock.tree
term load --offline              # no network
term save @alice/tools ^1.2.0    # add a link, then install
term toss @alice/tools           # remove one
term link vendor/tools           # use a folder on this machine
term seek                        # check every locked version is installed
term seek --audit --code         # advisories, and a scan of your own .tree files
term move mark                   # raise the patch (move mark 2 the minor, 1 the major)
term bind                        # log in to term.surf with Google
term host --dry                  # build and sign, upload nothing
term host                        # publish
```

The package manager follows pnpm: a content-addressed store under
`~/.base/@term/code/`, and each project's decks linked into its `link/`.
The registry is OCI: a deck is published as an artifact to a container
registry, `@term` to `ghcr.io/cluesurf/term`, and any scope can be sent
to another registry. Every file is content-addressed, so a new version
uploads only the objects the registry is missing, and text files are
packed by content. A release is signed by a key in the scope's key set,
pinned on first use, and `term host --trust <key>` and `--untrust` add
and remove keys. `term seek --audit` checks installed versions against advisories and
scans your code for dangerous native calls, with JSON and SARIF output.
[Installing packages](https://term.surf/guides/packages/install),
[Publishing](https://term.surf/guides/packages/publish),
[The registry](https://term.surf/guides/packages/registry),
[Auditing dependencies](https://term.surf/guides/packages/audit).

## The command line

`term` is one program with 38 verbs. Every verb prints the same way: an
opening item naming the verb and the folder, one item per thing that
happened, and a closing item with the verdict, the time and the counts.

Each command a programmer from npm, Cargo or Go reaches for, and the
`term` verb that does it:

| standard concept | in Term | example |
| --- | --- | --- |
| `cargo new`, `npm init` | `wake` | `term wake demo` |
| run, dev server | `boot` | `term boot` |
| build, compile | `make` | `term make` |
| one file to one backend | `make --emit` | `term make --emit rust code/sum.tree` |
| test | `test` | `term test` |
| benchmark | `time` | `term time` |
| type check and prove | `hold` | `term hold` |
| format, `prettier`, `gofmt` | `form` | `term form` |
| lint | `lint` | `term lint` |
| REPL | `walk` | `term walk` |
| clean | `wash` | `term wash` |
| install dependencies | `load` | `term load` |
| publish | `host` | `term host` |
| version | `show` | `term show` |

### Start and run

The verbs that make a project and run its program:

| verb | does |
| --- | --- |
| `wake [name]` | start a new project |
| `boot [mode] [entry]` | compile the program and run it, restarting on every save. `boot star` runs it in production, `--env browser` serves it to a browser |
| `walk` | a REPL: type Term a line at a time and see each value |
| `halt` | stop running `boot` programs, all or by `--port` |
| `feed [entry]` | retired. The browser development server is `term boot --env browser` |

### Build

The verbs that compile a project, or clear what a build left behind:

| verb | does |
| --- | --- |
| `make [file]` | compile every `.tree` file to `host/`, the one command that says whether a project compiles. `--emit`, `--env`, `--target`, `--watch`, `--separate` |
| `wash [target]` | delete the build output and the project's cache. `wash base` the machine-wide module cache |
| `cast [entry]` | build a server-rendered app into a Cloudflare Worker |
| `work` | a compiler that stays running and answers over HTTP |

### Test and measure

The verbs that check a program is right and time how fast it runs:

| verb | does |
| --- | --- |
| `test [filter]` | run every `test` under `code/` and `test/`, and prove the laws beside them |
| `time [filter]` | run the `time-` benchmarks, or profile a file with `--cpu` or `--memory` |
| `mark [rest..]` | compare emitted code with hand-written code per target |
| `hunt [glob]` | look for compiler bugs with oracles and fuzzing |
| `hold [paths..]` | the proof gate |
| `knit [spec..]` | from a spec in words, a model writes the code, the laws and the proofs until `term hold` holds |

### Keep code tidy

The verbs that format files and flag likely mistakes:

| verb | does |
| --- | --- |
| `form [paths..]` | lay `.tree` files out in the one standard layout. `--check` fails on an unformatted file |
| `lint [paths..]` | 41 rules for likely mistakes and style, some fixable with `--fix`. `# lint off L004` turns one off on the next line |
| `scan <file>` | check one file without the rest of its project |

### Ask about the project

The verbs that print what a project holds, without changing it:

| verb | does |
| --- | --- |
| `look [target]` | list the forms and tasks a module offers |
| `roll [kind]` | every deck, exception, task, route and tell in the build. `term make` writes it to `host/roll.json` |
| `mold [file]` | convert a data file between long form, compact form, JSON and code |
| `view [path]` | check a document in the `view` role |
| `show [what]` | the toolchain's version, the project's (`show mark`), or the native toolchains (`show tools`) |
| `mind [fact]` | remember a fact about the project, or list and find them |

### Packages

The verbs that install, add, remove and publish decks (packages):

| verb | does |
| --- | --- |
| `load` | install every dependency |
| `save [deck] [mark]` | add a dependency |
| `toss [deck]` | remove a dependency |
| `link [deck]` | use a local copy of a deck |
| `seek` | check the install, or audit it with `--audit` |
| `host` | publish to a registry |
| `bind` | log in to term.surf with Google, for publishing |
| `move <target> [level]` | raise the version |
| `note [deck]` | print a deck's manifest |

### Term itself and the rest

The verbs that manage the installed versions of Term, and the few that
fit no group above:

| verb | does |
| --- | --- |
| `self` | the versions of Term on this machine: `list`, `find`, `load`, `pick`, `need`, `show`, `toss`, `wash`, `check`, `update`, `back`, and `skill`, which teaches a coding agent the verbs |
| `update` | the newest release, the same as `term self update` |
| `base` | the base record system: versioned structured data, with `init`, `log`, `diff`, `commit`, `import` and more |
| `zone [rest..]` | secrets and environment: run a command with a zone's values, handed to that one process |
| `fill` | print the shell completion script |

### Flags every verb takes

A flag is an option on the command line, and these mean the same on
every verb:

| flag | does |
| --- | --- |
| `--help`, `-h` | the verb's arguments and flags. The verb does not run |
| `--quiet`, `-q` | only failed items and the closing item |
| `--verbose`, `--trace` | debug items, and trace items for debugging Term itself |
| `--log json` | one JSON object per event on standard output, and no items |
| `--plain` | one sentence per item, for screen readers and transcripts |
| `--color <auto\|always\|never>` | color. `NO_COLOR` and `FORCE_COLOR` are read too |
| `--strict` | a warning fails the run |
| `--yes`, `-y` | take every default rather than asking |
| `--utc`, `--no-motion`, `--raw`, `--source`, `--all` | clocks in UTC, a still spinner, a child's output untouched, one service of a stream, every entry past the cap |

Items go to standard error, and what a verb was asked for (a listing, a
molded file, JSON) to standard output, so a pipe gets the data alone.

| exit | means |
| --- | --- |
| 0 | it worked, warnings allowed |
| 1 | a problem in the project's code or input |
| 2 | the command line was not understood |
| 3 | a toolchain the command needs is missing |
| 70 | a bug in Term itself, with a crash log |
| 130 | stopped by ctrl-c |

[Commands](https://term.surf/guides/commands).

## Installing on each platform

Each platform installs the same signed release by its own route:

| platform | command |
| --- | --- |
| macOS, Linux | `eval "$(curl -fsSL https://term.surf/load \| sh)"` |
| Homebrew | `brew install cluesurf/tool/term` |
| Windows, PowerShell | `irm https://term.surf/load.ps1 \| iex` |
| Debian, Ubuntu | the signed apt repository, below |
| Fedora, RHEL | the signed dnf repository, below |

```sh
sudo mkdir -p /etc/apt/keyrings
sudo curl -fsSLo /etc/apt/keyrings/term.asc https://term.surf/term.asc
sudo curl -fsSLo /etc/apt/sources.list.d/term.list https://term.surf/apt/term.list
sudo apt update
sudo apt install term
```

```sh
sudo curl -fsSLo /etc/yum.repos.d/term.repo https://term.surf/rpm/term.repo
sudo dnf install term
```

apt and dnf put the release at `/usr/lib/term` and update it with the
system. Every route installs the same signed release bytes, and the
script and Homebrew routes write under `~/.base/@term/code/`:

```
~/.base/@term/code/call/term                 a link, the one thing on PATH
~/.base/@term/code/code/2.9.2/term/          the release, unpacked
~/.base/@term/code/code/2.9.2/install.tree   its version, platform and sha256
```

An install is one bundled script, `host/line.js`, holding:

- the compiler
- the package manager
- the test runner
- the formatter
- the linter
- the dev server

It sits beside the standard library's `.tree` source and three
packages that cannot be bundled (`esbuild`, `hono`, `@hono/node-server`).
Node, the web and Cloudflare need nothing more. The native backends need
their platform's compiler, which Term does not install, and
`term show tools` checks for each:

| target | backend | the build calls |
| --- | --- | --- |
| `macos`, `ios` | Swift | `swiftc` through `xcrun`, from Xcode |
| `android` | Kotlin | `kotlinc`, and the Android SDK's `aapt2`, `d8` and `apksigner` |
| `linux`, `windows` | Rust | `cargo` |

### Versions of Term

Several versions live side by side, and each project can build with its
own. `term self need 2.9.2` writes `need @term/code` into `deck.tree`
and pins the release's hash in `lock.tree`, so every machine runs the
same release. The version a command runs, first match wins:

| | asked by | for |
| --- | --- | --- |
| 1 | `term +2.9.2 make` | that one command |
| 2 | `TERM_VERSION=2.9.2` | every command that sees it |
| 3 | `need` in the nearest `deck.tree` | that project |
| 4 | `term self pick 2.9.x` | everywhere outside a project |
| 5 | `call/term` | where nothing asks |

`term self show` prints which one runs here and why, and
`TERM_NEED=local` forbids a download.
[Install](https://term.surf/guides/basics/install), [term self](https://term.surf/guides/commands/self).

## The editor and the language server

`@term/flow` is the language server, and the VS Code extension
(`cluesurf.term-code`) carries it with the highlighting. The server
calls the same `compile` that `term make` calls, with the same resolver,
roles and lean flag, so a red line in the editor is a failed build.

| feature | what it does |
| --- | --- |
| diagnostics | the errors and warnings `term make` reports, 150 ms after the last keystroke, and each lint finding with its rule code |
| hover | the signature under the cursor with its `#` doc comment, or the inferred type |
| completion | fields and methods after `/`, module paths in a `load`, a module's exports under `find`, values of the expected type first |
| navigation | go to definition across files, document links on every path, references, rename, symbols, highlights, call hierarchy |
| editing | signature help, folding, code actions (add the missing `load`, apply lint fixes), a reference count lens, inlay hints for inferred types |
| semantic tokens | types, values and methods colored by what they resolve to |

The parser recovers from errors, so a half-written line does not stop
the rest of the file from being read. The server speaks the Language
Server Protocol over stdio, so another editor can start it with
`node make/server.js` from `deck/flow/`. The extension is built from
this repository:

```sh
pnpm --dir deck/flow install --ignore-workspace
pnpm --dir deck/flow build
pnpm --dir deck/flow make     # writes make/term-code.vsix
pnpm --dir deck/flow bind     # installs it into VS Code
```

[Editor support](https://term.surf/guides/basics/editor).

## Self-hosting

A self-hosted language is one whose own tools are written in it. The standard library, the application framework, the grammars and the
bindings are Term already. The compiler, the CLI and the package manager
are being ported from TypeScript to Term one module at a time: each
ported module is a `.tree` file the build compiles into its deck's
`host/port/` (`pnpm run make:port`), and the TypeScript left is the
shell around them. The CLI
entry `host/line.js` is bundled from the Term console,
`deck/call/code/line/base.tree`. Counted in this repository:

| deck | `.tree` files | `.ts` files | `.ts` lines |
| --- | --- | --- | --- |
| `make`, the compiler | 293 | 102 | 13,281 |
| `call`, the CLI | 246 | 65 | 30,681 |
| `deck`, the package manager | 60 | 49 | 3,936 |
| `flow`, the language server | 19 | 6 | 437 |
| `test`, verification tooling | 62 | 27 | 3,444 |
| `mill`, `scan`, `bind`, `cask`, `host`, `mark` | 588, 15, 3,092, 7, 12, 15 | 0 | 0 |

The kernel is still TypeScript (`deck/make/code/check/`), so a Term
program cannot load it. The plan ends in a native `term` binary built by
Term's own Rust backend. Today `term` runs on Node, and
`term --version` takes about 0.13 seconds, nearly all of it starting
Node.

## Status

What works, measured in this repository on the release 2.9.2:

| area | state |
| --- | --- |
| the language, both spellings | stable. Every sample on this page compiles |
| TypeScript, Rust, Swift, Kotlin | stable. The gate runs the same programs through all four |
| WGSL, HVM | experimental fragments |
| LLVM, WebAssembly | through the Rust output, for programs that name no crate |
| type inference, masks, generics, gradual types | working |
| the kernel and the hold gate | working. Tier 0 owed by every program, claims re-checked by Lean 4 with `--lean` |
| tests, sampled tests, laws, benchmarks, fuzzing | working. Benchmarks on Node only |
| the standard library | 493 public modules, 106 stable |
| web apps: SSR, signals, routes, forms, styles, HMR | working on Node and Cloudflare |
| native apps: macOS, iOS simulator, Android, Linux, Windows | built and run on each |
| the package manager and the OCI registry | working against a registry in tests. Term's own release is published to `ghcr.io/cluesurf/term/code`, and no library deck is pushed there yet |
| the CLI | 38 verbs |
| the language server and VS Code extension | working. Installed from a `.vsix` |
| installers | script, Homebrew, PowerShell, apt and dnf, for six platforms |

The gate, `pnpm term:test`, runs 916 suites. The TypeScript suites under
`test/` are 739 files.

What is missing, as each guide's own "What is missing" part records:

| area | missing |
| --- | --- |
| language | nested patterns and guards in a `sift`. Infix outside the `note` grammar. Hygiene in templates. A package cannot add a dialect of its own |
| types | the check at the `unknown` seam is built and off by default (`TERM_UNKNOWN_SEAM=1`). A mask cannot take a type parameter. No associated types or super-masks |
| proofs | overflow is not an obligation. Tier 0 does not cover reading an absent value. A proven read keeps its run-time check. Sturm and CAD carry no certificate. No deploy step runs `term hold` yet |
| backends | no backend of its own for WebAssembly or LLVM. `term make --env` compiles a shared library once per program. A construct one emitter lowers and another does not is found by a failing suite, not the checker |
| tests | mocks, suites and coverage. Laws are never sampled. A failed test on a native backend names its line, not the two values |
| library | streaming HTTP bodies, a router module, WebSocket server, YAML, XML, zip and tar, argon2, RSA, ECDSA, JWT, an instant type distinct from a number |
| web | hydration that adopts the server's nodes (the client draws again), keyed lists, streaming, islands, code splitting |
| native | a device install on an iPhone (waits on a signing identity), notarization, installers, a full-screen terminal interface |
| packages | a strict `link/`, hard links from the store, deltas inside a changed file, a transparency log, yanking a version |
| editor | a Marketplace listing, packages for other editors |
| self-hosting | a native `term` binary. The compiler's shell and kernel are TypeScript |

## Building from a clone

Every path is relative to the root of this repository, and every command
runs from it.

| task | command |
| --- | --- |
| install | `pnpm install`, then `pnpm run install:all` |
| check the native toolchains | `sh task/dev/bootstrap/start.sh check` |
| rebuild the CLI after editing compiler or CLI code, or a ported `.tree` | `pnpm run make:line` (it takes the line lock and runs `make:port` first) |
| build one package | `pnpm --dir deck/<name> exec node "$PWD/host/line.js" make` |
| build the standard library | `pnpm --dir deck/base exec node "$PWD/host/line.js" make --trees` |
| test one package | `pnpm --dir deck/<name> exec node "$PWD/host/line.js" test` |
| every gate | `pnpm term:test` (`--only <substr>` a subset, `--fresh` ignores the result cache, `--list` the suites) |
| the TypeScript suites | `npx vitest run` |
| no path leaves the repository | `pnpm term:self-contained` |
| convert base code to lean | `pnpm term:lean-convert <file> --commit` |
| release | `pnpm term:release` |

Rules for a change:

- Rebuild with `pnpm run make:line` after editing compiler or CLI code, or you measure a stale binary.
- Only `term make` proves a file compiles. `term scan` checks one file alone.
- Hold the line lock (`node task/term/line-lock.ts take --by <name>`, then `free`) while editing a compiler `.tree` that a running build compiles.
- Run `npx vitest run` and `pnpm term:test` before finishing compiler work. A rise in the error count after a fix is new information: read the new errors first.
- Never commit an absolute path, a home path, or a path that climbs out of the repository. `pnpm term:self-contained` fails on one.
- Names are kebab-case files and folders, a task is a verb, a form a noun, and exceptions are nouns (`absence`, `excess`), never `-error`.

`AGENTS.md` holds the same rules in short, for coding agents, and
`CONTRIBUTING.md` the rest of the process.

## License

Copyright 2026 Lance Pollard / <a href='https://clue.surf'>ClueSurf</a>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe.
