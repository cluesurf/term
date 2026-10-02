# Native

Term runs on several hosts: Node.js, the browser, Rust, Kotlin, Swift. A `dock` block loads a real host module so you can call its functions directly. When a capability differs per platform, you write one public task and a small native file per host. The compiler picks the right one at build time. Your callers never see the seam.

Maps to: FFI / platform bindings, `import` of a host module, conditional compilation per target.

## Cheatsheet

| Write | Means |
| --- | --- |
| `dock load` | open a native-module block |
| `load <node:fs/promises>, name fs` | bind host module `fs/promises` as `fs` |
| `load <global:json>, name json` | bind a global host object as `json` |
| `call fs/read-file` | call `readFile` on the bound module |
| `load @term/base/code/native/{platform}/file` | load the platform-dispatched native layer |
| `note async` | mark a native wrapper async (most host IO is) |
| `note native` | note that a task is backed by a host implementation |
| `note platform, name x` | note that a definition is meant for platform `x` |
| `note feature, name x` | note that a definition belongs to feature `x` |

Module address forms inside `dock load`:

| Form | Resolves to |
| --- | --- |
| `<node:fs/promises>` | a Node built-in or npm module |
| `<global:json>` | a host global (the runtime's JSON, Math, etc.) |
| `<browser:dom>` | a browser API surface |

A bound name is reached with `/`. `call fs/read-file` lowers to `fs.readFile(...)` on Node. Kebab in Term maps to the host's own casing.

## Calling a host API

Open a `dock load`, bind the module, then call through the bound name.

```tree
dock load
  load <node:fs/promises>, name fs
  load <node:fs>, name fssync

task read-file
  note async
  take path, like text
  like text
  send back
    call fs/read-file
      read path
      text <utf8>

task file-exists
  take path, like text
  like boolean
  send back
    call fssync/exists-sync
      read path
```

`fs/read-file` is `fs.readFile`. The string argument `text <utf8>` is passed straight through. `read-file` is `note async` because the host call returns a promise. `file-exists` is synchronous, so it carries no `note async`.

A globals example, binding the runtime's JSON:

```tree
dock load
  load <global:json>, name json

task do-parse
  take text, like text
  like dynamic
  send back
    call json/parse
      read text

task do-stringify
  take value, like dynamic
  like text
  send back
    call json/stringify
      read value
```

## The three-layer pattern

Capabilities that exist on every host (files, time, crypto) follow one shape so callers stay platform-free.

1. **Public task** in `code/<x>.tree`. The clean uniform API. It loads the native layer and forwards.
2. **Native wrapper** in `code/native/<platform>/<x>.tree`. One file per host, each `dock load`-ing that host's module.
3. **Runtime shim** in `code/native/<platform>/runtime/<x>.ext` when the host needs glue beyond a direct call.

The public file imports `@term/base/code/native/{platform}/<x>`, with the platform slot spelled as `{platform}`. The compiler fills the slot with the target it is building, so the public file never names a platform.

The public layer:

```tree
# code/file.tree
load @term/base/code/native/{platform}/file
  find read-file
  find write-file

task read
  note async
  take path, like text
  like text
  send back
    call read-file
      read path

task write
  note async
  take path, like text
  take data, like text
  send back
    call write-file
      read path
      read data
```

The Node native layer:

```tree
# code/native/node/file.tree
dock load
  load <node:fs/promises>, name fs

task read-file
  note async
  take path, like text
  like text
  send back
    call fs/read-file
      read path
      text <utf8>

task write-file
  note async
  take path, like text
  take data, like text
  send back
    call fs/write-file
      read path
      read data
```

A Rust native layer would live at `code/native/rust/file.tree`, expose the same `read-file` and `write-file` task names, and dock `std::fs` instead. Because every backend exports the same task names, the public file in step 1 is identical for all targets. A caller writes `call read, read path` and never knows which host answered.

## Per-platform notes

When a single definition is only meant for some hosts, say so with a `note`.

```tree
dock load
  load <node:fs>, name fs

task watch-folder
  note platform, name node
  take path, like text
  like void
  call fs/watch
    read path
```

`note platform, name node` records that `watch-folder` is meant for Node. It is metadata like every other `note`: the build does not drop the task on other targets. To keep a capability off a host, give it a native file per platform with the three-layer pattern above, so a target with no native file has nothing to resolve. `note feature, name x` records an optional feature the same way.

`note native` labels a task whose body is supplied by a host implementation rather than Term code. It pairs with the native wrapper that actually docks the module.

## Opaque host handles

A native module often returns a value Term should not inspect, only pass back. Hold it in a field typed as a handle, marked private.

```tree
load @term/base/code/native/{platform}/mutex
  find do-lock

form mutex
  link dock, like mutex-handle
    mark private

  task lock
    note async
    take self
    like void
    call do-lock
      read self
      wait true
```

`dock` carries the platform lock object. Term never reads inside it. It flows from `do-make` into the form and back into `do-lock`. Each backend types `mutex-handle` as its own lock. See [async](async.md) for `wait true`.

## When to reach for which

- One host, a quick host call: a single `dock load` plus tasks in one file.
- A capability on every host: the three-layer pattern, one public file and one native file per platform.
- One definition valid on some hosts only: a native file per host that has it, and a `note platform, name x` to say so where it is defined.

See also [modules](modules.md) for `load` and `find`, [async](async.md) for `note async` and `wait`, and [conventions](conventions.md) for the `code/native/<platform>/` layout.
