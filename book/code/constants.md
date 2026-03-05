# Constants

Define constants with `host`. Constants are immutable values known
at compile time.

## Simple Constant

```tree
host max-size, mark 1024
host greeting, text <hello world>
```

## Named Constant Block

Group related constants:

```tree
host permission
  host can-read-flag, mark #b1
  host can-write-flag, mark #b10
  host can-create-flag, mark #b100
  host can-append-flag, mark #b1000
  host can-clear-flag, mark #b10000
  host can-read-write-flag, mark #b11
```

## Enum-Like Constants (`term`)

Define a set of named symbols:

```tree
host interval
  term year
  term month
  term week
  term day
  term hour
  term minute
  term second
  term millisecond
  term microsecond
```

```tree
host encoding
  term ascii
  term utf-8
  term utf-16
  term utf-32
  term base-64
```

```tree
host color
  term red
  term green
  term blue
```

## Nested Constants

Constants can nest arbitrarily:

```tree
host mode
  host owner
    host read-flag, mark #b100000000
    host write-flag, mark #b10000000
    host execute-flag, mark #b1000000
  host group
    host read-flag, mark #b100000
    host write-flag, mark #b10000
    host execute-flag, mark #b1000
```

## Test Data Constants

Constants work well for test data:

```tree
host test-data
  host add-cases
    host zero
      host a, mark 0
      host b, mark 0
      host result, make some, mark 0
    host small
      host a, mark 0
      host b, mark 1
      host result, make some, mark 1
    host overflow
      host a, mark 255
      host b, mark 1
      host error, wave true
```

## Using Constants

Access constants with `read`:

```tree
read pi
read permission/can-read-flag
read mode/owner/read-flag
```

Access environment variables:

```tree
read base/host/path
read base/host/home
```
