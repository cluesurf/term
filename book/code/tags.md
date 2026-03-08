# Tags

Annotate declarations with `mark` to attach metadata. Tags are
structured annotations on forms, tasks, and links.

## Stability (`mark stable`)

Mark a declaration as stable with a version:

```tree
form allocator
  mark stable
    bind version, <1.28.0>
    bind feature, term global-allocator
```

The `bind version` is the version when the feature was stabilized. The
`bind feature` names the feature gate.

On a link (field):

```tree
form config
  link timeout
    mark stable
      bind version, <1.0.0>
      bind feature, term config-timeout
```

On a task (function):

```tree
task allocate
  mark stable
    bind version, <2.1.0>
    bind feature, term custom-allocator
  take size, like size
  like pointer
```

## Unstable (`mark unstable`)

Mark a declaration as unstable (experimental, may change):

```tree
task handle-alloc-error
  mark unstable
    bind feature, term alloc-error-handler
    bind issue, 51540
```

Fields:
- `bind feature, term <name>` - feature gate name (required)
- `bind issue, <number>` - tracking issue number (optional)
- `bind hint, <text>` - explanation of why it is unstable (optional)

Full example:

```tree
form error-handler
  mark unstable
    bind feature, term alloc-error-handler
    bind issue, 51540
    bind hint, <API design not finalized>
```

## Deprecation (`mark deprecated`)

Mark a declaration as deprecated:

```tree
task old-function
  mark deprecated
    bind version, <5.2.0>
    bind hint, <Use new-function instead>
    bind call, term new-function
```

Fields:
- `bind version, <text>` - version when it was deprecated (optional)
- `bind hint, <text>` - explanation or migration guidance (optional)
- `bind call, term <name>` - suggested replacement function (optional)

Minimal deprecation:

```tree
task legacy-parse
  mark deprecated
```

With just a version:

```tree
task old-read
  mark deprecated
    bind version, <3.0.0>
```

With a replacement suggestion:

```tree
task old-write
  mark deprecated
    bind version, <3.0.0>
    bind hint, <Replaced by buffered write>
    bind call, term write-buffered
```

## Private (`mark private`)

Mark a declaration as private. Replaces the old `hide true` syntax.
Everything is public by default in Seed.

On a task:

```tree
task internal-helper
  mark private
  send back, mark 0
```

On a form:

```tree
form internal-state
  mark private
  link buffer, like list
```

On a link (field):

```tree
form list
  link data
    mark private
```

On a package manifest (prevents publishing):

```tree
deck @cluesurf/term-call
  mark private
  mark <0.0.1>
```

## Async (`mark async`)

Mark a task as async or await a call result. Replaces the old
`wait true` syntax.

On a task definition:

```tree
task fetch-data
  mark async
  take url, like text
  save response
    call fetch-url
      bind url, read url
      mark async
  send back, read response
```

The `mark async` on `call` awaits the result.

## Unsafe (`mark unsafe`)

Mark a task or call as unsafe. Replaces the old `risk true` syntax.
Used when the compiler cannot guarantee safety.

On a task:

```tree
task unchecked-add
  mark unsafe
  take a, like u64
  take b, like u64
  send back
    call add
      bind a, read a
      bind b, read b
```

On a call:

```tree
call some-ffi-function
  mark unsafe
  bind ptr, read ptr
```

## Native (`mark native`)

Mark a load statement as importing a native platform module. Replaces
the old `host true` syntax. Tells the compiler this is a platform
library, not a Seed package.

```tree
load <node:fs>, name fs
  mark native

load <node:path>, name path
  mark native
```

For Rust targets:

```tree
load <std:fs>, name std-fs
  mark native
```

The compiler resolves the module name to the correct import for each
backend (e.g., `require('node:fs')` for Node.js, `use std::fs` for
Rust).

## Feature Gate (`mark feature`)

Gate a declaration behind a feature flag. Similar to Rust's
`#![feature(...)]`. The declaration is only available when the named
feature is enabled.

```tree
task experimental-alloc
  mark feature, name custom-allocator
  take size, like size
  like pointer
```

Enable a feature in a package manifest:

```tree
deck @cluesurf/my-app
  mark feature, name custom-allocator
```

On a form:

```tree
form async-iterator
  mark feature, name async-iteration
  head t
```

## Platform (`mark platform`)

Mark a declaration as platform-specific. Similar to Rust's
`#[cfg(target_os)]`. The declaration is only compiled for the named
platform.

```tree
task read-registry
  mark platform, name windows
  take key, like text
  like text
```

```tree
task read-keychain
  mark platform, name macos
  take service, like text
  like text
```

Multiple platform targets:

```tree
task use-kqueue
  mark platform, name macos
  mark platform, name freebsd
```

On a form:

```tree
form epoll-handle
  mark platform, name linux
  link fd, like i32
```

## Keep (`mark keep`)

Suppress compiler warnings for a declaration. Similar to Rust's
`#[allow(dead_code)]`. Tells the compiler not to warn about unused
or seemingly dead declarations.

```tree
task reserved-for-future
  mark keep
  send back, mark 0
```

On a form:

```tree
form placeholder
  mark keep
  link reserved, like u64
```

Useful for declarations that are intentionally unused now but planned
for future use, or for generated code that the compiler cannot
statically verify as reachable.

## Combined Example

A form with stability tags on itself, its links, and its tasks:

```tree
form x
  mark stable
    bind version, <1>
    bind feature, term example

  link foo
    mark stable
      bind version, <1.28.0>
      bind feature, term global-allocator

  task bar
    mark stable
      bind version, <2.1>
      bind feature, term something-else
```

## Multiple Tags

A declaration can have multiple marks:

```tree
task experimental-fast-alloc
  mark unstable
    bind feature, term fast-alloc
    bind issue, 99001
  note <Experimental allocator with O(1) allocation>
```

## Tag Summary

| Tag | Purpose | Key fields |
| --- | --- | --- |
| `mark stable` | Stable public API | `bind version`, `bind feature` |
| `mark unstable` | Experimental API | `bind feature`, `bind issue`, `bind hint` |
| `mark deprecated` | Deprecated API | `bind version` (since), `bind hint`, `bind call` |
| `mark private` | Private visibility | (none) |
| `mark async` | Async task or call | (none) |
| `mark unsafe` | Unsafe operations | (none) |
| `mark native` | Native module import | (none) |
| `mark feature` | Feature gate | `name <feature-name>` |
| `mark platform` | Platform-specific | `name <platform-name>` |
| `mark keep` | Suppress warnings | (none) |

## Comparison with Rust

| Rust | Seed |
| --- | --- |
| `#[stable(feature = "foo", since = "1.0")]` | `mark stable` + `bind version, <1.0>` + `bind feature, term foo` |
| `#[unstable(feature = "bar", issue = "123")]` | `mark unstable` + `bind feature, term bar` + `bind issue, 123` |
| `#[deprecated(since = "2.0", note = "use baz")]` | `mark deprecated` + `bind version, <2.0>` + `bind hint, <use baz>` |
| `#[deprecated(suggestion = "baz")]` | `mark deprecated` + `bind call, term baz` |
| `pub` / `pub(crate)` (default) | default public / `mark private` |
| `async fn` | `mark async` on task |
| `unsafe fn` / `unsafe { }` | `mark unsafe` on task or call |
| `extern crate` / `use std::` | `mark native` on load |
| `#![feature(...)]` | `mark feature, name <x>` |
| `#[cfg(target_os = "linux")]` | `mark platform, name linux` |
| `#[allow(dead_code)]` | `mark keep` |
