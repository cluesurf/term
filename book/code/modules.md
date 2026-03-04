# Modules

Import code with `load`. Select specific exports with `find`.
Native libraries use `dock`.

## Import a Module (`load`)

Import by package path:

```tree
load @cluesurf/base/code/base/form/maybe
```

Import by relative path:

```tree
load ./helpers
load ./types/user
```

## Selective Import (`find`)

Import only specific names:

```tree
load @cluesurf/base/code/base/form/list
  find list
  find push
```

With optional type hint:

```tree
load @cluesurf/base/code/base/form/list
  find list, like form
  find push, like task
```

With a local alias:

```tree
load @cluesurf/base/code/base/form/list
  find push, like task
    name push-list
```

Without `find`, everything from the module is imported.

## Dynamic Export (`bear`)

Export platform-specific implementations:

```tree
bear <./{base/host/dock}>
```

This resolves to different files based on the target platform
(javascript, rust, swift, etc.).

## Native Libraries (`dock`)

Import native platform libraries:

```tree
dock load
  load <node:fs>, name fs
```

```tree
dock load
  load <std:fs>, name fs
```

Then call native functions:

```tree
call fs/read-file-sync
  bind path, read path
  bind encoding, text <utf8>
```

## Visibility

`hide` makes a definition private:

```tree
task helper
  hide true
  send back, mark 0
```

Everything is public by default.

## Namespaces (`book`)

Group definitions under a namespace:

```tree
book math
  task add
    take a, like u64
    take b, like u64
    like u64
```
