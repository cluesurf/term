# Types

Every type in Term is written with `like`. The same head names a return type, annotates a field, annotates a parameter, and passes a type argument. There is no separate type syntax to learn. Types are just forms (see [structures](structures.md)), so a type name is always the name of a `form`.

Maps to: type annotations plus generics and trait bounds in Rust / Swift / TypeScript.

## Cheatsheet

| Write | Means |
| --- | --- |
| `like number` | a number |
| `like text` | a string |
| `like boolean` | a boolean (`wave true` / `wave false`) |
| `like nat` | a natural number (`0, 1, 2, ...`), used for indices and proofs |
| `like void` | the unit type, no useful value |
| `like user` | the form named `user` (any form name works) |
| `head t` | declare a type parameter named `t` (generic) |
| `like t` | use a type parameter as a type |
| `like list` + `like text` child | a generic type applied to an argument (`list` of `text`) |
| `head t, need comparable` | a type parameter bounded by a trait |
| `like task` + `take`/`like` children | a function type (closure type) |
| `head n, like nat` | an index parameter for an indexed family |

The scalar vocabulary is `number`, `text`, `boolean`, `nat`, `void`. Do not write `u64`, `f64`, `i32`, or similar. Use `number`.

## Scalar annotations

A `like` line names the type. It appears as a field type, a parameter type, or a return type.

```tree
form account
  link name, like text
  link balance, like number
  link active, like boolean

task rename
  take self
  take name, like text
  like void
  call write-line, read name
```

`number` covers integers and reals. `text` is a string. `boolean` is `wave true` or `wave false`. `void` is the unit, returned by a task that does work but yields nothing useful. `nat` is a natural number used where a value must be a non-negative whole count, including index positions and the math pages.

```tree
task count-down
  take n, like nat
  like void
  call write-line, read n
```

## Type parameters (generics)

Declare a generic with `head`. The name then works anywhere a type does, written `like t`.

```tree
task identity
  head t
  take value, like t
  like t
  send back, read value
```

A form is generic the same way. `box` holds any one type:

```tree
form box
  head t
  link value, like t
```

Declare more than one type parameter by repeating `head`:

```tree
form pair
  head a
  head b
  link first, like a
  link second, like b
```

## Passing type arguments

When a type is itself generic, supply its argument as an indented `like` child. `like list` with a `like text` child is a list of text.

```tree
form roster
  link names
    like list
      like text
  link scores
    like list
      like number
```

A `maybe` of `number`:

```tree
link result
  like maybe
    like number
```

Inline, the same annotation reads `like list, like text`. Use the nested form when the argument has its own children.

## Trait bounds (`need`)

A type parameter can require a trait with `need`. The parameter then only accepts types that implement that trait, and the body may use the trait's methods.

```tree
form sorted-list
  head t, need comparable
  link items
    like list
      like t
```

```tree
task largest
  head t, need comparable
  take items
    like list
      like t
  like t
  send back, call items/max
```

Traits are defined with `mask`. See [traits](traits.md) for how a trait like `comparable` is declared and implemented.

## Function types (`like task`)

A function type is `like task` with the parameters and result of the function it describes. Each expected argument is a `take` child. The result is a `like` child. This is what you write when a parameter or field holds a callback.

```tree
task on-each
  head t
  take items
    like list
      like t
  take visit
    like task
      take value, like t
      like void
  like void
  walk list, read items
    hook next
      take site, name item
      call visit, read item
```

The `visit` parameter is any task that takes one `t` and returns nothing. See [functions](functions.md) for calling a function-typed parameter.

## Indexed types (`head n, like nat`)

An index is a `head` parameter that ranges over values rather than types. The common case is a length index typed `like nat`, which lets a type carry a size. This is how a fixed-length vector states its length in its type.

```tree
form vector
  head t
  head n, like nat
  link items
    like list
      like t
```

```tree
task head-of
  head t
  head n, like nat
  take self
    like vector
  like t
  send back, call self/first
```

Indexed families are mostly used by the math pages to prove size-respecting laws. See [math/datatypes](../math/datatypes.md). For everyday code, the type parameters above and the trait bounds are what you reach for.

See [structures](structures.md) for defining the forms these annotations refer to, and [functions](functions.md) for tasks that use them.
