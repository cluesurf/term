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
typed language with a small core, while Term aims more squarely at
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

On the application side, the standard library is written in `.tree` and
covers the usual primitives, collections, IO, text, time, and
cryptography, each mapped to its native counterpart. The web stack is
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

```sh
curl -fsSL https://term.surf/load | sh
```

or, with Homebrew:

```sh
brew install cluesurf/tool/term
```

Both install the same signed release, `@term/code`, from
`ghcr.io/cluesurf/term/code`, built for `darwin-arm64`, `darwin-x64`,
`linux-x64` and `linux-arm64`. Each checks the download's sha256
against the registry's digest. The script then runs `term self check`,
which verifies the release signature against the `@term` key set before
anything goes on your `PATH`. It writes only under
`~/.base/@cluesurf/term/`, and prints the `PATH` line to add rather than
editing a shell profile.

Term runs on Node.js 22.3 or newer.

```sh
term --version     # 2.6.2
term self update   # the newest release, verified, beside the current one
term self back     # back to the previous version, no download
```

A Homebrew install updates with `brew upgrade cluesurf/tool/term`.

The guides, from a first program to proofs, native apps and the package
registry, are at [term.surf/guides](https://term.surf/guides).

## Packages

This repository is a monorepo. Each part of the ecosystem is a deck (a
package) under `deck/`. A deck's name comes from the `deck <name>` line
in its own `deck.tree`, not from `package.json`, and the decks import
each other by that name (`@term/base/code/list`), linked locally through
`term link`.

The compiler, CLI, language server and package manager are written in
TypeScript (under each deck's `code/`). The standard library, the app
framework and everything else are written in `.tree` and compiled by the
compiler itself.

## Finding your way around

```
.
├── deck/                 every package
│   ├── make/             @term/make   the compiler (TypeScript)
│   │   └── code/
│   │       ├── parser/   .tree text to a generic tree, and diagnostic codes
│   │       ├── compile/  mill to typed AST, then one emitter per backend
│   │       │             (typescript.ts, rust.ts, kotlin.ts, swift.ts, wgsl.ts)
│   │       ├── check/    type inference, the kernel, the prover, contracts
│   │       ├── lint/     lint rules
│   │       └── format/   the formatter
│   ├── mill/             @term/mill   the DSL grammars, one mine.tree and
│   │   └── code/<name>/  mint.tree per dialect (code, view, host, zone, ...)
│   ├── call/             @term/call   the CLI, built to host/line.js
│   │   └── code/         line.ts is the entry, make.ts the build driver,
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
│   ├── feed/             @term/feed   text and binary format grammars
│   ├── cask/             @term/cask   native app shell: window, WebView, bridge
│   ├── scan/             @term/scan   dependency and advisory scanning
│   └── test/             @term/test   fuzzing, benchmarks, model checking
├── book/                 the language guide, one cheatsheet page per topic
├── test/                 the TypeScript suites, by area (parser/, check/,
│                         compile/, call/, native/, ...)
├── host/line.js          the built CLI. Rebuild it after editing any .ts
├── link/                 locally linked decks
└── deck.tree             this workspace's own declaration
```

Where to start digging:

| you want | open |
| --- | --- |
| what a keyword means | [term.surf/guides](https://term.surf/guides), then the dialect in `deck/mill/code/` |
| why a file fails to compile | `deck/make/code/check/` |
| what a backend emits | `deck/make/code/compile/<target>.ts` |
| what a CLI command does | `deck/call/code/line.ts`, then the file it dispatches to |
| a stdlib type or task | `deck/base/code/<name>.tree` |
| the tests for any of it | `test/<area>/` |

Design notes, plans and the roadmap live outside this tree, in the
parent repository's `note/term/`.

## How It Works

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
typed AST, resolves names, and type-checks through a gradual,
bidirectional inference pass that elaborates into a dependent kernel for
soundness. Each backend then emits idiomatic output for its platform.
Generics, traits, async, and effects lower to the natural construct on
each target: native traits on Rust, protocols on Swift, interfaces on
Kotlin, and monomorphization on WGSL.

The CLI ([call](./deck/call)) drives the whole pipeline and ships a dev
server with hot module reload. The language server ([flow](./deck/flow))
reuses the same analysis for diagnostics, hover, and go-to-definition.

## Developing Term

Working on Term itself takes Node, pnpm, Rust, Swift, a JDK, Kotlin, Maven and, for the mobile suites, the Android
SDK and the iOS simulator. One command checks them all on macOS, Linux or Windows, and installs what is missing with
`--commit`:

```
sh task/dev/bootstrap/start.sh check
sh task/dev/bootstrap/start.sh install --commit
powershell -ExecutionPolicy Bypass -File task\dev\bootstrap\start.ps1 check
```

## Getting Started

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

## License

MIT

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe.
