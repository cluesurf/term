# Validation

Validation is the act of turning untrusted input into a typed value you can trust, or a clear failure. Term has no separate validation framework. It uses the same two types the rest of the library uses for fallible work: **maybe** for "a value or nothing" and **result** for "a value or an error". A validator is just a `task` that returns one of them.

Maps to: Rust's `Result<T, E>` and `Option<T>`, or a parser-combinator that returns `Either<Error, Value>`.

## Cheatsheet

### result

A `result` is `okay` (a value) or `error` (a reason). It is the return type of any function that can fail with a reason.

| Name | Kind | Does |
| --- | --- | --- |
| `result` | form | `okay { value }` or `error { value }`, generic over the ok type and the error type |
| `is-okay` / `is-error` | method | which case it is |
| `unwrap-or` | method | the value, or a fallback on error |
| `unwrap-or-else` | method | the value, or a function of the error |
| `map` | method | transform the ok value, leave an error untouched |
| `map-error` | method | transform the error, leave an ok value untouched |
| `and-then` | method | run another fallible step on the ok value (chains validators) |
| `to-maybe` | method | forget the error: `okay` becomes `some`, `error` becomes `none` |

### maybe

A `maybe` is `some` (a value) or `none` (absence). Use it when failure needs no reason.

| Name | Kind | Does |
| --- | --- | --- |
| `maybe` | form | `some { value }` or `none` |
| `is-some` / `is-none` | method | which case it is |
| `unwrap-or` | method | the value, or a fallback |
| `map` | method | transform the value if present |
| `and-then` | method | run another optional step (chains lookups) |
| `or-else` | method | this value, or another maybe |
| `filter` | method | keep the value only if a test holds |
| `unwrap` | method | the value, or throw if none |

### throwing

| Head | Does |
| --- | --- |
| `bust <error>` | throw an error (the exceptional path) |
| `halt kink` | as a child of a `call`, propagate a failure upward like Rust's `?` |

## A validator returns a result

The simplest validator is a `task` whose return type is `result`. On success it builds an `okay`, on failure an `error` with a reason.

```tree
load @cluesurf/base/code/result
  find result

task check-age
  take age, like number
  like result
  fork test
    hook test
      call is-below
        read age
        code 0
    hook hold
      send back
        make error
          bind value
            text <age cannot be negative>
    hook miss
      send back
        make okay
          bind value, read age
```

The caller inspects the result instead of guarding against a bad value everywhere.

```tree
host safe-age
  call unwrap-or
    call check-age
      code 30
    code 0
```

## Chaining validators with and-then

Real input has several rules. `and-then` runs the next step only when the previous one succeeded, threading the error through untouched. This is how you compose a pipeline without nesting `fork` after `fork`.

```tree
task check-username
  take name, like text
  like result
  fork test
    hook test
      call is-below
        read name/length
        code 3
    hook hold
      send back
        make error
          bind value
            text <username too short>
    hook miss
      send back
        make okay
          bind value, read name

task validate-signup
  take name, like text
  like result
  send back
    call and-then
      call check-username
        read name
      task confirm-available
        take ok, like text
        like result
        send back
          make okay
            bind value, read ok
```

Each step is `okay` or `error`. The first `error` short-circuits the chain.

## Optional fields with maybe

When a value's absence is normal and needs no message, use `maybe`. `filter` turns a present value into `none` when it fails a test.

```tree
load @cluesurf/base/code/maybe
  find maybe

task even-or-none
  take value, like number
  like maybe
  send back
    call filter
      make some
        bind value, read value
      task is-even
        take n, like number
        like boolean
        send back
          call is-equal
            call modulo
              read n
              code 2
            code 0
```

## Propagating failure with halt kink

Inside a task that itself returns a result, `halt kink` as a child of a `call` unwraps an `okay` and returns early on an `error`. It is the same idea as Rust's `?` operator: success flows on, failure exits.

```tree
task make-account
  take name, like text
  take age, like number
  like result
  save valid-name
    call check-username
      read name
    halt kink
  save valid-age
    call check-age
      read age
    halt kink
  send back
    make okay
      bind value
        make account
          bind name, read valid-name
          bind age, read valid-age
```

If either check returns an `error`, `make-account` returns that same error and never reaches the construction.

## When to throw instead

`result` and `maybe` are for expected, recoverable outcomes (bad user input, a missing key). For a genuine bug or an unrecoverable state, `bust` throws an error that unwinds. See [errors](../language/errors.md) for the full story on `bust`, error forms, and `halt kink`.
