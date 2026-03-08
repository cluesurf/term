# Constants

Define constants with `seed`. Constants are immutable values known
at compile time.

## Simple Constant

```tree
seed max-size, 1024
seed greeting, <hello world>
```

## Named Constant Block

Group related constants:

```tree
seed permission
  seed can-read-flag, #b1
  seed can-write-flag, #b10
  seed can-create-flag, #b100
  seed can-append-flag, #b1000
  seed can-clear-flag, #b10000
  seed can-read-write-flag, #b11
```

## Enum-Like Constants (`term`)

Define a set of named symbols:

```tree
seed interval
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
seed encoding
  term ascii
  term utf-8
  term utf-16
  term utf-32
  term base-64
```

```tree
seed color
  term red
  term green
  term blue
```

## Nested Constants

Constants can nest arbitrarily:

```tree
seed mode
  seed owner
    seed read-flag, #b100000000
    seed write-flag, #b10000000
    seed execute-flag, #b1000000
  seed group
    seed read-flag, #b100000
    seed write-flag, #b10000
    seed execute-flag, #b1000
```

## Test Data Constants

Constants work well for test data:

```tree
seed test-data
  seed add-cases
    seed zero
      seed a, 0
      seed b, 0
      seed result, make some, 0
    seed small
      seed a, 0
      seed b, 1
      seed result, make some, 1
    seed overflow
      seed a, 255
      seed b, 1
      seed error, wave true
```

## JSON

Seeds can be used to construct anything JSON supports:

Lists/arrays:

```tree
seed example
  seed an-array, like list
    save 1
    save 2
    save 3

seed example-2
  seed an-array, like list
    1
    2
    3
```

Maps/objects:

```tree
seed example
  seed an-object, like base
    save a, 1
    save b, 2
    save c, 3
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
read base/seed/path
read base/seed/home
```
