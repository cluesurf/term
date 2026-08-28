# The `.tree` syntax model

Term has one syntactic shape, used everywhere. Learn it once and every construct reads the same.

## The shape, in one rule

```
head value, child-head value, child-head value
  child-head value
    grandchild-head value
```

A line is a **head word**, an optional inline **value** after a comma, and zero or more **children** (either indented below, or appended inline after more commas). That is the whole grammar. Keywords are heads. Indentation is structure. There are no braces and no operators.

```tree
task add                  # head `task`, value `add`
  take left, like number  # head `take`, value `left`, child `like number`
  take right, like number
  like number             # head `like`, value `number`
  send back               # head `send back`
    call add              # a child of `send back`
      read left
      read right
```

The last block can be written inline since each comma starts a new child:

```tree
send back, call add, read left, read right
```

Both forms parse to the same tree. Use indentation when nesting is deep, inline commas when it is shallow.

## The keyword cheatsheet

Every head you will meet, grouped by job. Each has its own page.

| Head | Job | Page |
| --- | --- | --- |
| `task` | define a function | [functions](functions.md) |
| `take` | declare a parameter | [functions](functions.md) |
| `like` | a type (return type, annotation) | [types](types.md) |
| `send back` | return a value | [functions](functions.md) |
| `form` | define a data type | [structures](structures.md) |
| `case` | a variant of a sum type | [structures](structures.md), [matching](matching.md) |
| `link` | a field, or bind a matched field | [structures](structures.md) |
| `head` | a type parameter, or an index | [types](types.md), [structures](structures.md) |
| `make` | construct a value | [structures](structures.md) |
| `bind` | set a field during construction | [structures](structures.md) |
| `call` | invoke a function | [operators](operators.md) |
| `read` | read a variable or field | [variables](variables.md) |
| `loan` | borrow a value (read without consuming) | [variables](variables.md) |
| `save` | declare or reassign a mutable local | [variables](variables.md) |
| `host` | declare a constant | [variables](variables.md), [constants](constants.md) |
| `fork test` | if / else-if / else | [conditionals](conditionals.md) |
| `fork case` | match on a sum type | [matching](matching.md) |
| `hook` | a branch (`hook test` / `hook hold` / `hook miss` / `hook next`) | [conditionals](conditionals.md), [loops](loops.md) |
| `walk` | loop (over a list, range, or while a test holds) | [loops](loops.md) |
| `turn next` | continue to the next iteration | [loops](loops.md) |
| `halt` | break out of a loop | [loops](loops.md) |
| `mask` | define a trait | [traits](traits.md) |
| `need` | require a trait bound | [traits](traits.md), [types](types.md) |
| `load` | import a module | [modules](modules.md) |
| `find` | name an import inside a `load` | [modules](modules.md) |
| `dock` | load a native host module | [native](native.md) |
| `tree` | define a template (macro) | [templates](templates.md) |
| `fuse` | instantiate a template | [templates](templates.md) |
| `halt <form>` | raise an exception | [errors](errors.md) |
| `note unsafe` / `halt take` | guard a body and handle what it raises | [errors](errors.md) |
| `slot` | a positional field or parameter | [structures](structures.md), [functions](functions.md) |
| `tell` | what the app says about an exception | [errors](errors.md) |
| `mark` | a modifier (`mark private`) or a rule's universal binder (`mark x, like T`) | [primitives](primitives.md), [math](../math/readme.md) |
| `note` | an annotation on a task or call (`note async`, `note private`) | [functions](functions.md) |
| `text` | a string literal | [primitives](primitives.md) |
| `code` | the number literal, every base, plus `code true` / `code false` | [primitives](primitives.md) |
| `true` / `false` | a boolean literal | [primitives](primitives.md) |
| `rule` | a named proof | [math](../math/readme.md) |
| `show hold` | state a claim to prove inside a `rule` | [math](../math/readme.md) |
| `hold` | a proof obligation / constraint on a task | [math](../math/readme.md) |

Logging is not a keyword. You print with the standard library: `call info` / `call warn` / `call error` from `@cluesurf/seed/code/log` (see [debugging](debugging.md)).

## Literals at a glance

| Literal | Writes | Is |
| --- | --- | --- |
| string | `text <hello>` | text |
| number | `code 42` | a whole number |
| number | `code -7` / `code 1.5` | negative and decimal |
| number | `code 0x1f` / `code 0b1010` / `code 0o17` / `code 0u0041` | hex / binary / octal / unicode |
| boolean | `true` / `false` | a boolean (also `code true` / `code false`) |
| nothing | `void` | the unit / no value |

`code` is the single number literal. It carries every base and sign. A string's content sits between `<` and `>`, so quotes are never needed: `text <it's "fine">`.

## Reading values vs. naming things

A bare word after a head is a **name** (a definition or a label). To use a *value*, you wrap it in a head:

```tree
take name, like text     # `name` and `text` are names
read name                # the VALUE of the variable `name`
make user                # construct the form named `user`
read user/email          # the value of the `email` field, via `/`
```

`/` reaches into a nested name: `read config/host/port`, `call fs/read-file`.

## Comments

```tree
# a full-line comment
task add  # there are no trailing comments after code; keep them on their own line
```

## How this maps to what you know

- A **head with children** is like a function call or a block: the head is the operation, the children are its arguments or body.
- **Indentation is the AST**. Two spaces deeper means "child of the line above." This is the same idea as a YAML tree or a Lisp form, but with words instead of brackets.
- The language is **declarative in shape, imperative in the small**: you describe structure with `form`/`task`/`like`, and write steps with `save`/`fork`/`walk`/`send back`.

## A complete small program

```tree
# greet.tree
load @cluesurf/seed/code/log
  find info

task greet
  take name, like text
  like text
  send back
    call join
      text <hello, >
      read name

# the module body is the program: top-level statements run top to bottom
host who, text <world>
call info
  call greet, read who
```

Read top to bottom: `greet` takes a `name`, returns `text`, and sends back the two strings joined. Then the module body runs. It declares a constant `who` and logs the greeting with `info` (loaded from the standard library). There is no `main` function. The top-level statements are the program. Every other page is this same shape with a different head.
