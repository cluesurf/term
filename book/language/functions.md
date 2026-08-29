# Functions

A function in Term is a `task`. You declare parameters with `take`, name the return type with `like`, and return a value with `send back`. Methods are just tasks that take a first parameter named `self`.

Maps to: functions, methods, and closures in Rust / Swift / TypeScript.

## Cheatsheet

| Head | Job | Example |
| --- | --- | --- |
| `task name` | define a function | `task add` |
| `take p` | declare a parameter | `take left, like number` |
| `take p, like T, fall v` | parameter with a default value | `take step, like number, fall 1` |
| `take p, like T, need false` | optional parameter, no default | `take label, like text, need false` |
| `slot p, like T` | positional-only parameter | `slot left, like number` |
| `take self` | the receiver of a method | `take self` |
| `like T` | the return type | `like number` |
| `send back, v` | return a value | `send back, read total` |
| `send back` + body | return a value that has children | `send back` then a `call`/`make` block below |
| `call f, a, b` / `call f(a, b)` | invoke a function with positional args | `call add, read x, read y` |
| `call f` + `bind p, v` children | invoke with named args, any order | `call scale` then `bind shift, code 1` |
| `call x/method, a` | invoke a method on a value | `call list/push, read item` |
| `head t` | a type parameter (generic) | `head t` |
| `take f` + `like task` | a function-typed parameter (closure) | see [Closures](#closures-function-typed-parameters) |
| `note async` | mark a task async (child of `task`) | `note async` |
| `note private` | hide the task from other modules | `note private` |

Notes that catch people out:
- Call arguments are `read`/value children: one per indented line, comma separated on one line (`call add, read a, read b`), or inside parentheses after the callee (`call add(read a, read b)`). A comma returns to the head of the line, so all three are the same two-argument call.
- A `bind <name>, <value>` child names the argument. Named and positional mix: positional fill the next open position, named go where they belong. A name the task does not have, a name given twice, or a name on a `slot` parameter is a build error.
- A parameter with `fall` fills in when the call leaves it out, in any position. One with `need false` and no `fall` may only be left out at the end.
- A `slot` parameter is positional only. Use it when the order is the meaning (`pair`, `at`), so nobody reorders the parameters and breaks every caller.
- Two tasks may share a name when their parameter counts differ, or when their parameter types differ at some position. The call picks the one its arguments fit. When none fits the build says which are defined.
- A `send back` value that has its own children goes on the next indented line. Never write `send back, make foo` with `bind` children below it.
- A no-argument task simply omits every `take`.

## A basic task

```tree
task add
  take left, like number
  take right, like number
  like number
  send back
    call add, read left, read right
```

`add` takes two numbers, returns a number, and sends back their sum. The inline form of the body is identical:

```tree
send back, call add, read left, read right
```

## No-argument tasks

Omit `take` entirely. A task with no `take` and no `like` returns the unit value.

```tree
task now
  like number
  send back, call clock/read

task warm-up
  call write-line, text <starting up>
```

## Parameters (`take`)

Each parameter is one `take` with a `like` type child. Repeat `take` for more parameters.

```tree
task clamp
  take value, like number
  take low, like number
  take high, like number
  like number
  fork test
    hook test, call is-below, read value, read low
    hook hold, send back, read low
    hook test, call is-above, read value, read high
    hook hold, send back, read high
    hook miss, send back, read value
```

### Default values (`base`)

Give a parameter a default with a `base` child holding a literal. Callers may omit it.

```tree
task step-up
  take value, like number
  take step, like number
    base code 1
  like number
  send back, call add, read value, read step
```

`call step-up, read n` uses the default `1`. `call step-up, read n, code 5` overrides it.

## Return type (`like`) and return value (`send back`)

The return type is a single `like` line. The returned value is `send back`. A simple value goes inline. A value with children (a `call`, a `make`, a `fork`) goes on the next indented line.

```tree
task describe
  take ok, like boolean
  like text
  fork test
    hook test, read ok
    hook hold, send back, text <ready>
    hook miss, send back, text <waiting>
```

Returning a constructed value uses the indented form:

```tree
task wrap
  head t
  take value, like t
  like maybe
  send back
    make some
      bind value, read value
```

## Calling tasks (`call`)

`call` invokes a task. Arguments are positional value children in declared order.

```tree
save total
  call add, read x, read y

save best
  call clamp, read raw, code 0, code 100
```

Nested calls compose by nesting `call` blocks:

```tree
send back
  call add
    call multiply, read x, code 2
    code 1
```

Call a method on a value with the `/` member form. The value is the receiver, the rest are positional arguments.

```tree
call list/push, read item
call self/map, read transform
```

## Methods and `self`

A method is a task inside a `form` whose first parameter is `self`. `self` is the receiver. Read its fields with `read self/field`.

```tree
form counter
  link value, like number

  task bump
    take self
    like counter
    send back
      make counter
        bind value, call add, read self/value, code 1

  task is-zero
    take self
    like boolean
    send back, call is-equal, read self/value, code 0
```

Call them member-style on a value: `call c/bump` and `call c/is-zero`. See [structures](structures.md) for how forms are defined.

## Closures (function-typed parameters)

To accept a function as a parameter, give the `take` a `like task` child that mirrors the function's shape. Put each expected parameter as a `take` child of the `like task`, and the expected result as a `like` child.

```tree
task apply-twice
  take value, like number
  take change
    like task
      take input, like number
      like number
  like number
  save once, call change, read value
  send back, call change, read once
```

The caller passes a task by name, and it is invoked with `call change, ...`. This is how the stdlib `map`, `filter`, and `and-then` take a transform:

```tree
task map
  head s
  take self
  take call
    like task
      take value, like t
      like s
  like maybe
  fork case, read self
    case some
      send back
        make some
          bind value, call call, read self/value
    case none
      send back, make none
```

## Recursion

A task may call itself. Term checks structural recursion for totality (see [math](../math/readme.md)), but ordinary recursion is just a self `call`.

```tree
task factorial
  take n, like number
  like number
  fork test
    hook test, call is-maximum, read n, code 1
    hook hold, send back, code 1
    hook miss
      send back
        call multiply
          read n
          call factorial, call subtract, read n, code 1
```

## Async and visibility

`note async` as a child of `task` marks the function async. As a child of a `call` it awaits that call. Never wrap a body under `note async`.

```tree
task load-page
  note async
  take url, like text
  like text
  save body
    call fetch, read url
      note async
  send back, read body
```

`note private` keeps a task internal to its module.

```tree
task helper
  note private
  take n, like number
  like number
  send back, call multiply, read n, code 2
```

See [types](types.md) for the type vocabulary these examples lean on, [structures](structures.md) for forms and `make`, and [matching](matching.md) for `fork case`.
