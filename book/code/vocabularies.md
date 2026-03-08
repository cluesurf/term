# Vocabularies

A vocabulary defines how `.tree` files are parsed. Different files in
a package use different term vocabularies depending on their purpose.

## The `role` Directive

The `role` directive in `deck.tree` maps file glob patterns to
vocabularies. It tells the package manager which parser rules to apply
to which files.

```
deck @cluesurf/seed
  role ./base/role
```

This points to a `role.tree` file that contains the vocabulary
assignments.

## Role File Structure

A role file loads the available vocabularies and assigns them to file
patterns using glob matching.

```
load @cluesurf/code
  find code
  find book

role book
  take ~/book/**/*.tree
    miss ~/book/**/{code,view}/**/*.tree

role code
  take ~/code/**/*.tree
  take ~/book/**/{code,view}/**/*.tree
```

### How It Works

Each `role` block names a vocabulary and lists file patterns.

- **`role book`** says: parse all files matching `~/book/**/*.tree`
  using the `book` vocabulary, but exclude files under `code/` or
  `view/` subdirectories within `book/`.
- **`role code`** says: parse all files matching `~/code/**/*.tree`
  using the `code` vocabulary. Also parse `code/` and `view/`
  subdirectories within `book/` as code (not documentation).

The `~` prefix refers to the package root.

### `take` and `miss`

| Keyword | Meaning |
| --- | --- |
| `take` | Include files matching this glob pattern |
| `miss` | Exclude files matching this glob pattern from the parent `take` |

A `miss` is always a child of a `take`. It carves out exceptions from
the include set.

## Roles Are Mills

Each `role` name refers to a `mill`. A mill is a declarative
transformer that converts generic Tree AST into typed AST nodes using
mine (pattern matching) and mint (node construction) rules. See
`parsers.md` for the full mill system documentation.

When you write `role code`, you are saying: "run the `code` mill on
these files." The mill's mine rules recognize keywords like `task`,
`form`, `load`. The mill's mint rules construct typed AST nodes like
`TaskNode`, `FormNode`, `LoadNode`.

```
role code    <- uses the `code` mill (mine code + mint code)
role book    <- uses the `book` mill (mine book + mint book)
role deck    <- uses the `deck` mill (mine deck + mint deck)
role zone    <- uses the `zone` mill (mine zone + mint zone)
```

The mill definitions live in the stdlib. For example, the `code` mill
is defined in `base.tree/code/mill/code/` with `mine.note` and
`mint.note` files that declare how each keyword is recognized and what
AST node it produces.

## Available Mills

| Mill | Purpose | Keywords |
| --- | --- | --- |
| `code` | Program source code | `task`, `form`, `mask`, `load`, `call`, `fork`, `walk`, etc. |
| `math` | Formal proofs and theorems | `rule`, `test`, `form`, `load`, `call`, `fork`, etc. |
| `book` | Documentation | Headings, paragraphs, lists, tables, code blocks, etc. |
| `deck` | Package manifests | `deck`, `mark`, `link`, `lock`, `mind`, etc. |
| `line` | CLI definitions | Command structure, flags, arguments |
| `cast` | HTTP endpoints | Route definitions, handlers |
| `zone` | UI components | Component definitions, lifecycle, events |

Each mill produces different typed AST nodes from the same underlying
TreeCode syntax. A `task` in a `code` file becomes a function
definition. A heading in a `book` file becomes a documentation node.
The Tree parser (Phase 0) is always the same. The mill (Phase 1) is
what gives each file its meaning.

## Resolution

When the package manager builds a deck:

1. It reads `deck.tree` and finds the `role` directive.
2. It loads the role file (e.g., `./base/role.tree`).
3. For each source file, it checks which `role` block matches the
   file path.
4. It looks up the mill named by that role.
5. It runs the mill's mine/mint rules on the file's Tree AST to
   produce typed AST nodes.

Files that do not match any role pattern are not parsed (they are
treated as data or assets).

## Why This Matters

The same `.tree` syntax can represent code, documentation, configuration,
UI definitions, or any other structured content. The role system maps
file patterns to mills. The mill system transforms generic syntax into
domain-specific AST. This lets a single package contain multiple kinds
of content without needing different file extensions or separate build
steps. The role file is the single source of truth for what each file
means.
