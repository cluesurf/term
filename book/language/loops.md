# Loops

Every loop is a `walk`. The word after `walk` says what kind: a list to iterate, a range with bounds, or a `test` that gates a while-loop. Inside, `hook` heads carry the body and the per-step binding. `turn next` continues, `halt` breaks.

Maps to: `for ... of` (list), a `for` range loop, and `while`.

## Cheatsheet

| Head | Job |
| --- | --- |
| `walk list, <items>` | iterate the elements of a list |
| `walk size` | iterate a numeric range |
| `walk test` | loop while a condition holds (a while-loop) |
| `hook next` | the body run once per element (list and range loops) |
| `hook test, <cond>` | the loop condition (range bounds and while-loops) |
| `hook hold, <body>` | the body run each pass while the test holds (while-loops) |
| `take site, name x` | bind the current element to the name `x` |
| `take i` | bind the current index / counter to `i` (range loops) |
| `bind base, mark N` | the range start (inclusive) |
| `bind head, mark N` | the range end (exclusive) |
| `turn next` | continue to the next iteration |
| `halt` | break out of the loop |

Rules at a glance:

- List loops use `walk list` plus `hook next` and a `take site, name x` binding.
- Range loops use `walk size` with `bind base` / `bind head` and a `take i` counter.
- While-loops use `walk test` with `hook test` (condition) and `hook hold` (body).
- Accumulate results into a `save`d variable declared before the loop.

## Iterating a list

`walk list, <items>` runs the body once per element. `hook next` holds the body. `take site, name x` binds the current element to `x`.

```tree
task show-all
  take items, like list
  like void
  walk list, read items
    hook next
    take site, name line
    call write-line, read line
```

To build a result, declare a `save`d accumulator before the loop and update it each pass. This is the standard sum:

```tree
task sum
  take items, like list
  like number
  save total, code 0
  walk list, read items
    hook next
    take site, name value
    save total
      call add
        read total
        read value
  send back, read total
```

`total` starts at `code 0`, each element is added in, and the final total is sent back. The same shape with `multiply` and a seed of `code 1` gives a product.

## Iterating a range

`walk size` counts over a numeric range. `bind base` is the start (inclusive), `bind head` is the end (exclusive). `take i` binds the counter. `hook next` holds the body.

```tree
task count-up
  like void
  walk size
    bind base, mark 0
    bind head, mark 10
    take i
    hook next
      call write-line, read i
```

This shows `0` through `9`. Use a range loop when you need an index, not just the elements. To sum the numbers in a range:

```tree
task triangle
  take n, like number
  like number
  save total, code 0
  walk size
    bind base, mark 1
    bind head, read n
    take i
    hook next
      save total
        call add, read total, read i
  send back, read total
```

## While-loops

`walk test` loops while a condition holds. `hook test` carries the condition, `hook hold` carries the body. The test is checked before each pass, so the body may run zero times.

```tree
task count-down
  take start, like number
  like void
  save at, read start
  walk test
    hook test
      call is-above, read at, code 0
    hook hold
      call write-line, read at
      save at
        call subtract, read at, mark 1
```

The loop runs while `at` is above zero. Each pass shows `at` then decreases it, so the test eventually fails and the loop ends. A while-loop is the right tool when the number of iterations is not known up front and depends on values computed inside the loop.

## Continue with `turn next`

`turn next` skips the rest of the current iteration and moves to the next one. Use it to filter elements without nesting the body in a `fork`.

```tree
task sum-positive
  take items, like list
  like number
  save total, code 0
  walk list, read items
    hook next
    take site, name value
    fork test
      hook test
        call is-below, read value, code 0
      hook hold
        turn next
    save total
      call add, read total, read value
  send back, read total
```

When `value` is below zero, `turn next` skips it and the loop continues with the next element.

## Break with `halt`

`halt` ends the loop immediately. Use it to stop as soon as you find what you are looking for.

```tree
task first-negative
  take items, like list
  like number
  save found, code 0
  walk list, read items
    hook next
    take site, name value
    fork test
      hook test
        call is-below, read value, code 0
      hook hold
        save found, read value
        halt
  send back, read found
```

As soon as a negative element appears, `found` is set and `halt` breaks out, leaving the rest of the list unvisited. Use `turn next` to skip one element and keep going, and `halt` to stop the loop entirely. Both work in list, range, and while-loops.
