# Structures

`form` defines a data type. One head covers three shapes you already know: a plain record (a struct), a sum type (an enum), and an alias. A form can carry type parameters, hold methods, and gate fields with visibility marks. You build a value with `make` and set its fields with `bind`.

Maps to: structs, enums, and classes in Rust / Swift / TypeScript.

## Cheatsheet

| Write | Means |
| --- | --- |
| `form name` + `link` fields only | a record (struct) |
| `form name` + `case` variants | a sum type (enum) |
| `case v` + `link` fields | a variant that carries data |
| `form x` then `like other` | an alias for an existing type |
| `form x` then `like other` + children | an extension: `head a, like T` names a type argument, `bind f, v` pins a field, `link p, like T` adds a prop |
| `slot f, like T` | a positional field, filled by order at a `make` |
| `link f, like T, fall v` | a field with a default |
| `link f, like T, need false` | an optional field |
| `head t` | a type parameter on the form |
| `head t, need bound` | a type parameter with a trait bound |
| `take self` | the receiver inside a method |
| `task ...` inside a form | a method on the form |
| `note private` under a `link` | a private field |
| `make name` + `bind field, v` | construct a value |
| `make name` + values | construct a value with `slot` fields, by position |
| `make none` | construct a no-field variant |

A form name is also a type name. See [types](types.md) for how it is used in annotations.

## Records (product types)

A form whose body is only `link` fields is a plain record. Each `link` is a field with a `like` type.

```tree
form user
  link name, like text
  link email, like text
  link age, like number
```

Construct one with `make` and set every field with `bind`:

```tree
save alice
  make user
    bind name, text <alice>
    bind email, text <alice@site.com>
    bind age, code 30
```

Read a field with the `/` member form: `read alice/email`.

## Enums (sum types)

List the shapes with `case`. A variant with no `link` is a bare tag. A variant with `link` fields carries data.

```tree
form shape
  case circle
    link radius, like number
  case square
    link side, like number
  case point
```

`circle` and `square` carry a number. `point` carries nothing. Construct each with `make`:

```tree
save a
  make circle
    bind radius, code 4

save b, make point
```

A bare enum is just tags, like the stdlib `ordering`:

```tree
form ordering
  case less
  case equal
  case greater
```

You read an enum value back apart with `fork case`. See [matching](matching.md).

## Aliases

A `form` whose body is a single `like` is an alias. It gives a new name to an existing type.

```tree
form user-id
  like number

form name-list
  like list
    like text
```

## Generic forms

Add type parameters with `head`. They work as field types via `like t`.

```tree
form box
  head t
  link value, like t
```

Repeat `head` for several parameters:

```tree
form pair
  head a
  head b
  link first, like a
  link second, like b
```

Bound a parameter with `need` so the form only accepts types with that trait:

```tree
form set
  head t, need hashable
  link items
    like list
      like t
```

See [types](types.md) for `need` bounds and [traits](traits.md) for declaring the trait.

## Methods and `self`

A `task` inside a form is a method. Its first parameter `self` is the receiver. Read fields with `read self/field`, and return a fresh value rather than mutating in place.

```tree
form pair
  head a
  head b
  link first, like a
  link second, like b

  task get-first
    take self
    like a
    send back, read self/first

  task swap
    take self
    like pair
    send back
      make pair
        bind first, read self/second
        bind second, read self/first
```

Methods can carry their own extra type parameters with `head`, declared before `take self`:

```tree
task map-first
  head c
  take self
  take change
    like task
      take value, like a
      like c
  like pair
  send back
    make pair
      bind first, call change, read self/first
      bind second, read self/second
```

## Visibility

`note private` under a `link` hides that field from other modules. Public methods can still read it.

```tree
form account
  link name, like text
  link secret, like text
    note private
```

## Extending a form

`like` with children makes a form that extends another. `head <param>` names a type argument (a `like` inline, or `link` lines for an anonymous record), `bind` pins a field to one value, and `link` adds a prop. Exceptions are the first user, see [errors](errors.md).

```tree
form foo
  head a
  head b
  link note, like text
  link left, like a
  link right, like b

form example
  like foo
    head a
      link x, like text
    head b, like number
    bind note, <Example foo>
```

When the base has one type parameter, `link` lines directly under the `like` fill it. A pinned field is refused at a `make`.

## Positional fields

`slot` declares a field that a `make` fills by position, in declaration order. A form with `link` fields only is constructed by name, and giving it bare values is a build error, so reordering fields can never silently change a construction.

```tree
form point
  slot x, like number
  slot y, like number
  link label, like text, fall text <origin>

task origin
  like point
  send back
    make point
      code 0
      code 0
```


## Construction recap

`make name` builds a value. `bind field, value` sets each field. A no-field variant is just `make name`.

```tree
make some
  bind value, read x

make none
```

Nested construction nests `make` under a `bind`:

```tree
make node
  bind left
    make leaf
      bind value, code 1
  bind right
    make leaf
      bind value, code 2
```

When a constructed value is returned, it goes on the line below `send back`, never inline with `bind` children:

```tree
send back
  make some
    bind value, read x
```

See [matching](matching.md) to take these values apart, and [functions](functions.md) for methods in depth.
