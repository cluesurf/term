<br/>
<br/>
<br/>
<br/>
<br/>
<br/>
<br/>

<p align='center'>
  <img src='https://github.com/cluesurf/seed/blob/make/view/seed.png?raw=true' height='256'>
</p>

<h3 align='center'>
  seed
</h3>
<p align='center'>
  A Reactive Language ႎ
</p>

<br/>
<br/>
<br/>

## Why

Every platform has its own language, its own build tools, its own
ecosystem. Writing an app that runs on servers, browsers, iOS, and
Android means learning four toolchains, maintaining four codebases, and
watching them drift apart. The logic is the same. The plumbing is not.

Seed is a programming language and ecosystem that compiles `.tree`
source code into native, idiomatic output for multiple platforms. You
write your logic once in a clean, indentation-based syntax. The
compiler produces Rust, TypeScript, Kotlin, Swift, or HVM, each looking
like it was written by hand for that target.

Seed is not a runtime or a virtual machine. It generates real native
code that integrates with each platform's existing tools, libraries,
and package managers.

## The Ecosystem

### Core

| Package                      | Purpose                            |
| ---------------------------- | ---------------------------------- |
| [seed](.) (this)             | Entrypoint and CLI                 |
| [mesh.tree](../mesh.tree)    | Compiler + runtime                 |
| [deck.tree](../deck.tree)    | Package manager                    |
| [base.tree](../base.tree)    | Standard library                   |
| [case.tree](../case.tree)    | Environment types and native bindings |

### Libraries

| Package                      | Purpose                            |
| ---------------------------- | ---------------------------------- |
| [flow.tree](../flow.tree)    | Graphics, audio, interface logic   |
| [form.tree](../form.tree)    | Math                               |
| [land.tree](../land.tree)    | Infrastructure                     |
| [word.tree](../word.tree)    | Language and linguistics           |
| [code.tree](../code.tree)    | Content grammars (binary and text) |
| [link.tree](../link.tree)    | Third party API connections        |
| [site.tree](../site.tree)    | App level frameworks               |

## How It Works

```
.tree source
    |
    v
mesh.tree (compiler)
    |
    +---> Rust       (servers, CLI, embedded)
    +---> TypeScript  (browsers, Node.js)
    +---> Kotlin      (Android, JVM)
    +---> Swift       (iOS, macOS)
    +---> HVM         (parallel computation)
```

The compiler parses `.tree` files into a surface AST, desugars into
core terms based on the Calculus of Constructions with self-types,
type-checks, and hands off to backend code generators. Each backend
produces idiomatic output for its platform.

For HVM targets, the runtime manages execution through WebAssembly,
marshaling values and interpreting the IO protocol for side effects.

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
    return `Hello, ${name}`;
}
```

## License

Copyright 2021-2026+ <a href='https://clue.surf'>ClueSurf</a>

Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe ¤.
Follow the work on [YouTube](https://youtube.com/@cluesurf),
[X](https://x.com/cluesurf),
[Instagram](https://instagram.com/cluesurf),
[Substack](https://cluesurf.substack.com),
[Facebook](https://facebook.com/cluesurf), and
[LinkedIn](https://linkedin.com/company/cluesurf), and browse more of
our open-source work here on [GitHub](https://github.com/cluesurf).
