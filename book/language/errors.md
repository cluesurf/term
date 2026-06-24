# Errors

Term throws with `bust` and propagates with `halt kink`. Errors are ordinary `form` values, usually a preset variant declared with `case <name>, like error`. A propagating call returns the error up the stack the moment one is thrown, the same job Rust's `?` does.

Maps to: throwing exceptions, or returning `Result` and forwarding with `?`.

## Cheatsheet

| Construct | Where | Does |
| --- | --- | --- |
| `bust <message>` | a statement | throw with a plain text message |
| `bust <name>` + `bind ...` | a statement | throw a preset error, filling its fields |
| `halt kink` | child of a `call` | propagate a thrown error, like `?` |
| `form error` | top level | the standard error shape: `code`, `note`, `hint` |
| `case <name>, like error` | top level | a preset error with fields pre-filled |
| `head <message>` | child of a preset | the human title |
| `code N` | child of a preset | a numeric code |
| `hint <...>` | child of a preset | a fix suggestion |
| `link <field>, like T` | child of a preset | extra data the error carries |

The standard error form ships in the library:

```tree
form error
  link code, like text
  link note, like text
  link hint, like text
```

`code` is a machine-readable id, `note` is the message a person reads, and `hint` suggests a fix.

## Throwing with `bust`

The shortest throw is a plain message.

```tree
bust
  text <division by zero>
```

`bust` inside a branch stops the task and raises the error.

```tree
task safe-divide
  take a, like number
  take b, like number
  like number
  fork test
    hook test
      call is-equal, read b, mark 0
    hook hold
      bust
        text <division by zero>
    hook miss
      send back
        call divide, read a, read b
```

## Preset errors

Declare a named error with `case <name>, like error`. The children pre-fill the fixed fields and add any extra `link` data the error carries.

```tree
case syntax-error, like error
  head <Syntax error>
  code 1
  hint <Check the punctuation near the marked span>

  link line, like number
  link column, like number
```

| Field | Purpose |
| --- | --- |
| `head` | the human-readable title |
| `code` | a numeric code |
| `hint` | how to fix it |
| `link` | a data field the instance carries |

Throw a preset by name and bind its extra fields with `bind`.

```tree
bust syntax-error
  bind line, read line
  bind column, read column
```

The `head`, `code`, and `hint` come from the preset, so only the `link` data needs binding at the throw site.

## Propagating with `halt kink`

Add `halt kink` as a child of a `call`. If that call throws, the current task returns the error instead of crashing. Successful calls pass their value through unchanged.

```tree
task process-file
  take path, like text
  like text
  save content
    call read-file, read path
      halt kink
  save parsed
    call parse, read content
      halt kink
  send back, read parsed
```

Here `read-file` and `parse` may each `bust`. With `halt kink`, the first failure short-circuits `process-file` and forwards the error to its caller. Without it, the throw would propagate uncaught.

## Custom error forms

A preset is the common case, but any `form` can be an error. Define your own shape when you want richer data.

```tree
form parse-error
  link line, like number
  link column, like number
  link note, like text
```

Throw it by constructing and busting in one place.

```tree
bust parse-error
  bind line, mark 12
  bind column, mark 4
  bind note
    text <unexpected token>
```

## Result, for value-level errors

When you would rather return success-or-failure as a value than throw, use the `result` type. It has two cases, `okay` and `error`, and chaining methods so failures flow without manual checks.

Maps to: Rust's `Result<T, E>`.

```tree
task lookup
  take key, like text
  like result
  fork test
    hook test
      call has, read store, read key
    hook hold
      send back
        make okay
          bind value
            call get-or-default, read store, read key, text <>
    hook miss
      send back
        make error
          bind value
            text <missing key>
```

Read it back with `is-okay`, `unwrap-or`, `map`, or `and-then`.

```tree
host value
  call unwrap-or
    call lookup, text <name>
    text <unknown>
```

`to-maybe` drops the error and views the result as a [maybe](structures.md): `okay` becomes `some`, `error` becomes `none`.

## See also

- [conditionals](conditionals.md) for `fork test` guards around a `bust`.
- [matching](matching.md) for `fork case` over `result` and `maybe`.
- [structures](structures.md) for `form`, `case`, and constructing values.
- [functions](functions.md) for `send back` and task shape.
