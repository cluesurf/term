# Async

Term has no separate color for asynchronous functions. A task that touches IO is marked async, and every call to it is awaited by default. You write straight-line code, and the compiler threads the awaits for you. When you want the other behaviors (force an await, or fire and forget), you say so with one child line.

Maps to: `async` / `await` and promises (JavaScript), `async fn` / `.await` (Rust), `suspend` (Kotlin).

## Cheatsheet

| Write | Where | Means |
| --- | --- | --- |
| `note async` | child of a `task` definition | this task is asynchronous |
| `wait true` | child of a `like task` type | the parameter or field is an async task |
| `wait true` | child of a `call` | force this call to be awaited here |
| `wait false` | child of a `call` | fire and forget (do not await) |
| (nothing) | a plain `call` to an async task | awaited automatically |

The rules in one breath:

- An async task is declared with `note async` as a child, alongside `take` and `like`.
- Calling an async task awaits it by default. You almost never write `wait`.
- `wait true` forces the await when the compiler cannot infer it (a value passed through a generic, a task stored in a field).
- `wait false` starts the work and moves on without waiting, returning the in-flight task.
- An async task returns its result type directly (`like text`), not a wrapped promise type. The async is in the `note`, not the return.

## Declaring an async task

`note async` sits with the other configuration children of a `task`, before the parameters and return type.

```tree
load @term/base/code/native/{platform}/file
  find read-file

task read
  note async
  take path, like text
  like text
  send back
    call read-file
      read path
```

`read` is async because it reaches the filesystem. Its return type is plain `text`. There is no promise type to spell.

## Calling is awaited by default

A call to an async task is awaited where it sits. The value you bind is the resolved value, never an in-flight task. The stdlib's own `read` in `@term/base/code/file` is the task above:

```tree
load @term/base/code/file
  find read
load @term/base/code/console
  find log

task show-file
  note async
  take path, like text
  like void
  save body
    call read
      read path
  call log
    read body
```

`save body` holds the resolved text. The await happened at the `call read`. This is the same code you would write for a synchronous read. The only difference is the `note async` on `show-file` itself, because it contains an awaited call.

## Forcing an await with `wait true`

When a task arrives through a parameter or a field, the compiler sees a `task` value, not a known async definition. Add `wait true` to the call to await it.

```tree
load @term/base/code/native/{platform}/mutex
  find do-lock

form mutex
  link dock, like mutex-handle

  task lock
    note async
    take self
    like void
    call do-lock
      read self
      wait true
```

Here `do-lock` is a native handle reached through `read self`, so the await is requested explicitly with `wait true`. The same applies when you accept a task as a parameter:

```tree
task run-twice
  note async
  take work
    like task
      wait true
      like text
  like text
  save first
    call work
      wait true
  save second
    call work
      wait true
  send back
    text <{{first}} {{second}}>
```

`work` is an async task passed in. The `wait true` under its `like task` is part of its type: it says the callback is async, so calling it is an async call. Each `call work` awaits it with `wait true` and binds the resolved text.

## Fire and forget with `wait false`

`wait false` starts the work and continues without waiting. Use it when you want a task to run in the background and you do not need its result inline.

```tree
load @term/base/code/file
  find append
load @term/base/code/console
  find log

task kick-off
  note async
  take path, like text
  like void
  call append
    read path
    text <started>
    wait false
  call log
    text <logging started, moving on>
```

`append` is started, but `kick-off` does not block on it. Control falls straight to the `log`.

## Running several at once

To run tasks concurrently and join them, spawn each and wait for all. The standard `task` library gives you `spawn` and `gather`.

```tree
load @term/base/code/task
  find gather
load @term/base/code/file
  find read

task read-all
  note async
  take paths
    like list
      like text
  like list
    like text
  save works
    make list
  walk list, read paths
    hook next
      take site, name path
      call works/push
        task work
          note async
          like text
          send back
            call read
              read path
  send back
    call gather
      read works
      wait true
```

Each `task work` closure is an async task that reads one path. `gather` runs them concurrently and returns the results in order. The outer `call gather` is awaited with `wait true`.

## Async tasks as types

A parameter or field that holds an async task spells the async in the nested `like task`, with `wait true`. On a type, `wait true` is the effect. On a definition, `note async` is.

```tree
form job
  link work
    like task
      wait true
      like text
```

The field `work` is an async task returning text. Construct it with a `task` closure carrying its own `note async`, and run it later with `call ... / wait true`.

## When to reach for which

- Defining a task that does IO or awaits inside: add `note async`.
- Calling a known async task: write the plain `call`. It is awaited for you.
- Calling a task held in a variable, parameter, or field: add `wait true`.
- Starting background work you will not await here: add `wait false`.

See also [native](native.md) for where async tasks come from (host APIs), [functions](functions.md) for task shape, and [errors](errors.md) for propagating failures out of an async call with `halt kink`.
