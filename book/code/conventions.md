# Conventions

## Naming

- Use short, common English words. `read` not `getContents`. `send`
  not `transmitMessage`. Four letters is ideal.
- Never abbreviate. `make-dir` not `mkdir`. `remove` not `rm`.
- Task names must start with a verb, ideally a single verb.
  `read`, `send`, `cancel`. Never nouns like `interval` or `timeout`.
- Form names should be specific and descriptive.
  `form environment-variable` not `form variable`. Related forms
  should be namespaced to avoid ambiguity. `form command-flag`,
  `form command-argument`.
- Task names do not get prefixed. The module path provides the
  namespace. `task read` inside `file/` is enough.
- No redundant suffixes. `form command`, not `form command-schema`.
  Avoid `-info`, `-data`, `-config`.

## Functions

- One obvious way to do each thing. No overloading, no optional
  parameters that change behavior.
- Nouns are types, verbs are functions. `File` is a type. `read` is a
  function. Always `read(file)`, never `file.read()`.
- Functions with 2+ parameters take a single object input. Return a
  plain value.
- Variants are parameters, not separate functions.
  `seek(file, offset, frame: relative)` not `seek-relative(file, offset)`.
- Public names stay clean (`read`, `write`). Internal `hide true`
  functions handle the dispatch.

## Errors

- Errors are values, not exceptions. Return
  `{ ok: true, data } | { ok: false, error }`.
- Exceptions are for programmer mistakes only.

## IO and Resources

- If it touches IO, it is async. Pure computation is sync.
- Streams are pull-based iterables. No push-based event emitters.
- Resources have explicit lifetimes. Use `open`/`close`. No implicit
  cleanup.

## Modules

- Modules are namespaces. `file/permission#read` not `file#read-mode`.
  The function name stays a simple verb.
- Prefer flat modules over deep nesting. If a sub-module has one
  function, hoist it.
- Do not wrap a platform API just to wrap it. Only abstract when
  unifying across platforms or simplifying a bad interface.

## Design

- Configuration is separate from operation. Create a configured context
  once, pass it to operations.
- Composition over features. Combine small tools rather than building
  big ones.
- Directories are paths, not special types. `list(path)` reads entries.

## Naming Patterns

| Action  | Words                          |
| ------- | ------------------------------ |
| Create  | `open`, `make`, `start`        |
| Destroy | `close`, `stop`, `drop`        |
| Read    | `read`, `load`, `list`, `find` |
| Write   | `write`, `save`, `send`        |
| Convert | `cast`, `turn`, `form`         |
| Check   | `test`, `is`, `has`            |
| Wait    | `wait`, `poll`, `watch`        |

## Cross-Platform Uniformity

- Rust, Swift, Kotlin, and TypeScript implementations must share the
  exact same API surface. Same function names, same parameter shapes,
  same return types. A developer switching platforms should feel at home
  immediately.
- When one platform requires unusual machinery (ownership in Rust,
  coroutine contexts in Kotlin, actor isolation in Swift), absorb that
  complexity inside the implementation. The public interface stays
  identical across all four.
- Design the API around the hardest platform first. If Rust needs a
  certain shape to stay zero-cost, make that shape the universal one
  rather than bolting on a compatibility layer later.
- Never settle for a lowest-common-denominator API. Each backend should
  compile to the optimal idiom for its platform while exposing the same
  contract. Uniform does not mean slow.
- Test parity across platforms. If a function exists on one backend, it
  exists on all four with the same behavior and the same edge cases.

## File Layout

- A module is a single `.tree` file. The file name is the module name.
- Prefer `foo.tree` over `foo/base.tree`. If a module has no
  submodules, it should be a single file, not a directory with
  `base.tree` inside.
- When a module has both its own code and submodules, use both:
  `foo.tree` for the module entry and `foo/bar.tree` for submodules.
  For example, `clock.tree` alongside `clock/measurement.tree` and
  `clock/now.tree`.
