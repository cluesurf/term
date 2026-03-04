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

| Keyword | Role         | Example                             |
| ------- | ------------ | ----------------------------------- |
| `deck`  | Package name | `deck @cluesurf/base`               |
| `mark`  | Version      | `mark <0.3.1>`                      |
| `head`  | Description  | `head <A standard library>`         |
| `mind`  | Author       | `mind <Lance Pollard>`              |
| `lock`  | License      | `lock apache-2`                     |
| `sort`  | Category     | `sort tool`                         |
| `term`  | Tag          | `term compiler`                     |
| `link`  | Dependency   | `link @cluesurf/tree, mark <1.x.x>` |

## Dependencies

```tree
deck @cluesurf/my-app
  mark <1.0.0>
  link @cluesurf/base, mark <0.3.x>
  link @cluesurf/tree, mark <1.6.x>
```

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
    helpers/
      base.tree
  test/
    base.tree
```

Application:

```
my-app/
  deck.tree
  code/
    base.tree
  line/
    base.tree        # CLI entry
```

## Standard Packages

| Package     | Purpose              |
| ----------- | -------------------- |
| `base.tree` | Standard library     |
| `bind.tree` | Platform bindings    |
| `mesh.tree` | Compiler and runtime |
| `deck.tree` | Package manager      |
| `seed.tree` | Entrypoint           |
