# Matching

`fork case` takes a sum type apart. You name the value to inspect, list one `case` per variant, bind any fields the variant carries, and write the body for that branch. Every variant must be covered. This is the reader for the enums you build with `form` (see [structures](structures.md)).

Maps to: `match` in Rust, `switch` over a discriminated union in TypeScript, pattern matching in Swift.

## Cheatsheet

| Write | Means |
| --- | --- |
| `fork case, read x` | match on the value `x` |
| `case variant` | a branch for that variant |
| `link field` (under a `case`) | bind the variant's field by name in this branch |
| `read self/field` | the same field via member access, no `link` needed |
| `case else` | the default branch, matches anything not listed |
| body lines under a `case` | what runs for that branch |
| nested `fork case` | match again inside a branch |

Rules:
- `fork case` uses `case` children. It never uses `hook`. (`hook` belongs to `fork test`, see [conditionals](conditionals.md).)
- A `fork case` must cover every variant, or end with `case else`. The compiler rejects a non-exhaustive match.
- A `fork case` can produce a value: each branch ends in `send back`.

## Matching a bare enum

List a `case` for each tag. With no fields, the body follows directly.

```tree
task name-of
  take side, like ordering
  like text
  fork case, read side
    case less
      send back, text <less>
    case equal
      send back, text <equal>
    case greater
      send back, text <greater>
```

`ordering` has exactly three variants, so all three are covered and the match is exhaustive.

## Binding carried fields

A variant with `link` fields carries data. Read that data two ways.

The member form reads the field off the value directly:

```tree
task radius-or-zero
  take s, like shape
  like number
  fork case, read s
    case circle
      send back, read s/radius
    case square
      send back, code 0
    case point
      send back, code 0
```

The `link` form binds the field to a local name inside the branch, so you write `read radius` instead of `read s/radius`:

```tree
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
      send back, call multiply, read side, read side
    case point
      send back, code 0
```

Both styles are valid. Use `link` when binding reads cleaner. Use `read s/field` when you want to be explicit about the source.

## Matching with a returned value

Each branch ends in `send back`, so the whole `fork case` computes the function's result. This is the stdlib pattern for `maybe`:

```tree
task unwrap-or
  take self
  take fallback, like t
  like t
  fork case, read self
    case some
      send back, read self/value
    case none
      send back, read fallback
```

`some` carries a `value`, `none` carries nothing. Both branches return a `t`, so the result type lines up.

## The default branch (`case else`)

When you do not want to spell out every variant, end with `case else`. It matches anything not named above.

```tree
task is-red
  take c, like color
  like boolean
  fork case, read c
    case red
      send back, true
    case else
      send back, false
```

Only use `case else` when the remaining variants genuinely share one outcome. Listing each variant keeps the match honest when the type later grows a new case.

## Nested matching

A branch body can hold another `fork case`. This walks a recursive type one layer at a time.

```tree
task small-fib
  take n, like nat
  like number
  fork case, read n
    case zero
      send back, code 0
    case succ
      link pred
      fork case, read pred
        case zero
          send back, code 1
        case succ
          link prev
          send back
            call add
              call small-fib, read pred
              call small-fib, read prev
```

The outer match splits `zero` from `succ`. Inside the `succ` branch, a second match splits the predecessor again. Each `link` binds the field of its own `case`.

## Exhaustiveness

A `fork case` must account for every variant of the type. Leaving one out is a compile error, not a silent fall-through. This is why a `maybe` match always handles both `some` and `none`, and why a three-way `ordering` match handles `less`, `equal`, and `greater`. Add `case else` only when a catch-all is the intent.

See [structures](structures.md) for defining the sum types you match on, and [conditionals](conditionals.md) for `fork test`, the boolean sibling of `fork case`.
