# Packages

Define a package manifest with `deck`. This goes in a `deck.tree` file
at the root of your package.

## Package Manifest

```tree
deck @cluesurf/base
  mark <0.3.1>
  head <Standard library for Seed>
  mind <Lance Pollard>
  lock apache-2
  sort tool
  term compiler
  term language
```

## Fields

### Metadata

| Keyword | Role          | Example                             |
| ------- | ------------- | ----------------------------------- |
| `deck`  | Package name  | `deck @cluesurf/base`               |
| `mark`  | Version       | `mark <0.3.1>`                      |
| `head`  | Description   | `head <A standard library>`         |
| `lock`  | License       | `lock apache-2`                     |
| `sort`  | Category      | `sort tool`                         |
| `term`  | Tag           | `term compiler`                     |
| `site`  | Homepage URL  | `site <https://github.com/cluesurf/seed>` |
| `view`  | Preview image | `view ./view/tree.gif`              |
| `hide`  | Private flag  | `hide true`                         |

- **`hide true`** marks the package as private. It will not be published
  to any registry. Useful for internal sub-packages or applications.

### Directory Pointers

| Keyword | Role              | Example            |
| ------- | ----------------- | ------------------ |
| `task`  | Task loader       | `task ./task`      |
| `book`  | Documentation     | `book ./book`      |
| `role`  | Vocabulary roles  | `role ./role`      |
| `call`  | CLI entry point   | `call ./call`      |
| `deck`  | Sub-packages (locally)      | `deck ./deck/load` |

- **`book`** points to the documentation folder. Files here are parsed
  with the `book` mill vocabulary (see `vocabularies.md`).
- **`call`** points to CLI interface definitions that declare commands,
  flags, and arguments.
- **`call`** points to the CLI entry point that implements the command
  handlers. Used by executable sub-packages (e.g., `sort call`).
- **`role`** points to the role file that maps file patterns to mill
  vocabularies (see `vocabularies.md`).
- **`task`** points to the task loader configuration.
- **`deck`** (as a child) declares sub-packages within the package.

### Authors

Use `mind` for authors. Each author can have an email (`site` or
`base`) and a website (`site` as a child).

```tree
deck @cluesurf/seed
  mind <Lance Pollard>, base <lp@elk.fm>
```

With a website:

```tree
deck @cluesurf/seed
  mind <Lance Pollard>, base <lp@elk.fm>
    site <lancejpollard.com>
```

Multiple authors:

```tree
deck @cluesurf/seed
  mind <Lance Pollard>, base <lp@elk.fm>
    site <lancejpollard.com>
  mind <Jane Doe>, base <jane@example.com>
```

### Dependencies

Use `link` to declare dependencies. The `mark` field specifies a
version range. The `site` field specifies an alternative source. The
`base` field specifies the source type.

#### Version Ranges (Registry)

```tree
link react, mark <^18>
link lodash, mark <^4>
link something, mark <~1.0.0>
link typescript, mark <5.4.2>
```

| Pattern   | Meaning                                    |
| --------- | ------------------------------------------ |
| `<5.4.2>`   | Exact version                              |
| `<^18>`     | Compatible with 18 (any 18.x.x)            |
| `<^4>`      | Compatible with 4 (any 4.x.x)              |
| `<~1.0.0>`  | Approximately 1.0.0 (any 1.0.x)            |
| `<1.2.x>` | Any patch in 1.2                            |
| `<1.x.x>` | Any minor/patch in 1                        |
| `<*>`       | Any version                                |

#### Workspace

Link to a package in the same workspace.

```tree
link @scope/pkg, mark <*>
  base workspace
```

#### Local Folder

Link to a package by filesystem path.

```tree
link my-lib, site ../my-lib
  base folder
```

#### Sibling Sub-Package

Link to a sibling sub-package within the same deck using a relative
path. No `base` field needed.

```tree
link ../load
```

#### GitHub

Link to a GitHub repository. Supports branch, tag, or commit hash.

```tree
link my-lib, site <user/my-lib>
  base github

link seed-lang, site <github:user/seed#main>
link seed-lang, site <github:user/seed#v1.2.3>
link seed-lang, site <github:user/seed#commit-hash>
```

#### Git

Link to a git repository by URL. Use `#commit-ish` to pin to a branch,
tag, or commit.

```tree
link seed-lang, site <https://github.com/user/seed.git>
  base git

link seed-lang, site <git@github.com/user/seed.git>
  base git-ssh

link seed-lang, site <git://github.com/user/project.git#commit-ish>
```

#### npm Alias

Install under a different name.

```tree
link my-lib2, mark npm:my-lib
```

#### Tarball URL

Link to a package tarball directly.

```tree
link seed-lang, site <https://example.com/seed.tgz>
```

#### Custom Registry

Use `host` to group dependencies from a non-default registry.

```tree
deck @cluesurf/base
  host <https://npm.pkg.github.com>
    link @cluesurf/seal, mark <0.0.x>
    link @cluesurf/cone, mark <0.0.x>
    link @cluesurf/buzz, mark <0.0.x>
    link @cluesurf/crow, mark <0.0.x>
```

