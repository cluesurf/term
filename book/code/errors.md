# Errors

Throw with `bust`. Propagate with
`send error`. Catch with `mark unsafe`.

## Error Type

The standard error form:

```tree
form error
  link code, like text
  link note, like text
  link hint, like text
```

- `code`: machine-readable error identifier
- `note`: human-readable error message
- `hint`: suggestion for how to fix it

## Defining Errors

Define named error types with `case`. Each error definition declares
the error's heading, optional numeric code, hint text, and data fields.

```tree
case syntax-error, like error
  head <Syntax error>
  code 1
  hint <To fix this syntax error, try x>

  link text, like text
  link link, like text
  link band, like text
```

### Fields

| Keyword | Purpose |
| --- | --- |
| `head` | Human-readable error title |
| `code` | Numeric error code (converted to string for search engines) |
| `hint` | Suggestion for how to fix the error |
| `link` | Data field carried by the error instance |

### Rendering

Each error has a `show` task that renders it for the CLI. There is a
default renderer, but you can override it per error.

First, define the fill (default renderer mixin):

```tree
load @cluesurf/term/code/error
  find fill

cast syntax-error, like error
  head <Syntax error>
  code 1
  hint <To fix this syntax error, try x>

  link text, like text
  link link, like text
  link band, like text

  link show, void text
  link link, void text

  wear fill
    task fill
      take self
      save self/show, call make-error-show, loan self/text
      save self/link, loan self/link
```

The `void` fields are computed during fill (not user-provided). The
`wear fill` block runs when the error is constructed, computing
derived fields like `show` (formatted display text).

### Custom Rendering

Override the default renderer:

```tree
load @cluesurf/term/code/error
  find show

load ./halt
  find cast syntax-error

cast syntax-error
  wear show
    task show
      take self
      take call, list halt-call
      call make-error-text
        loan self
        loan call
```

## Throwing Errors (`bust`)

Throw a defined error by name and bind its data fields:

```tree
bust syntax-error
  bind text, read source
  bind link, read link
  bind band
    call make-band
      bind text, read source
```

Throw with a plain message:

```tree
bust <division by zero>
```

Throw in a condition:

```tree
task safe-div
  take a, like u64
  take b, like u64
  fork test
    hook test
      call is-equal
        bind a, read b
        bind b, mark 0
    hook hold
      bust <division by zero>
    hook miss
      send back
        call div
          bind a, read a
          bind b, read b
```

## Error Propagation (`send error`)

Pass errors up the call stack. Add `send error` as a child of `call`
to propagate any thrown error (like Rust's `?`):

```tree
task process-file
  take path, like text
  save content
    call read-file
      bind path, read path
      send error
  save result
    call parse
      bind text, read content
      send error
  send back, read result
```

If a called function throws via `bust`, `send error` causes the
current task to return the error instead of crashing.

## Catching Errors (`mark unsafe`)

Mark an entire task as unsafe to handle errors manually:

```tree
task unchecked-add
  mark unsafe
  take a, like u64
  take b, like u64
  send back
    call add
      bind a, read a
      bind b, read b
```

## Halting

### Stop the Program (`halt flow`)

Stop execution entirely:

```tree
halt flow
halt flow, text <shutting down>
```

### Debugger Breakpoint (`halt code`)

Pause execution for debugging (like `debugger` in JavaScript):

```tree
halt code
```

### Break from Loop or Block (`halt`)

`halt` breaks the current loop or block:

```tree
walk test
  hook test, true
  hook hold
    fork test
      hook test
        call is-done
      hook hold
        halt
```

Break from a named scope:

```tree
halt fork
```

## Error Severity

| Level | Keyword | Meaning |
| --- | --- | --- |
| Throw | `bust` | Throw a catchable error |
| Break | `halt` | Break from loop or block |
| Stop | `halt flow` | Stop the program |
| Debug | `halt code` | Debugger breakpoint |

## Custom Error Forms

Define your own error types:

```tree
form parse-error
  link line, like u64
  link column, like u64
  link note, like text
```