- The only `base.tree` that should exist is the package entry point
  at `code/base.tree`.
- Resolution order: the compiler tries `name.tree` first, then
  `name/base.tree` as a legacy fallback.

## base.tree Package Structure

The standard library (`base.tree`) is organized as:

```
code/
  base.tree          # package entry point
  boolean.tree       # types (forms)
  integer.tree       # types with subtypes
  integer/           # integer subtypes
    unsigned.tree
    unsigned/8.tree
    unsigned/16.tree
    ...
  mask/              # traits (masks)
    addition.tree
    comparison.tree
    ...
  native/            # platform implementations
    node/            # Node.js implementations
    rust/            # Rust implementations
    kotlin/          # Kotlin implementations
    swift/           # Swift implementations
    shared/          # cross-platform algorithms
  hold/              # internal utilities
  mill/              # parser grammars
```

- Types go directly in `code/` (e.g. `code/boolean.tree`).
- Traits go in `code/mask/`.
- Platform-specific implementations go in `code/native/<platform>/`.
- Shared algorithms go in `code/native/shared/`.

## Ordering Principles

There is no strict ordering requirement on children within a term.
The parser uses `mine case` (any-order matching) to allow flexibility.
However, follow these conventions for readability.

### General Rule

Configuration and metadata come first. Dynamic content comes second.
Within each group, order does not matter.

### Task Definitions

```tree
task get-foo
  hide true          # config: visibility
  wait true          # config: async marker
  firm true          # config: totality marker

  head A, head B     # type parameters

  take a, like text  # parameters
  take b, like mark

  like text          # return type

  call do-thing      # body (dynamic)
    read a
```

Group order:
1. Config flags (`hide`, `wait`, `risk`, `firm`, `note`)
2. Type parameters (`head`)
3. Parameters (`take`)
4. Return type (`like`)
5. Body statements (`call`, `save`, `fork`, `walk`, `send back`)

### Call Expressions

```tree
call some-function
  wait true          # config: async
  risk true          # config: unsafe

  bind x, read a     # arguments
  bind y, read b
```

Group order:
1. Config flags (`wait`, `risk`)
2. Arguments (`bind`, `read`, `save`)

### Form Definitions

```tree
form user
  hide true          # config: visibility
  firm true          # config: totality

  head T             # type parameters

  like base-form     # alias/extends

  link name, like text   # fields
  link age, like mark

  case admin         # variants
    link role

  task greet         # methods
    like text
```

Group order:
1. Config flags (`hide`, `firm`, `note`)
2. Type parameters (`head`)
3. Type alias (`like`)
4. Fields (`link`)
5. Variants (`case`)
6. Methods (`task`)
7. Constraints (`hold`, `rein`)

### DSL Role Files

For DSL roles (deck, host, base, etc.), put metadata first:

```tree
deck @cluesurf/base
  mark <0.3.1>       # metadata
  head <Description>
  lock apache-2
  sort tool
  hide true

  mind <Author>      # people

  link foo, mark <1>  # dependencies

  case work           # dev dependencies
    link bar

  task ./task         # directory pointers
  book ./book
```

### Parser Support

The parser does not enforce ordering. `mine case` matches children
in any order with at-most-one-each semantics. `mine need` inside
`mine case` marks required children. Linters and formatters may
reorder children to match conventions, but the parser accepts any
valid ordering.

## Imports

When multiple imports share a common prefix, nest them:

```tree
load @cluesurf/term/code/code
  load /head/mine
    find head
  load /like/mine
    find like
```

Use nested imports when 3+ imports share a prefix. Do not nest more
than 2 levels deep. For 1-2 imports from the same prefix, keep them
flat. A linter may eventually enforce consistent style.

## Anti-Patterns

- No builder pattern for required fields. Put them in the constructor.
- No stringly-typed options. Use union types.
- No implicit global state. Pass dependencies explicitly.
- No event emitter spaghetti. Use iterables or result types.
- No god objects. A type with 5 functions, not a class with 40 methods.
