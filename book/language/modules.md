# Modules

Code is organized into files and packages. Bring names in with `load`, and pick which names with `find`. Paths are either a package (`@scope/pkg/...`) or a relative file (`./foo`). Visibility is public by default. Mark something `private` to keep it in its file. Native host modules use `dock`, covered in [native](native.md).

Maps to: `import` / `export`, plus a package manifest like `Cargo.toml` or `package.json`.

## Cheatsheet

| Head | Job |
| --- | --- |
| `load <path>` | import a module |
| `find <name>` | name a specific export to import (use inside a `load`) |
| `find <name>, name <alias>` | import under a local alias |
| `bear <path>` | re-export a module's contents |
| `dock load <native>` | import a host module (see [native](native.md)) |
| `note private` | keep a definition inside its file |

Inside a `load`, use `find` to select names. Never use `take` there. `take` is for function parameters only.

## Importing

A `load` with indented `find` lines brings in the named exports.

```tree
load @cluesurf/seed/code/list
  find list

load @cluesurf/seed/code/maybe
  find maybe
  find unwrap-or
```

Import under a different local name with `name`.

```tree
load @cluesurf/seed/code/list
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
| `@cluesurf/seed/code/list` | the `list` module in the `@cluesurf/seed` package |
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

The manifest names the package, its version, license, and dependencies.

```tree
deck @cluesurf/my-lib
  head <A small library>
  mark <0.0.1>
  lock apache-2

  link @cluesurf/seed, mark <0.0.x>

  book ./book
  task ./task
```

Publishing convention: use an even patch number for a release version.

## Visibility

Every definition is public by default. Add `note private` to keep it inside its file.

```tree
task helper
  note private
  take n, like number
  like number
  send back
    call multiply, read n, code 2
```

A private name is callable from its own module but is not importable by `find` elsewhere.

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
    call multiply, read n, read n

task cube
  note private
  take n, like number
  like number
  send back
    call multiply, read n
      call square, read n
```

```tree
# app.tree
load ./math
  find square

call write-line
  call square, code 5
```

`app.tree` can import `square` but not `cube`, since `cube` is `private`. Note there is no `main` task. The module body runs top to bottom.

## See also

- [native](native.md) for `dock` and calling host platform APIs.
- [functions](functions.md) for `task` and `send back`.
- [structures](structures.md) for the `form` types a module exports.
- [conventions](conventions.md) for file naming and folder layout.
