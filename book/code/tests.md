# Tests

Define tests with `test`. Tests verify that code behaves correctly.

## Test Declaration

```tree
test addition
  save result
    call add
      bind a, mark 2
      bind b, mark 3
  call assert-equal
    bind actual, read result
    bind expected, mark 5
```

## Test with Setup

```tree
test list-push
  save list, make list
  call list/push
    bind item, mark 42
  call assert-equal
    bind actual, call list/get-size
    bind expected, mark 1
```

## Assertions

| Assertion | Purpose |
| --- | --- |
| `call assert-equal` | Values are equal |
| `call assert-true` | Value is true |
| `call assert-false` | Value is false |

## Test Naming

Tests are stored in the book as `test/<name>`:

```tree
test my-feature
  send back, true
```

This creates a book entry named `test/my-feature`.
