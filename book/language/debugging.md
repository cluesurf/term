# Debugging

When something is off, Term gives you three things: a way to print values at runtime, a compiler that explains itself in clear frames, and tools that clean up shape and style. Most bugs are caught before the program runs, at `term scan` or `term make`, and the diagnostic tells you the file, the line, and the fix. This page covers printing, reading the frames, and the lint and format passes.

Maps to: `console.log`, a linter, and a formatter.

## Cheatsheet

| Write | Means |
| --- | --- |
| `call info` / `call warn` / `call error` / `call debug` | log a message (from `@cluesurf/base/code/log`) |
| `call write-line` / `call write-error` | print a raw line (from `@cluesurf/base/code/native/console`) |
| `# lint off L0xx` | suppress one lint rule on the next definition |
| `# text` | a comment, on its own line |

| Command | Does |
| --- | --- |
| `term scan <file>` | type-check one file, print diagnostics |
| `term make` | build the project, report errors with frames |
| `term lint [paths]` | report style and correctness problems |
| `term lint --fix` | apply the safe autofixes |
| `term form [paths]` | format files into canonical layout |
| `term form --check` | report which files would change, write nothing |

Note: there is no `show` keyword for logging. `show` belongs to proofs (`show hold`, see [math](../math/readme.md)). You print with the standard library, below.

## Logging a value

The `log` module gives you four levels. Load the ones you use, then call them with a `text` message.

```tree
load @cluesurf/base/code/log
  find info
  find warn
  find error

task charge
  take amount, like number
  like number
  call info
    text <charging the account>
  fork test
    hook test
      call is-below
        read amount
        code 0
    hook hold
      call warn
        text <amount is negative>
  send back, read amount
```

For raw output with no level prefix, drop to the native console:

```tree
load @cluesurf/base/code/native/console
  find write-line

task trace
  take label, like text
  like void
  call write-line
    read label
```

`info` and friends take a `text`. To log a non-text value, render it first (for example with the type's `show-text` task, or `call stringify` from the `json` module).

## Reading a diagnostic frame

`term scan` and `term make` report problems as kink frames. A frame names what went wrong, points at the exact span, suggests a fix, and gives the rule name and code so you can look it up.

```bash
term scan src/user.tree
```

```
kink <return value: expected text, found number>
  site <src/user.tree:4:3>
    3 |   like text
    4 |   send back
      |   ^^^^^^^^^
  note <make the value match the expected type, or adjust the annotation>
  name <type-mismatch>
  code <0007>
```

Read it top to bottom:

- `kink` is the one-line summary of the problem.
- `site` is the file, line, and column, with the offending lines printed and the span underlined.
- `note` is the suggested fix, in plain words.
- `name` is the diagnostic's stable name, here `type-mismatch`.
- `code` is its number, here `0007`, for searching the reference.

Fix the cause the `note` describes, then rerun `term scan` on the same file. For machine-readable output, add `--back json`:

```bash
term scan src/user.tree --back json
```

## Catching style and shape with `lint` and `form`

Two tools clean up problems the type checker does not care about.

`term lint` reports style and correctness issues: a redundant suffix on a form name, a task prefixed by its module, a dead branch. `--fix` applies the safe ones.

```bash
term lint                # report problems
term lint --fix          # apply safe autofixes
```

When a lint warning is a false positive for your case, silence that one rule on the next definition with a comment. Prefer fixing the cause.

```tree
# lint off L008
load @cluesurf/base/code/clock
  find now
```

`term form` rewrites files into the canonical layout: child order, indentation, spacing. Run it before committing. `--check` makes it a CI gate that writes nothing and reports which files differ.

```bash
term form                # format every .tree file in place
term form --check        # CI: report files that would change
```

## A debugging loop

A practical order when a build is failing:

1. `term scan <file>` on the file you suspect. Read the frame, fix the cause, rescan.
2. `term make` once the file scans clean, to catch cross-file problems.
3. Drop a `call info` near the wrong value to trace it.
4. `term lint --fix` and `term form` before you commit.

See [conventions](conventions.md) for the rules `lint` and `form` enforce, [tests](tests.md) for catching regressions, and the [CLI reference](../toolchain/readme.md) for every `term` command.
