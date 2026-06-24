# Conditionals

Branching on a condition uses `fork test`. Inside it, `hook` heads spell out the parts: a test, the branch to run when it holds, and an optional else. Chain several test/hold pairs for else-if. This is the boolean cousin of `fork case`, which matches on a sum type. See [matching](matching.md) for that.

Maps to: `if` / `else if` / `else`.

## Cheatsheet

| Head | Job |
| --- | --- |
| `fork test` | start an if / else-if / else block |
| `hook test, <cond>` | a condition (a `boolean` value) |
| `hook hold, <then>` | the branch to run when the matching `hook test` holds |
| `hook miss, <else>` | the branch to run when no test held (optional) |

Shape rules:

- Each `hook test` is paired with the `hook hold` directly below it.
- Repeat `hook test` / `hook hold` pairs for an else-if chain.
- `hook miss` is the final fallback. Omit it when there is no else.
- A `hook test` value is any `boolean`: a comparison, a boolean variable, or an `and` / `or` / `not` call.

## The basic shape

One test, one then, one else.

```tree
task sign-label
  take n, like number
  like text
  fork test
    hook test
      call is-below, read n, code 0
    hook hold
      send back, text <negative>
    hook miss
      send back, text <non-negative>
```

`hook test` carries the condition. `hook hold` runs when it holds. `hook miss` runs otherwise.

## Else-if chains

Add more `hook test` / `hook hold` pairs. They are tried in order, top to bottom. The first test that holds wins, and the rest are skipped. A final `hook miss` covers the case where none held.

```tree
task grade
  take score, like number
  like text
  fork test
    hook test
      call is-minimum, read score, mark 90
    hook hold
      send back, text <A>
    hook test
      call is-minimum, read score, mark 80
    hook hold
      send back, text <B>
    hook test
      call is-minimum, read score, mark 70
    hook hold
      send back, text <C>
    hook miss
      send back, text <F>
```

This reads as: if `>= 90` then A, else if `>= 80` then B, else if `>= 70` then C, else F.

## Without an else

`hook miss` is optional. Drop it when there is nothing to do in the else case. Here a `save`d flag is only flipped when the test holds.

```tree
task check
  take value, like number
  like boolean
  save valid, wave true
  fork test
    hook test
      call is-below, read value, code 0
    hook hold
      save valid, wave false
  send back, read valid
```

## The inline single-line form

When a test and its branch are short, write each `hook` on one line. The condition or body follows the comma.

```tree
fork test
  hook test, read flag
  hook hold, send back, text <on>
  hook miss, send back, text <off>
```

This is the same block as the indented form, just compressed. Notice `hook test, read flag`: a boolean variable is passed straight through as the condition. You do not compare it to `wave true`. The value `read flag` is already a `boolean`. The stdlib's `boolean` form uses exactly this shape:

```tree
fork test
  hook test, read self
  hook hold, send back, read other
  hook miss, send back, wave false
```

## Conditions built from comparisons

A condition is any `boolean`. Build richer ones by combining comparisons with `and`, `or`, and `not`. See [operators](operators.md) for the full set.

```tree
task in-range
  take x, like number
  take low, like number
  take high, like number
  like boolean
  fork test
    hook test
      call and
        call is-minimum, read x, read low
        call is-below, read x, read high
    hook hold, send back, wave true
    hook miss, send back, wave false
```

The `and` call produces one boolean from two comparisons, and that boolean is the `hook test` condition. You can nest `or` and `not` the same way to express any condition you need.

## Conditionals as values

A `fork test` can sit wherever a value is expected, with each branch sending its result back. The pattern above (test, hold, miss, each returning) is the Term form of a ternary or an expression-if. Keep the branches small and let `send back` carry the result out of each one.
