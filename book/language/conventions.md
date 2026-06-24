# Conventions

Term reads the same everywhere because it follows a few firm habits: short common words for every head and verb, kebab-case names with no filler, one module per file, and a fixed place for types, traits, and platform code. This page is the style guide. Follow it and your code will look like the standard library.

Maps to: a style guide / a linter config (the rules `term lint` and `term form` enforce).

## Cheatsheet

| Rule | Do | Do not |
| --- | --- | --- |
| Heads and verbs | short common words, ideally four letters | invented or long words |
| Task names | a plain verb: `read`, `send`, `make` | a noun, or a module prefix |
| Task namespacing | none, the path is the namespace | `task command-make` |
| Form names | specific, kebab-case | `form variable` for an env var |
| Form namespacing | allowed: `command-flag`, `command-argument` | ambiguous bare names |
| Suffixes | none | `-schema`, `-info`, `-data`, `-config` |
| Files and folders | kebab-case `.tree` | camelCase, spaces |
| One module | one `.tree` file | a folder of one file |
| Types | `code/<x>.tree` | scattered |
| Traits | `code/mask/<x>.tree` | mixed with types |
| Platform code | `code/native/<platform>/<x>.tree` | inline per-platform branches |

## Names

Use short, common English words. `read`, not `getContents`. `send`, not `transmitMessage`. Four letters is the sweet spot. Never abbreviate: `make-dir`, not `mkdir`. `remove`, not `rm`.

A task name is a verb, and only a verb. It is never prefixed by its module, because the path already gives the namespace.

```tree
# in code/file.tree
task read        # called as file/read, so the name is just `read`
  take path, like text
  like text
```

`task command-make` is wrong. The file it lives in supplies `command`. Write `task make`.

A form name is a noun, specific and unambiguous. `form environment-variable`, not `form variable`. Forms **may** be namespaced with a kebab prefix when several relate, which keeps them distinct without a wrapper type.

```tree
form command
  link name, like text

form command-flag
  link name, like text
  link short, like text

form command-argument
  link name, like text
  link required, like boolean
```

No redundant suffix carries weight. `form command`, never `form command-schema`. Drop `-info`, `-data`, `-config`. The name should say what the thing is, not that it is data.

## Verb vocabulary

Pick the verb from a small shared set so the same idea reads the same across modules.

| Action | Words |
| --- | --- |
| Create | `open`, `make`, `start` |
| Destroy | `close`, `stop`, `drop` |
| Read | `read`, `load`, `list`, `find` |
| Write | `write`, `save`, `send` |
| Convert | `cast`, `turn`, `form` |
| Check | `test`, `is`, `has` |
| Wait | `wait`, `poll`, `watch` |

Nouns are types, verbs are functions. `read` takes the value it acts on as its first argument. You write `call read, read file`, never a method on the value.

## Casing in identifiers

- Identifiers in source are kebab-case: `read-file`, `environment-variable`, `command-flag`.
- The compiler maps kebab to each backend's idiom. `read-file` becomes `readFile` on Node, `read_file` in Rust.
- Reaching into a host module keeps kebab and maps the same way: `call fs/read-file` lowers to `fs.readFile`.
- A constant declared with `host` is still kebab in source. `host max-size, code 1024`.

## File and folder layout

A module is a single `.tree` file. The file name is the module name. Prefer `foo.tree` over `foo/base.tree`. Only make a folder when a module has both its own code and submodules. Then `foo.tree` is the entry and `foo/bar.tree` is a submodule. The only `base.tree` that should exist is the package entry at `code/base.tree`.

Folders and files are kebab-case. The standard library is laid out so the kind of a file is its location:

```
code/
  base.tree                 # package entry point
  boolean.tree              # a type lives directly in code/
  file.tree                 # the public, platform-free API
  mask/
    comparable.tree         # a trait (mask)
    addable.tree
  native/
    node/
      file.tree             # the Node implementation of file
    rust/
      file.tree             # the Rust implementation
    browser/
      file.tree
    shared/
      sort.tree             # cross-platform algorithm, no host calls
```

- Types go directly in `code/`.
- Traits (`mask`) go in `code/mask/`.
- Platform implementations go in `code/native/<platform>/`.
- Host-free shared algorithms go in `code/native/shared/`.

See [native](native.md) for how the public file and the per-platform files fit together.

## Import path resolution

A `load` names a package and a path inside it. Use `find` (never `take`) to pull names out of a load.

```tree
load @cluesurf/base/code/file
  find read
  find write
```

A path without an extension resolves in order: `name.tree`, then `name/base.tree`. For a bare package root it tries `note.tree` first, then `base.tree`. Prefer the flat `name.tree` form so resolution is unambiguous.

When three or more imports share a prefix, nest them. For one or two, keep them flat.

```tree
load @cluesurf/base/code/code
  load /head, find head
  load /like, find like
```

A path ends at the module. Never append `/index`, and never write a `.js` or `.tree` extension in a `load`.

## Functions and shape

- One obvious way to do each thing. No overloading, no optional parameters that change behavior.
- A function with two or more parameters takes a single object input, not a long positional list. A variant is a parameter, not a separate function. `seek(file, offset, frame: relative)`, not `seek-relative`.
- Public names stay clean. Internal dispatch lives in `note private` helpers.
- If it touches IO, it is async (`note async`). Pure computation is synchronous.

## Ordering inside a term

The parser accepts any child order. For readability, lead with configuration, then structure, then body.

A task: marks, then type parameters (`head`), then parameters (`take`), then return type (`like`), then body.

```tree
task get-name
  note private
  note async
  head t
  take user, like t
  like text
  send back
    read user/name
```

A form: marks, then type parameters, then alias, then fields (`link`), then variants (`case`), then methods (`task`).

```tree
form user
  head t
  link name, like text
  link age, like number
  case admin
    link role, like text
```

## Anti-patterns

- No builder pattern for required fields. Put them in the constructor (`make` with `bind`).
- No stringly-typed options. Use a sum type (`form` with `case`).
- No implicit global state. Pass dependencies explicitly.
- No god objects. A type with five tasks, not a class with forty methods.
- No wrapping a host API just to wrap it. Abstract only to unify platforms or fix a bad interface.

See also [structures](structures.md), [modules](modules.md), and [debugging](debugging.md) for `term lint` and `term form`.
