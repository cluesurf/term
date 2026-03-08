# Errors

Errors in Seed use the `kink` form. Throw with `halt`. Catch with
`risk`.

## Error Type (`kink`)

The standard error form:

```tree
form kink
  link code, like text
  link note, like text
  link hint, like text
```

- `code`: machine-readable error identifier
- `note`: human-readable error message
- `hint`: suggestion for how to fix it

## Defining Errors (`kink`)

Define named error types with `kink`. Each kink definition declares
the error's heading, optional numeric code, hint text, and data fields.

```tree
kink syntax-error
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

Each kink has a `show` task that renders it for the CLI. There is a
default renderer, but you can override it per error.

First, define the fill (default renderer mixin):

```tree
load @cluesurf/term/code/kink
  find fill

kink syntax-error
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
      save self/show, call make-kink-show, loan self/text
      save self/link, loan self/link
```

The `void` fields are computed during fill (not user-provided). The
`wear fill` block runs when the error is constructed, computing
derived fields like `show` (formatted display text).

### Custom Rendering

Override the default renderer:

```tree
load @cluesurf/term/code/kink
  find show

load ./halt
  find kink syntax-error

kink syntax-error
  wear show
    task show
      take self
      take call, list halt-call
      call make-kink-text
        loan self
        loan call
```

### Throwing Errors

Throw a defined kink by name and bind its data fields:

```tree
load ./halt
  find kink syntax-error

halt syntax-error
  bind text, loan text
  bind link, loan link
  bind band, call make-band, loan text
```

## Stopping a Program

Stop the program with `halt flow`:

```tree
halt flow, text <Message>
halt <Message>
```

Both forms stop program execution with an error message.

## Throwing Errors

### Throw with Message

```tree
kink <division by zero>
```

### Throw a Kink

```tree
kink some-message-key
```

### Throw in a Condition

```tree
task safe-div
  take a, like u64
  take b, like u64
  fork test
    hook test
      call eq
        bind a, read b
        bind b, mark 0
    hook hold
      halt text <division by zero>
    hook miss
      send back
        call div
          bind a, read a
          bind b, read b
```

## Breaking Out

### Break from a Loop

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

### Break from a Fork

Break from a named scope:

```tree
halt fork
halt term
```

As long as `term` is not a special halt keyword like `fork` or `flow`.

## Catching Errors (`risk`)

Mark a call as risky to catch errors:

```tree
task write-file
  take path, like text
  take content, like text
  call fs/write
    bind path, read path
    bind content, read content
    halt kink
  send back, text <done>
```

Mark an entire task as unsafe:

```tree
task unchecked-add
  risk true
  take a, like u64
  take b, like u64
  send back, call add
    bind a, read a
    bind b, read b
```

## Critical Error (`bust`)

For unrecoverable situations:

```tree
bust <out of memory>
```

## Error Propagation

Pass errors up the call stack:

```tree
task process-file
  take path, like text
  save content
    call read-file
      bind path, read path
      halt kink
  save result
    call parse
      bind text, read content
      halt kink
  send back, read result
```

## Error Severity

| Level | Keyword | Meaning |
| --- | --- | --- |
| Fatal | `halt` | Stop execution, throw error |
| Critical | `bust` | Unrecoverable, crash |

## Custom Error Forms

Define your own error types:

```tree
form parse-error
  link line, like u64
  link column, like u64
  link note, like text
```
