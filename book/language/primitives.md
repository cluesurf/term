# Primitives

The built-in literals and scalar types. These are the smallest values Term knows about, the leaves at the bottom of every tree. Each literal is a head word with its content as the inline value.

Maps to: primitive literals and scalar types in any language (string, int, bool, unit).

## Cheatsheet

### Literals

| Literal | You write | Is | Example |
| --- | --- | --- | --- |
| string | `text <...>` | a piece of text | `text <hello>` |
| number | `code N` | any number, every base | `code 42` |
| boolean | `true` / `false` | true or false | `true` |
| boolean | `code true` / `code false` | the same boolean, spelled long | `code false` |
| nothing | `void` | the unit, no value | `void` |

`code` is the one number literal. It carries every kind of number: positive, negative, decimal, and the four radix forms.

| You write | Is |
| --- | --- |
| `code 42` | a whole number |
| `code -7` | a negative number |
| `code 1.5` | a decimal (a float) |
| `code 0x1f` | hex (31) |
| `code 0b1010` | binary (10) |
| `code 0o17` | octal (15) |
| `code 0u0041` | a unicode codepoint (the letter `A`) |

There is no separate integer keyword. `code` is the whole literal surface for numbers.

### Scalar types

These are the names you put after `like` to annotate a value.

| Type | You write | Holds | Default value |
| --- | --- | --- | --- |
| text | `like text` | a string | `text <>` |
| number | `like number` | a signed integer (the platform int) | `code 0` |
| nat | `like nat` | a non-negative whole number | `code 0` |
| float | `like float` | a decimal number | `code 0.0` |
| boolean | `like boolean` | a `true` / `false` | `false` |
| void | `like void` | the unit, no value | `void` |

## Strings

A string's content sits between `<` and `>`. No quotes are needed, so apostrophes and double quotes inside the text are free.

```tree
text <hello>
text <hello, world>
text <it's "fine">
```

The empty string is `text <>`.

## Numbers

A number literal is `code` followed by the number. The same keyword covers every base and sign.

```tree
code 0
code 42
code -7
code 1.5
code 0x1f      # hex, 31
code 0b1010    # binary, 10
code 0o17      # octal, 15
code 0u0041    # unicode codepoint, the letter A
```

A whole `code N` has type `number`. Term does not split integers into `u8`, `i32`, `u64`, and so on. You write `like number` and the compiler maps it to each platform's native integer (i64 on Rust, Int on Kotlin, Long where needed). A decimal like `code 1.5` is a `float`. The radix forms (`0x`, `0b`, `0o`, `0u`) are whole numbers written in another base, so they are still `number`.

## Booleans

A boolean value is `true` or `false`. You can also spell them `code true` and `code false`, which mean exactly the same thing.

```tree
true
false
code true
code false
```

The boolean type is `like boolean`. In a condition you pass the boolean value straight through, you do not compare it to `true`:

```tree
fork test
  hook test, read flag
  hook hold, send back, text <on>
  hook miss, send back, text <off>
```

Inside the `boolean` form itself the two shapes are `case true` and `case false`. That is the definition. As a value you always write `true` / `false`. See [structures](structures.md) for the form, [operators](operators.md) for `and` / `or` / `not`.

## Void

`void` is the unit value. It means "no meaningful value here." A task that returns nothing declares `like void`.

```tree
task log-line
  take line, like text
  like void
  call write-line, read line
```

`void` is distinct from a missing optional value. For an absent value in typed code, use `maybe` and `make none` instead of `void`. See [collections](collections.md).

## Putting them together

A small task using each primitive type. It takes a name and a count, returns text, and shows a flag along the way.

```tree
task report
  take name, like text
  take count, like number
  like text
  host loud, true
  fork test
    hook test, read loud
    hook hold, call write-line, text <reporting>
  send back
    call join
      read name
      text < x >
      read count

# the module body runs: no main task
call write-line
  call report
    text <widget>
    code 7
```

`name` is `text`, `count` is `number`, `loud` is `boolean`, the bracketed strings are `text` literals, and `code 7` is an integer. See [variables](variables.md) for `save` and `host`, and [functions](functions.md) for `task` and `send back`.
