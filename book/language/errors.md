# Errors

An error in Term is an **exception**: a `form` that is `like exception`, or like one of the seventeen the standard library declares. You raise one with `halt <form>`, pass a callee's exception on with `halt kink`, and catch with a `note unsafe` body and a `halt take` handler. The compiler knows every exception a task can raise, and `term roll exception` lists them for the whole build.

Maps to: throwing and catching exceptions, with the raise set inferred the way checked exceptions would be declared.

## Cheatsheet

| Construct | Where | Does |
| --- | --- | --- |
| `halt excess` + `bind ...` | a statement | raise a stdlib exception, filling its props |
| `halt my-form` + `bind ...` | a statement | raise your own exception |
| `halt <message>` | a statement | raise `failure` with the message as its `thing` |
| `halt <form>, read e` | a statement | re-raise an exception value already in hand |
| `halt kink` | child of a `call` | pass the callee's exception on to the caller |
| `note unsafe` + body | a statement | guard the body: what it raises is caught |
| `halt take` + `take e` + body | right after the guard | the handler, with the caught value bound to `e` |
| `form x` + `like excess` | top level | declare an exception under one of the seventeen |
| `bind note, <text>` | under the `like` | pin the internal sentence |
| `bind thing, <text>` | under the `like` | pin a prop |
| `link p, like T` | under the `like` | add a prop |
| `halt excess` (no children) | in a task signature | bound the task's raise set |
| `term roll exception` | the shell | every exception in the build, and who raises it |

## The seventeen

Every exception is named for the **failure**, as a noun. The thing it happened to is a prop called `thing`. The standard library declares seventeen, and most code never declares another:

| reader does | form | props beyond `thing` |
| --- | --- | --- |
| fix the input | `defect` | `value`, `expected` |
| | `omission` | |
| | `excess` | `limit`, `actual` |
| | `shortage` | `limit`, `actual` |
| | `mismatch` | `expected`, `actual` |
| | `exclusion` | `value`, `accepted` |
| pick a different thing | `absence` | |
| | `conflict` | `current` |
| | `refusal` | `reason` |
| get permission | `anonymity` | |
| | `denial` | |
| try again | `overload` | `retry-after` |
| | `outage` | `retry-after` |
| | `timeout` | `waited` |
| | `overage` | `limit`, `retry-after` |
| do nothing | `failure` | |
| several at once | `bundle` | `list` |

Load the ones you raise from `@term/seed/code/exception`.

## Raising

`halt` names the form and binds its props. `thing` says what the failure is about.

```tree
load @term/seed/code/exception
  find excess
  find absence

task store
  take size, like number
  like number
  fork test
    hook test
      call is-above
        read size
        code 5
    hook hold
      halt excess
        bind thing, text <upload>
        bind limit, code 5
        bind actual, read size
  send back, read size
```

A prop declared with `need false` may be left out. One declared with `fall <value>` takes that value when left out. The compiler fills `host` (the deck), `form` (the name), `code` (an occurrence id in the 8x4 tone shape, what a person quotes) and `time`.

A bare `halt <text>` raises `failure` with the text as its `thing`. It is what an unexpected condition says, and it is always private.

## Declaring your own

When a deck has more to say than the seventeen, it declares a form `like` one of them. The new form inherits everything, restates the `note`, may pin a prop, and may add props.

```tree
form upload-excess
  like excess
    bind note, <Upload too large>
    bind thing, <upload>
    link policy, like text
```

`upload-excess` is an `excess`: a handler arm for `excess` catches it, and a route answering with it answers the way `excess` does. `thing` is pinned, so a `halt upload-excess` gives only `limit`, `actual` and `policy`, and giving `thing` or `note` is a build error.

```tree
halt upload-excess
  bind limit, code 5
  bind actual, read size
  bind policy, text <avatar>
```

Name the failure with the qualifier in front: `upload-excess`, `slug-conflict`, `user-absence`. Never `file-too-large`, and never an `-error` suffix, because the value already is an exception.

## Passing it on

`halt kink` as a child of a `call` says: if this call raises, let it through to my caller. The raise set of `process-file` below is the union of what `read-file` and `parse` raise.

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

## Catching

`note unsafe` over a body guards it. The `halt take` that follows is the handler, and its `take` names the caught value, an `exception` with `form`, `note`, `code`, `link` (the props) and `base` (the cause, if any).

```tree
task lookup
  take key, like text
  like text
  note unsafe
    save found
      call find-user
        read key
    send back
      text <found>
  halt take
    take problem
    send back
      read problem/note
```

A guarded body's raises leave the task's raise set. Whatever the handler raises comes back in. A guard with no handler catches everything and says nothing, which a lint will flag.

## Bounding the set

A task may declare what it raises with bare `halt` lines in its signature. The compiler already infers the set, so the declaration is a contract: the inferred set must fit inside it, or the build fails where the change was made rather than in every caller.

```tree
task store
  take path, like text
  like size
  halt excess
  halt absence
```

Declare it on the public surface of a library. Never on internal tasks.

## The roll

```
term roll exception
```

prints every exception in the build with its deck, its base among the seventeen, its `note`, its props, where it is declared, whether the app has told it (see below), and which routes can answer with it. `term roll task` prints every public task with its raise set. `term make` writes the same data to `host/roll.json`.

## Telling the customer

A library declares what it raises. **The app decides what a person is told.** In `code/tell.tree`:

```tree
tell @term/site/upload-excess
  note <File too large>
  hint <This upload is larger than the limit for its kind.>
  link limit
  link actual
```

Absent means private. A `tell` for an exception nothing in the app can raise is a build error, so the table cannot go stale. `note` and `hint` are static, and the props named by `link` ride along on the wire for the client to format.

## The hive

Every exception, tell and deck in the build wakes into the runtime **hive** at boot, and every raise is told to it. Read the roster with `hive-roll`, subscribe with `hive-hear`.

```tree
load @term/seed/code/hive
  find hive-roll
  find hive-hear

task watch
  call hive-hear
    text <exception>
    task report
      take entry, like hive-entry
      call info, read entry/name
```

## See also

- [functions](functions.md) for named arguments and `fall` defaults, which props share.
- [structures](structures.md) for `slot` fields and extending a form with `like`.
- [matching](matching.md) for `fork case` over `result` and `maybe`, the value-level alternative.