Dependencies outside a `host` block default to
`https://registry.npmjs.org`.

#### Dev Dependencies

Use `case work` to group development-only dependencies. These are
installed during development but not included when the package is used
as a dependency.

```tree
deck @cluesurf/my-app
  link @cluesurf/base, mark <0.0.x>

  case work
    link @cluesurf/buzz, mark <0.0.x>
    link @cluesurf/crow, mark <0.0.x>
```

#### Summary

| Source | Syntax |
| --- | --- |
| Registry (default) | `link foo, mark ^1.0.0` |
| Workspace | `link foo, mark *` + `base workspace` |
| Local folder | `link foo, site ../path` + `base folder` |
| Sibling sub-package | `link ../load` |
| GitHub shorthand | `link foo, site <user/repo>` + `base github` |
| GitHub with ref | `link foo, site <github:user/repo#ref>` |
| Git HTTPS | `link foo, site <https://...git>` + `base git` |
| Git SSH | `link foo, site <git@...git>` + `base git-ssh` |
| Git protocol | `link foo, site <git://...git#ref>` |
| npm alias | `link foo, mark npm:other-name` |
| Tarball URL | `link foo, site <https://...tgz>` |

## Full Example

```tree
deck @cluesurf/base
  head <A TreeCode Framework>

  mark <0.0.1>
  sort tool

  lock apache-2

  site <https://github.com/cluesurf/base>
  view ./view/tree.gif

  term tree-code
  term computation
  term information
  term philosophy
  term platform
  term white-label
  term compiler

  deck ./deck/load
  deck ./deck/call

  # defaults to https://registry.npmjs.org registry
  link @cluesurf/bind, mark <0.0.x>
  link @cluesurf/moon, mark <0.0.x>
  link @cluesurf/bead, mark <0.0.x>
  link @cluesurf/chew, mark <0.0.x>
  link @cluesurf/move, mark <0.0.x>
  link @cluesurf/base, site <git://github.com/user/project.git#commit-ish>

  # use a custom registry
  host <https://npm.pkg.github.com>
    link @cluesurf/seal, mark <0.0.x>
    link @cluesurf/cone, mark <0.0.x>
    link @cluesurf/buzz, mark <0.0.x>
    link @cluesurf/crow, mark <0.0.x>

  case work
    link @cluesurf/buzz, mark <0.0.x>
    link @cluesurf/crow, mark <0.0.x>

    host <https://npm.pkg.github.com>
      link @cluesurf/seal, mark <0.0.x>
      link @cluesurf/cone, mark <0.0.x>

  task ./task
  book ./book
  role ./role
  call ./call

  mind <Lance Pollard>, base <lp@elk.fm>
```

## Sub-Package Example

A sub-package is a child deck within a parent package. Use `hide true`
to keep it private. Use `sort call` for CLI packages. Use `call` to
point to the command handler directory.

```tree
deck @cluesurf/term-call
  mark <0.0.1>
  sort call
  lock apache-2
  hide true

  head <A TreeCode Framework CLI>

  link @cluesurf/term, mark <0.0.x>
  link @cluesurf/bind, mark <0.0.x>
  link @cluesurf/moon, mark <0.0.x>
  link @cluesurf/cone, mark <0.0.x>
  link ../load

  call ./call

  case work
    link @cluesurf/buzz, mark <0.0.x>
    link @cluesurf/crow, mark <0.0.x>

  mind <Lance Pollard>, base <lp@elk.fm>
```

Key differences from a library package:
- **`hide true`** prevents publishing to a registry.
- **`sort call`** marks this as a CLI package.
- **`call ./call`** points to the command handler entry point.
- **`link ../load`** references a sibling sub-package by relative path.
- **`case work`** groups dev-only dependencies.
- No `book`, `role`, or `call` since this is an internal implementation
  package.

## Version Ranges

| Pattern   | Meaning              |
| --------- | -------------------- |
| `<1.2.3>` | Exact version        |
| `<1.2.x>` | Any patch in 1.2     |
| `<1.x.x>` | Any minor/patch in 1 |

## Project Structure

Library:

```
my-lib/
  deck.tree          # package manifest
  code/
    base.tree        # main entry
    helpers.tree
  book/
    base.tree        # documentation
  test/
    base.tree
```

Application:

```
my-app/
  deck.tree
  code/
    base.tree
  call/
    base.tree        # CLI definitions
  test/
    base.tree
```

## Native Platform Imports

Import native (host) libraries with `host true` on a load statement:

```tree
load <node:fs>, name fs
  host true

load <node:path>, name path
  host true
```

Then call functions on them:

```tree
task read-file
  take path, like text
  like text
  save content
    call fs/read-file-sync
      bind path, read path
      bind encoding, text <utf8>
  send back, read content
```

For Rust targets:

```tree
load <std:fs>, name std-fs
  host true
```

The `host true` flag distinguishes native platform modules from Seed
packages. The compiler resolves the module name to the correct import
for each backend (e.g., `require('node:fs')` for Node.js,
`use std::fs` for Rust).

## Other Notes

- default `role` folder is `./role`
- default `book` folder is `./book`
