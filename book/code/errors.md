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

## Throwing Errors

### Throw with Message

```tree
halt <division by zero>
```

### Throw a Kink

```tree
halt kink
```

### Throw in a Condition

```tree
task safe-div
  take a, like u64
  take b, like u64
  fork test
    call eq
      bind a, read b
      bind b, mark 0
    hook true
      halt text <division by zero>
    hook false
      send back
        call div
          bind a, read a
          bind b, read b
```

### Break from a Loop

`halt` without a message breaks the current loop:

```tree
walk test, true
  hook step
    fork test
      call is-done
      hook true
        halt
```

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
  back text <done>
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
bust text <fatal: out of memory>
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
