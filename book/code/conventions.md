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

## Anti-Patterns

- No builder pattern for required fields. Put them in the constructor.
- No stringly-typed options. Use union types.
- No implicit global state. Pass dependencies explicitly.
- No event emitter spaghetti. Use iterables or result types.
- No god objects. A type with 5 functions, not a class with 40 methods.
