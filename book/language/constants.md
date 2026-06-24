# Constants

A constant is a named value that never changes. You declare one with `host`. The compiler treats `host` values as fixed, folds them at compile time where it can, and rejects any attempt to reassign one.

Maps to: `const` / `static` / `final`, and compile-time constant folding.

## Cheatsheet

| Head | Job | Example |
| --- | --- | --- |
| `host x, <value>` | declare a constant (write-once) | `host limit, code 100` |
| `host x` + indented value | a constant whose value spans children | a constant built from a `call` or `make` |
| `read x` | use a constant's value | `read limit` |
| `read x/field` | reach into a constant's field | `read color/red` |

Rules at a glance:

- `host` is write-once. A second `save` or `host` on the same name is an error.
- `host` works at module level (top of file) and inside any task body.
- A `host` whose value is a literal or a fold of literals is computed at compile time.
- Use `host` for fixed values. Use `save` for anything that changes. See [variables](variables.md).

## `host` versus `save`

The choice is about whether the value ever changes.

| Use | When |
| --- | --- |
| `host` | the value is fixed for its whole lifetime (limits, names, flags, lookup tables) |
| `save` | the value is reassigned later (counters, accumulators, running state) |

```tree
host max-retries, code 3      # never changes
save attempts, code 0         # incremented over time
```

Reach for `host` by default. Promote to `save` only when you actually reassign. A `host` documents intent: a reader knows the value is stable, and the compiler enforces it.

```tree
task connect
  like void
  host max-retries, code 3
  save attempts, code 0
  walk test
    hook test
      call is-below, read attempts, read max-retries
    hook hold
      save attempts
        call add, read attempts, code 1
```

`max-retries` is fixed, so it is `host`. `attempts` grows, so it is `save`.

## Module-level constants

A `host` at the top of a file, outside any task, is a module constant. It is visible to every task in the file and can be exported and imported like any other name.

```tree
# limits.tree
host page-size, code 50
host app-name, text <term>
host debug, false
```

Any task in the file uses them with `read`:

```tree
task first-page-end
  like number
  send back
    read page-size
```

Import them from another file the same way you import a task. See [modules](modules.md).

```tree
load @cluesurf/app/code/limits
  find page-size
```

## Grouping related constants

A constant can hold a constructed value, so a record groups related fields under one name. Put the value on the next indented line.

```tree
host palette
  make color-set
    bind red, text <#e23>
    bind green, text <#2c5>
    bind blue, text <#36e>
```

Read a field with `/`:

```tree
read palette/red
read palette/blue
```

See [structures](structures.md) for `make` and `bind`.

## Compile-time folding

When a `host` value is a literal, or an expression over other literals and constants, the compiler computes it once at compile time. The folded value is baked into the output, so there is no runtime work to produce it.

```tree
host seconds-per-day
  call multiply
    call multiply, code 24, code 60
    code 60
```

`24 * 60 * 60` is folded to `86400` at compile time. Every `read seconds-per-day` uses the precomputed value. Folding only applies when every input is itself constant. A `host` built from a non-constant call (a value read at runtime, a function with effects) still runs at runtime, but the binding is still write-once. The guarantee `host` gives is immutability. The folding is an optimization the compiler applies when it safely can.

```tree
host start-time
  call clock/now
```

`start-time` is computed once when the program reaches the binding, then never changes. It is a constant in the write-once sense, even though its value is not known at compile time.
