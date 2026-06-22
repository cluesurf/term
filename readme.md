<br/>
<br/>
<br/>
<br/>
<br/>
<br/>
<br/>

<p align='center'>
  <img src='https://github.com/cluesurf/seed/blob/make/view/seed3.png?raw=true' height='192'>
</p>

<h3 align='center'>
  seed
</h3>
<p align='center'>
  A Reactive Language Φ<br/>
  (WIP)
</p>

<br/>
<br/>
<br/>

## Introduction

Every platform has its own language, its own build tools, its own
ecosystem. Writing an app that runs on servers, browsers, iOS, and
Android means learning four toolchains, maintaining four codebases, and
watching them drift apart. The logic is the same. The plumbing is not.

Seed is a programming framework built on a simple, indentation-based
syntax (the [tree](https://github.com/cluesurf/tree) format). You write
the logic once, and one source compiles to idiomatic Rust, TypeScript,
Kotlin, and Swift, so the same program runs in the browser, on Node, on
native servers, and on iOS and Android. It is dependently typed with a
rich type system, ships with a full toolchain (compiler, package
manager, and language server), and is designed so the compiler can reach
near-optimal native code on each target without the author giving up a
clean, readable surface.

Dart, through Flutter, has a comparable multi-platform reach but
different goals: Seed emits each platform's native idioms rather than
shipping one runtime, and puts a formal type system and proof checker at
the center. Kind is the closer relative on that side, a dependently
typed language with a small core, while Seed aims more squarely at
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

## Packages

This repository is a monorepo. Each part of the ecosystem is a deck (a
package) under `deck/`, and the decks reference each other by name
(`@cluesurf/<deck>/code/...`), linked locally through `seed link`.

| Deck                                                      | Purpose                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`@cluesurf/make`](./deck/make)                           | The compiler: parse, mill, resolve, check, emit                                           |
| [`@cluesurf/call`](./deck/call)                           | The CLI: `seed make`, `seed test`, `seed serve`, and more                                 |
| [`@cluesurf/flow`](./deck/flow)                           | The language server (LSP over stdio)                                                      |
| [`@cluesurf/deck`](./deck/deck)                           | The package manager: install, link, lockfile, store                                       |
| [`@cluesurf/base`](./deck/base)                           | The standard library, written in `.tree`                                                  |
| [`@cluesurf/site`](./deck/site)                           | App framework: reactive zones, DOM, render runtime                                        |
| [`@cluesurf/term`](./deck/term)                           | The 4-letter term vocabulary that backs the DSLs                                          |
| [`@cluesurf/form`](https://github.com/cluesurf/form.tree) | Math and physics as kernel-proven `.tree` proofs (algebra, quantum, geometry, relativity) |

The compiler, CLI, and language server are written in TypeScript (under
each deck's `code/`). The standard library, site framework, and terms
are written in `.tree` and compiled by the compiler itself.

## How It Works

```
.tree source
    ↓
make (compiler): parse → resolve → check → emit
    ├─→ TypeScript  (browsers, Node.js)
    ├─→ Rust        (servers, CLI, embedded)
    ├─→ Kotlin      (Android, JVM)
    ├─→ Swift       (iOS, macOS)
    ├─→ LLVM        (native binaries)
    └─→ WGSL        (GPU shaders)
```

The compiler parses `.tree` files into a surface AST, mills them into a
typed AST, resolves names, and type-checks through a gradual,
bidirectional inference pass that elaborates into a dependent kernel for
soundness. Each backend then emits idiomatic output for its platform.
Generics, traits, async, and effects lower to the natural construct on
each target: native traits on Rust, protocols on Swift, interfaces on
Kotlin, and monomorphization on LLVM and WGSL.

The CLI ([call](./deck/call)) drives the whole pipeline and ships a dev
server with hot module reload. The language server ([flow](./deck/flow))
reuses the same analysis for diagnostics, hover, and go-to-definition.

## Installation

```
pnpm add @cluesurf/seed -g
```

## Getting Started

```bash
# Compile a project
seed make

# Run in dev mode (watch + hot reload)
seed flow

# Add a package
seed deck save <package>

# Run tests
seed test
```

## Example

```
task double
  take value, like number
  like number
  send back
    call add
      read value
      read value
```

Compiles to:

**Rust**

```rust
fn double(value: i64) -> i64 {
    return value + value;
}
```

**TypeScript**

```typescript
export function double(value: number): number {
  return value + value
}
```

## License

MIT

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe ¤.
Follow the work on [YouTube](https://youtube.com/@cluesurf),
[X](https://x.com/cluesurf),
[Instagram](https://instagram.com/cluesurf),
[Substack](https://cluesurf.substack.com),
[Facebook](https://facebook.com/cluesurf), and
[LinkedIn](https://linkedin.com/company/cluesurf), and browse more of
our open-source work here on [GitHub](https://github.com/cluesurf).
