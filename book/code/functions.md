# Functions

Define functions with `task`. Parameters use `take`, return type
uses `like`, return value uses `back`.

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

Parameter modifiers:

```tree
take x               # default (copy)
take x, like u64     # with type
```

## Return Type (`like`)

```tree
task is-valid
  take x, like u64
  like boolean
  send back, true
```

## Return Value (`back`)

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
  call gt
    bind a, read a
    bind b, read b
  hook true
    send back, read a
  hook false
    send back, read b
```

### If/Else-If/Else (`fork roll`)

```tree
fork roll
  hook test
    call gt
      bind a, read x
      bind b, mark 100
    send back, text <big>
  hook test
    call gt
      bind a, read x
      bind b, mark 10
    send back, text <medium>
  hook fall
    send back, text <small>
```

### Pattern Match (`fork case`)

Match on an enum variant:

```tree
fork case, read color
  hook red
    send back, text <red>
  hook green
    send back, text <green>
  hook blue
    send back, text <blue>
```

Destructure fields with `base`:

```tree
fork case, read m
  hook some, base value
    send back, read value
  hook none
    send back, mark 0
```

Nested pattern match:

```tree
fork case, read n
  hook zero
    send back, mark 0
  hook succ, base pred
    fork case, read pred
      hook zero
        send back, mark 1
      hook succ, base pp
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
  call lt
    bind a, read i
    bind b, mark 10
  hook step
    save i
      call add
        bind a, read i
        bind b, mark 1
```

### For-Each (`walk list`)

```tree
walk list
  read items
  hook tick
    take item
    show read item
```

### Range Loop (`walk size`)

```tree
walk size
  mark 0
  mark 10
  hook step
    take i
    show read i
```

### Iterator (`walk site`)

```tree
walk site
  read iter
  hook tick
    take item
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
    call is-admin, bind user, loan user
    call is-owner, bind user, loan user
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

### Throw (`halt`)

```tree
halt text <division by zero>
```

Throw a typed error:

```tree
halt kink
```

### Break from Loop

```tree
walk test
  wave true
  hook step
    fork test
      call is-done
      hook true
        halt
```

### Continue (`next`)

Skip to next iteration:

```tree
walk list
  read items
  hook tick
    take item
    fork test
      call is-skip, bind item, read item
      hook true
        next
    call process, bind item, read item
```

### Critical Error (`bust`)

Unrecoverable error:

```tree
bust text <fatal: out of memory>
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
  take f, like task
    take x, like u64
    like u64
  take x, like u64
  like u64
  send back
    call f
      bind x, read x
```

## Visibility

```tree
task internal-helper
  hide true
  send back, mark 0

task public-api
  face true
  send back
    call internal-helper
```

## Dock (Platform-Specific)

```tree
dock load
  load <node:fs>, name fs

task read-file
  take path, like text
  call fs/read-file-sync
    bind path, read path
    bind encoding, text <utf8>
```
