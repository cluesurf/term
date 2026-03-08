# Modules

Import code with `load`. Select specific exports with `find`.
Native libraries use `dock`.

## Import a Module (`load`)

Import by package path:

```tree
load @cluesurf/base/code/maybe
```

Import by relative path:

```tree
load ./helpers
load ./types/user
```

## Selective Import (`find`)

Import only specific names:

```tree
load @cluesurf/base/code/list
  find list
  find push
```

With optional type hint:

```tree
load @cluesurf/base/code/list
  find list, like form
  find push, like task
```

With a local alias:

```tree
load @cluesurf/base/code/list
  find push, like task
    name push-list
```

Without `find`, everything from the module is imported.

## Nested Imports

When multiple imports share a common prefix, nest them to reduce
repetition:

```tree
load @cluesurf/term/code/code
  load /head/mine
    find head
  load /like/mine
    find like
  load /take/mine
    find take
```

This is equivalent to writing three separate load statements:

```tree
load @cluesurf/term/code/code/head/mine
  find head
load @cluesurf/term/code/code/like/mine
  find like
load @cluesurf/term/code/code/take/mine
  find take
```

### When to nest

Use nested imports when 3 or more imports share the same prefix.
For 1 or 2 imports from the same prefix, keep them flat. Do not nest
more than 2 levels deep.

### Linting

A linter may eventually enforce consistent style. The rules would be:
- Group imports that share a prefix when there are 3+ of them.
- Keep flat imports for 1-2 from the same prefix.
- Maximum nesting depth of 2.

## Dynamic Export (`bear`)

Export platform-specific implementations:

```tree
bear <./{base/host/dock}>
```

This resolves to different files based on the target platform
(javascript, rust, swift, etc.).

## Native Libraries (`mark native`)

Import native platform libraries with `mark native`:

```tree
load <node:fs>, name fs
  mark native
```

```tree
load <node:path>, name path
  mark native
```

Then call native functions:

```tree
call fs/read-file-sync
  bind path, read path
  bind encoding, text <utf8>
```

The `mark native` tag tells the compiler this is a platform-native
module, not a Seed package. See `packages.md` for more examples.

## Dynamic Loads (`load` in expressions)

Use `load` inside expressions to dynamically import a module path. This
is commonly used in mill definitions to wire up mine and mint grammars:

```tree
mill cookie
  bind mine, load ./mine
  bind mint, load ./mint
```

The `load` here resolves the module at the given path and returns it as
a value. The mill engine uses this to load mine (pattern) and mint
(builder) definitions from separate files.

Another example wiring a mill with multiple grammar components:

```tree
mill task
  bind mine, load ./mine
  bind mint, load ./mint
  bind flow, load ./flow/mine
```

This keeps grammar definitions modular. Each `mine.tree` file defines
patterns, each `mint.tree` file defines builders, and the `mill`
statement wires them together.

## Visibility

`mark private` makes a definition private:

```tree
task helper
  mark private
  send back, mark 0
```

Everything is public by default.
