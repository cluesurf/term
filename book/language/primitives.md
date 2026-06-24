# Primitives

The built-in literals and scalar types. These are the smallest values Term knows about, the leaves at the bottom of every tree. Each literal is a head word with its content as the inline value.

Maps to: primitive literals and scalar types in any language (string, int, bool, unit).

## Cheatsheet

### Literals

| Literal | You write | Is | Example |
| --- | --- | --- | --- |
| string | `text <...>` | a piece of text | `text <hello>` |
| integer | `mark N` | a whole number | `mark 42` |
| boolean | `wave true` / `wave false` | true or false | `wave true` |
| raw number | `code N` | a bare numeric code | `code 0` |
| nothing | `void` | the unit, no value | `void` |

### Scalar types

These are the names you put after `like` to annotate a value.

| Type | You write | Holds | Default value |
| --- | --- | --- | --- |
| text | `like text` | a string | `text <>` |
| number | `like number` | a signed integer (the platform int) | `mark 0` |
| nat | `like nat` | a non-negative whole number | `mark 0` |
| boolean | `like boolean` | a `wave true` / `wave false` | `wave false` |
| void | `like void` | the unit, no value | `void` |

### The two kinds of number literal

| You write | Use it for |
| --- | --- |
| `mark N` | an ordinary integer value in your program (counts, ids, amounts) |
| `code N` | a bare numeric code where a tag, index, or count is wanted (loop bounds, raw positions) |

Both produce a whole number. `mark` reads as "an integer value," `code` reads as "a raw count or position." The stdlib uses `code 0` and `code 1` for loop starts and seeds, and `mark N` for ordinary values.

## Strings

A string's content sits between `<` and `>`. No quotes are needed, so apostrophes and double quotes inside the text are free.

```tree
text <hello>
text <hello, world>
text <it's "fine">
```

The empty string is `text <>`.

## Integers

An integer literal is `mark` followed by the number.

```tree
mark 0
mark 42
mark 1000
```

A bare count or position is `code`:

```tree
code 0
code 1
```

Both are whole numbers of type `number`. There is one integer type. Term does not split numbers into `u8`, `i32`, `u64`, and so on. You write `like number` and the compiler maps it to each platform's native integer (i64 on Rust, Int on Kotlin, Long where needed).

## Booleans

A boolean value is `wave true` or `wave false`.

```tree
wave true
wave false
```

The boolean type is `like boolean`. In a condition you pass the boolean value straight through, you do not compare it to `wave true`:

```tree
fork test
  hook test, read flag
  hook hold, send back, text <on>
  hook miss, send back, text <off>
```

Inside the `boolean` form itself the two shapes are `case true` and `case false`. That is the definition. As a value you always write `wave true` / `wave false`. See [structures](structures.md) for the form, [operators](operators.md) for `and` / `or` / `not`.

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
  host loud, wave true
  fork test
    hook test, read loud
    hook hold, show, text <reporting>
  send back
    call join
      read name
      text < x >
      read count

task main
  like number
  call write-line
    call report
      text <widget>
      mark 7
  send back, code 0
```

`name` is `text`, `count` is `number`, `loud` is `boolean`, the bracketed strings are `text` literals, `mark 7` is an integer, and `code 0` is the raw exit code. See [variables](variables.md) for `save` and `host`, and [functions](functions.md) for `task` and `send back`.
