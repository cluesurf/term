# The Term Book

A practical, example-first guide to the Term language. Every page is a distilled cheatsheet: a short description of a feature, how it maps to ideas you already know, and the `.tree` you write to use it.

Term source is written in `.tree` files. The syntax is indentation-based and uniform: everything is a **head word** with an optional inline value and indented children. There are no braces, and a small vocabulary of mostly four-letter keywords (`task`, `form`, `call`, `read`, `walk`, ...). Once you learn the shape, the whole language reads the same way. You build and run it with the `term` CLI.

## How to read this book

Start with **[the syntax model](language/readme.md)**. It is the one page that makes every other page legible. Then dip into whatever you need.

### language/ -- the core language

The core of the language. If you want to know how to write *anything*, it is here.

- [readme](language/readme.md) -- the `.tree` syntax model: heads, values, children
- [primitives](language/primitives.md) -- literals and the built-in scalar types
- [variables](language/variables.md) -- `save`, `host`, `read`, `loan`
- [functions](language/functions.md) -- `task`, `take`, `like`, `send back`
- [types](language/types.md) -- annotations, generics, trait bounds, function types
- [structures](language/structures.md) -- `form`: records, enums, aliases, generics
- [matching](language/matching.md) -- `fork case`: destructuring sum types
- [conditionals](language/conditionals.md) -- `fork test`: if / else-if / else
- [loops](language/loops.md) -- `walk`: lists, ranges, while
- [collections](language/collections.md) -- lists, maps, sets and their operations
- [errors](language/errors.md) -- `halt <form>`, `halt kink`, `note unsafe`: raising, passing on, catching
- [traits](language/traits.md) -- `mask`: shared behavior across types
- [templates](language/templates.md) -- `tree` / `fuse`: compile-time code generation
- [modules](language/modules.md) -- `load` / `find`: imports, packages, visibility
- [operators](language/operators.md) -- arithmetic, comparison, and `link` chaining
- [async](language/async.md) -- `note async`, `wait`
- [native](language/native.md) -- `dock`: calling host APIs, per-platform code
- [constants](language/constants.md) -- `host` and compile-time values
- [conventions](language/conventions.md) -- naming, casing, file layout
- [tests](language/tests.md) -- writing tests and checks
- [debugging](language/debugging.md) -- logging, diagnostics, lint

### math/ -- proofs and logic

Term's type system can prove things. These pages show how to state and discharge a claim.

- [readme](math/readme.md) -- `rule` / `show hold`: proving with `calm`, `fold`, `cite`, `auto`
- [induction](math/induction.md) -- proving universal laws by structural induction
- [datatypes](math/datatypes.md) -- inductive families, equality, higher types

### cli/ -- command-line apps

- [readme](cli/readme.md) -- building a CLI with the `hook` DSL

### web/ -- the app framework

Building full applications: server, client, routing, data.

- [readme](web/readme.md) -- app structure and the request lifecycle
- [routes](web/routes.md), [components](web/components.md), [state](web/state.md), [forms](web/forms.md), [auth](web/auth.md), [fetch](web/fetch.md), [channels](web/channels.md), [navigation](web/navigation.md)

### stdlib/ -- the standard library

Common tasks with the bundled library.

- [readme](stdlib/readme.md) -- what ships in the box
- [datetime](stdlib/datetime.md), [validation](stdlib/validation.md), [serialization](stdlib/serialization.md), [queries](stdlib/queries.md), [formatting](stdlib/formatting.md)

### toolchain/ -- the compiler and CLI

- [readme](toolchain/readme.md) -- `term make`, `term boot`, `term scan`, watch mode, backends

## The one-minute orientation

```tree
# a function: take inputs, name a return type, send a value back
task greet
  take name, like text
  like text
  send back
    call join
      text <hello, >
      read name

# a data type with two shapes (a sum type / enum)
form shape
  case circle
    link radius, like number
  case square
    link side, like number

# match on it
task area
  take s, like shape
  like number
  fork case, read s
    case circle
      link radius
      send back
        call multiply
          call multiply, read radius, read radius
          code 3
    case square
      link side
      send back
        call multiply, read side, read side
```

If that reads cleanly, you already know how to read Term. The rest of the book fills in the vocabulary.
