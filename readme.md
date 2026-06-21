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
  A Reactive Language Φ
</p>

<br/>
<br/>
<br/>

## Why

Every platform has its own language, its own build tools, its own
ecosystem. Writing an app that runs on servers, browsers, iOS, and
Android means learning four toolchains, maintaining four codebases, and
watching them drift apart. The logic is the same. The plumbing is not.

Seed is a programming framework built on top of the
[tree](https://github.com/cluesurf/tree) syntax. It compiles `.tree`
source code into native, idiomatic output for multiple platforms. You
write your logic once in a clean, indentation-based syntax. The compiler
produces Rust, TypeScript, Kotlin, Swift, or HVM, each looking like it
was written by hand for that target.

Seed is not a runtime or a virtual machine. It generates real native
code that integrates with each platform's existing tools, libraries, and
package managers.

## Packages

This repository is a monorepo. Each part of the ecosystem is a deck (a
package) under `deck/`, and the decks reference each other by name
(`@cluesurf/<deck>/code/...`), linked locally through `seed link`.

| Deck                | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| [make](./deck/make) | The compiler: parse, mill, resolve, check, emit           |
| [call](./deck/call) | The CLI: `seed make`, `seed test`, `seed serve`, and more |
| [flow](./deck/flow) | The language server (LSP over stdio)                      |
| [deck](./deck/deck) | The package manager: install, link, lockfile, store       |
| [base](./deck/base) | The standard library, written in `.tree`                  |
| [site](./deck/site) | App framework: reactive zones, DOM, render runtime        |
| [term](./deck/term) | The 4-letter term vocabulary that backs the DSLs          |

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
task greet
  take name, like text
  back call join
    bind a, mark <Hello, >
    bind b, read name

task main
  save message
    call greet
      bind name, mark <world>
  call print
    bind text, read message
```

Compiles to:

**Rust**

```rust
fn greet(name: String) -> String {
    format!("Hello, {}", name)
}
```

**TypeScript**

```typescript
export function greet(name) {
  return `Hello, ${name}`
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
