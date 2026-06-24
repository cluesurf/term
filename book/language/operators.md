# Operators

Term has no infix operators. There is no `+`, `<`, `&&`, or `|>`. Every operation is a `call` to a named function, written the same way as any other call. This keeps one syntactic shape for the whole language. The "operators" are just the standard arithmetic, comparison, and boolean functions, plus `link` for chaining.

Maps to: arithmetic / comparison / boolean operators, and a pipe (`|>`, `.then`, method chaining).

## Cheatsheet

### Arithmetic

| You write | Means | Maps to |
| --- | --- | --- |
| `call add, a, b` | a + b | `+` |
| `call subtract, a, b` | a - b | `-` |
| `call multiply, a, b` | a * b | `*` |
| `call divide, a, b` | a / b | `/` |
| `call modulo, a, b` | remainder of a / b | `%` |

### Comparison

Each returns a `boolean`.

| You write | Means | Maps to |
| --- | --- | --- |
| `call is-equal, a, b` | a equals b | `==` |
| `call is-unequal, a, b` | a does not equal b | `!=` |
| `call is-above, a, b` | a is greater than b | `>` |
| `call is-below, a, b` | a is less than b | `<` |
| `call is-minimum, a, b` | a is at least b | `>=` |
| `call is-maximum, a, b` | a is at most b | `<=` |

### Boolean logic

These are the `boolean` form's own tasks. Call them by name on two booleans, or member-style on one.

| You write | Means | Maps to |
| --- | --- | --- |
| `call and, a, b` | a and b | `&&` |
| `call or, a, b` | a or b | `\|\|` |
| `call not, a` | logical negation | `!` |

### Chaining

| You write | Means | Maps to |
| --- | --- | --- |
| `link <fn>` | pipe the value forward into `<fn>` | `\|>`, `.then`, method chaining |

## Arithmetic

Each arithmetic op is a `call` with two arguments. Arguments can be inline after commas or indented below.

```tree
call add, read a, read b

call multiply
  read width
  read height
```

Nest calls to build expressions. To compute `(a + b) * c`:

```tree
call multiply
  call add
    read a
    read b
  read c
```

`modulo` gives the remainder, which is how you test even or odd:

```tree
task is-even
  take n, like number
  like boolean
  send back
    call is-equal
      call modulo, read n, code 2
      code 0
```

## Comparison

A comparison returns a `boolean`, which is exactly what a condition wants. Pass the result straight into a `hook test`.

```tree
task clamp-low
  take value, like number
  take low, like number
  like number
  fork test
    hook test
      call is-below, read value, read low
    hook hold, send back, read low
    hook miss, send back, read value
```

The full set covers strict and inclusive comparisons:

```tree
call is-equal, read x, code 0      # x == 0
call is-unequal, read x, code 0    # x != 0
call is-above, read x, code 0      # x > 0
call is-below, read x, code 0      # x < 0
call is-minimum, read x, code 0    # x >= 0
call is-maximum, read x, code 0    # x <= 0
```

## Boolean logic

`and`, `or`, and `not` are tasks on the `boolean` form. Call them by name on two booleans:

```tree
call and
  call is-minimum, read x, read low
  call is-below, read x, read high
```

`not` takes one boolean:

```tree
call not
  call is-equal, read a, read b
```

You can also call them member-style on a value, which reads like a method:

```tree
call ready/and, read warm
```

This is the same `and` task, with `ready` as the value it acts on. See [primitives](primitives.md) for the `true` / `false` literals and [structures](structures.md) for the `boolean` form.

## Chaining with `link`

`link <fn>` pipes a value forward. A `call` followed by a child `link g` feeds the call's result into `g`. So:

```tree
call f, read x
  link g
```

means `g(f(x))`. Each `link` child takes the running value and applies the next function, flattening what would otherwise be deeply nested calls.

Without `link`, composing three functions nests inward:

```tree
call format
  call round
    call scale, read raw
```

With `link`, it reads top to bottom in the order things happen:

```tree
call scale, read raw
  link round
  link format
```

Both compute `format(round(scale(raw)))`. The `link` form is easier to read when the pipeline is long, because each step is one line and the order matches the data flow. A `link` target can be a stdlib task or one of your own. To pass extra arguments to a linked function, give it children:

```tree
call to-list, read range
  link map
    read double
  link filter
    read positive
```

This reads as `filter(map(to-list(range), double), positive)`. Reach for `link` whenever a value flows through a series of steps. Use plain nested `call` when there are only one or two stages.
