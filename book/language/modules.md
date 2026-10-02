# Modules

Code is organized into files and packages. Bring names in with `load`, and pick which names with `find`. Paths are either a package (`@scope/pkg/...`) or a relative file (`./foo`). Visibility is public by default. Write `mark private` on a task to keep it in its file. Native host modules use `dock`, covered in [native](native.md).

Maps to: `import` / `export`, plus a package manifest like `Cargo.toml` or `package.json`.

## Cheatsheet

| Head | Job |
| --- | --- |
| `load <path>` | import a module |
| `find <name>` | name a specific export to import (use inside a `load`) |
| `find <name>, name <alias>` | import under a local alias |
| `bear <path>` | re-export a module's contents |
| `dock load <native>` | import a host module (see [native](native.md)) |
| `mark private` | keep a task inside its file |

Inside a `load`, use `find` to select names. Never use `take` there. `take` is for function parameters only.

## Importing

A `load` with indented `find` lines brings in the named exports.

```tree
load @term/base/code/list
  find list

load @term/base/code/maybe
  find maybe
  find unwrap-or
```

Import under a different local name with `name`.

```tree
load @term/base/code/list
  find list, name array
```

A `load` with no `find` children imports the module's public names as a group.

```tree
load ./helpers
```

## Import paths

A path is either a package path or a relative path.

| Form | Resolves to |
| --- | --- |
| `@term/base/code/list` | the `list` module in the `@term/base` package |
| `./helpers` | `helpers.tree`, then `helpers/base.tree` |
| `./types/user` | `types/user.tree`, then `types/user/base.tree` |

A bare path with no extension resolves by trying the flat file first, then a folder with a `base.tree` inside it. So `./foo/bar` looks for `foo/bar.tree`, and if that is absent, `foo/bar/base.tree`. Prefer the flat `foo.tree` for a module with no submodules, and promote it to `foo/base.tree` only once it grows children.

## Package layout

A package is a folder with a `deck.tree` manifest at its root. The convention is `code/` for source, `book/` for docs, and `test/` for tests.

```
my-lib/
  deck.tree          # package manifest
  code/
    base.tree        # the package entry
    helpers.tree
  book/
    readme.md
  test/
    base.tree
```

The manifest names the package, its version, license, source and test folders, and dependencies.

```tree
deck @cluesurf/my-lib
  head <A small library>
  code <0.0.2>
  lock apache-2
  bear ./code
  test ./test

  link @term/base, code <0.0.x>
```

The version is `code <...>`, on the package and on each `link`. Publishing convention: use an even patch number for a release version.

## Visibility

Every definition is public by default. Add `mark private` to a task to keep it inside its file.

```tree
task helper
  mark private
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2
```

A private task is callable from its own file and nowhere else. The build refuses each of these from any other file as `private-name`, naming the file that defines it:

- a call to it, by its name
- a reference to it as a value
- a `find` of it under a `load`

The rule follows bindings, not spelling. A parameter or a `save` in another file that happens to share the private task's name is its own name and is not refused. A call that may bind to a public definition of the same name, such as a public overload, is not refused either.

One exception: a file under the package's `test/` directory may use a private task of that package, so an internal helper can be tested directly.

`note private` is the old spelling. It is still honored, and it warns (`note-private`) with a hint to write `mark private`.

## Re-exports

`bear` re-exports another module's contents from the current file, so a single entry point can gather many submodules. This is how the standard library's group modules collect their parts.

```tree
bear ./addition
bear ./comparison
bear ./iteration
```

Importing the file that holds these `bear` lines gives access to everything they re-export, without naming each submodule at the call site.

## A complete two-file example

```tree
# math.tree
task square
  take n, like number
  like number
  send back
    call multiply
      read n
      read n

task cube
  mark private
  take n, like number
  like number
  send back
    call multiply
      read n
      call square, read n
```

```tree fragment
# app.tree, beside math.tree
load ./math
  find square
load @term/base/code/console
  find log

save area
  call square, code 5
call log
  text <{{area}}>
```

`app.tree` can import `square` but not `cube`, since `cube` is `mark private`. A `find cube` or a `call cube` in `app.tree` fails the build. Note there is no `main` task. The module body runs top to bottom.

## See also

- [native](native.md) for `dock` and calling host platform APIs.
- [functions](functions.md) for `task` and `send back`.
- [structures](structures.md) for the `form` types a module exports.
- [conventions](conventions.md) for file naming and folder layout.
