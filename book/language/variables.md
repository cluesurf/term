# Variables

How you name values, change them, read them, and lend them out. Term has one rule for naming: a bare word after a head is a name, and to use the value behind a name you wrap it in a head like `read`.

Maps to: `let` (mutable), `const` (constant), field access, and a borrow (`&x` in Rust, a read-only reference).

## Cheatsheet

| Head | Job | Example |
| --- | --- | --- |
| `save x, <value>` | declare a mutable local, or reassign an existing one | `save count, code 0` |
| `host x, <value>` | declare a constant (cannot be reassigned) | `host limit, code 100` |
| `read x` | use the value of a variable | `read count` |
| `read x/field` | reach into a nested field via `/` | `read user/email` |
| `read x/a/b` | reach deeper, one step per `/` | `read config/host/port` |
| `loan x` | borrow a value (read it without consuming or moving it) | `loan buffer` |

Quick rules:

- `save` both declares and reassigns. The first `save x` makes the variable. A later `save x` with the same name changes it.
- `host` is write-once. Reassigning a `host` is an error.
- A bare name is a definition. `read` turns a name into the value it holds.
- `/` is the only path operator. It reaches into fields, methods, and module members.
- `loan` lends a value to a callee without giving it away, so you can keep using it after.

## Declaring with `save`

`save name, <value>` introduces a mutable local. The value can be a literal or a longer expression on the next indented line.

```tree
save count, code 0
save greeting, text <hello>

save total
  call add
    read base
    read extra
```

## Reassigning with `save`

To change a variable, `save` it again with the same name. This is the same head, no new keyword.

```tree
save count, code 0
save count
  call add
    read count
    code 1
```

A common shape is accumulating into a `save`d total inside a loop:

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

See [loops](loops.md) for the loop shape.

## Constants with `host`

`host name, <value>` declares a value that never changes. Use it for limits, names, and any value fixed for the life of the program.

```tree
host limit, code 100
host app-name, text <term>
host enabled, true
```

Reassigning a `host` is rejected by the compiler. If you need to change the value over time, use `save`. See [constants](constants.md) for compile-time folding and module-level constants.

## Reading values with `read`

A bare name is a label. To use the value behind it, wrap it in `read`.

```tree
take name, like text    # `name` is a name being declared
read name               # the VALUE held by `name`
```

This is the difference between mentioning a variable and using it. Heads like `take`, `save`, and `host` introduce a name. `read` consumes one.

## Nested access with `/`

`/` reaches into a field, one segment per slash. It reads left to right, outermost first.

```tree
read user/email
read config/host/port
read order/total/cents
```

The same `/` reaches a method or a member of an imported module:

```tree
call text/length, read line
call fs/read-file, read path
```

See [modules](modules.md) for module members and [native](native.md) for host modules.

## Borrowing with `loan`

`loan x` lends a value to a callee for reading without consuming or moving it. You keep ownership and can use the variable again afterward. Use `loan` when a function only needs to look at a value, not take it.

```tree
task longest
  take a, like text
  take b, like text
  like text
  fork test
    hook test
      call is-above
        call text/length, loan a
        call text/length, loan b
    hook hold, send back, read a
    hook miss, send back, read b
```

Here `loan a` and `loan b` let `text/length` read each string. The strings stay owned by `longest`, so both are still available for `send back`. Use `read` when the callee should take the value, `loan` when it should only borrow it.

## Scope and shadowing

A variable lives from its declaration to the end of the block that introduced it. A name declared inside a `fork` branch or a `walk` body is visible only inside that block.

```tree
task pick
  take flag, like boolean
  like text
  fork test
    hook test, read flag
    hook hold
      host label, text <yes>
      send back, read label
    hook miss
      host label, text <no>
      send back, read label
```

Each branch declares its own `label`. The two do not collide, because each lives only inside its own branch.

An inner block may shadow a name from an outer block. The inner name is used within the inner block, and the outer name returns once the inner block ends.

```tree
task scope-demo
  like number
  save x, code 1
  fork test
    hook test, true
    hook hold
      save x, code 2
      call write-line, read x
  send back, read x
```

The shown `x` is `2`, the returned `x` is `1`. The inner `save x` shadows the outer one only inside the `hook hold` block. Prefer distinct names when the shadowing is not intentional.
