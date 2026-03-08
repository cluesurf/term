# Functions

Define functions with `task`. Parameters use `take`, return type
uses `like`, return value uses `send back`.

## Basic Task

```tree
task greet
  send back, text <hello>
```

## Parameters (`take`)

```tree
task add
  take a, like u64
  take b, like u64
  like u64
  send back
    call add
      bind a, read a
      bind b, read b
```

With type annotation:

```tree
take x, like u64
```

With a default value (`base`):

```tree
take x, like u64
  base mark 0
```

## Return Type (`like`)

```tree
task is-valid
  take x, like u64
  like boolean
  send back, true
```

## Return Value (`send back`)

Return a value:

```tree
send back, mark 42
send back, text <done>
send back, read x
send back, true
```

Return a function call result:

```tree
send back
  call add
    bind a, read x
    bind b, mark 1
```

Return a constructed value:

```tree
send back, make some
  bind value, read x
```

## Variable Binding (`save`)

Bind a value to a name:

```tree
save x, mark 0
save name, text <hello>
save result
  call add
    bind a, mark 1
    bind b, mark 2
```

Reassign (mutate) a variable:

```tree
save i, mark 0
save i
  call add
    bind a, read i
    bind b, mark 1
```

## Function Calls (`call`)

Call a function with named arguments using `bind`:

```tree
call greet
  bind name, text <world>
```

Call with multiple arguments:

```tree
call add
  bind a, read x
  bind b, read y
```

Call a method on an object:

```tree
call arr/push
  bind item, mark 42
```

Nested calls:

```tree
save result
  call add
    bind a, call mul
      bind a, read x
      bind b, mark 2
    bind b, mark 1
```

## Branching (`fork`)

### If/Else (`fork test`)

```tree
fork test
  hook test
    call is-above
      bind a, read a
      bind b, read b
  hook hold
    send back, read a
  hook miss
    send back, read b
```

### If/Else-If/Else (`fork test`)

It is just a bunch of pairs of `test/hold`, with a final optional `miss`.

```tree
fork test
  hook test
    call is-above
      bind a, read x
      bind b, mark 100
  hook hold
    send back, text <big>
  hook test
    call gt
      bind a, read x
      bind b, mark 10
  hook hold
    send back, text <medium>
  hook miss
    send back, text <small>
```

### Pattern Match (`fork case`)

Match on an enum variant:

```tree
fork case, read color
  case red
    send back, text <red>
  case green
    send back, text <green>
  case blue
    send back, text <blue>
```

Destructure fields with `base`:

```tree
fork case, read m
  case some, base value
    send back, read value
  case none
    send back, mark 0
```

Nested pattern match:

```tree
fork case, read n
  case zero
    send back, mark 0
  case succ, base pred
    fork case, read pred
      case zero
        send back, mark 1
      case succ, base pp
        send back
          call add
            bind a, call fib, bind n, read pred
            bind b, call fib, bind n, read pp
```

### Custom Scope (`fork tree`)

```tree
fork tree
  save x, mark 1
  save y, mark 2
  send back
    call add
      bind a, read x
      bind b, read y
```

## Loops (`walk`)

### While Loop (`walk test`)

```tree
save i, mark 0
walk test
  hook test
    call is-below
      bind a, read i
      bind b, mark 10
  hook hold
    save i
      call add
        bind a, read i
        bind b, mark 1
```

### For-Each (`walk list`)

```tree
walk list, read items
  hook next
    take site, name item
    call show, read item
```

### Range Loop (`walk size`)

```tree
walk size
  bind base, 0
  bind head, 10
  hook next
    take slot, name i
    call show, read i
```

### Iterator (`walk site`)

```tree
walk form, read iter
  hook next
    take site, name item
    call process
      bind item, read item
```

## Logical Operations (`meet`)

Combine boolean expressions:

```tree
send back
  meet and
    read a
    read b
```

```tree
send back
  meet or
    call is-admin, bind user, read user
    call is-owner, bind user, read user
```

Three or more conditions:

```tree
send back
  meet and
    read a
    read b
    read c
```

## Error Handling

### Throw Errors (`bust`)

Throw an error by name:

```tree
bust syntax-error
  bind text, read source
  bind line, read line
```

Throw with a message:

```tree
bust <division by zero>
```

### Propagate Errors (`send error`)

Propagate an error up the call stack (like Rust's `?`):

```tree
save content
  call read-file
    bind path, read path
    send error
```

If `read-file` throws via `bust`, `send error` returns the error
from the current task instead of crashing.

### Break from Loop or Block

```tree
halt fork
halt some-fork-name
```

```tree
walk test, true
  hook hold
    fork test
      hook test
        call is-done
      hook hold
        halt fork
```

Or if you name it:


```tree
walk test, true
  hook hold, name fork-1
    fork test
      hook test
        call is-done
      hook hold
        halt fork-1
```

### Continue (`next`)

Skip to next iteration:

```tree
walk list, read items
  hook next
    take site, name item
    fork test
      hook test
        call is-skip
          bind item, read item
      hook hold
        turn next
    call process
      bind item, read item
```

### Halt the Program (`halt flow`)

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

## Async (`wait`)

Mark a task as async:

```tree
task fetch-data
  wait true
  take url, like text
  save response
    call fetch-url
      bind url, read url
      wait true
  send back, read response
```

The `wait true` on `call` awaits the result.

## Unsafe (`risk`)

Mark a task as unsafe:

```tree
task unchecked-add
  risk true
  take a, like u64
  take b, like u64
  send back
    call add
      bind a, read a
      bind b, read b
```

## Generic Functions

```tree
task identity
  head t
  take x
  send back, read x
```

```tree
task apply
  head a
  head b
  take f, like task
  take x
  send back
    call f
      bind x, read x
```

## Higher-Order Functions

Accept a function as a parameter:

```tree
task apply
  take f
    like task
      take x, like u64
      like u64
  take x, like u64
  like u64
  send back
    call f
      bind x, read x
```

## Visibility

`hide` makes a task private:

```tree
task internal-helper
  hide true
  send back, mark 0
```

## Native Calls

Import a native module and call its functions:

```tree
load <node:fs>, name fs
  host true

task read-file
  take path, like text
  call fs/read-file-sync
    bind path, read path
    bind encoding, text <utf8>
```

See `modules.md` for more on host imports.
