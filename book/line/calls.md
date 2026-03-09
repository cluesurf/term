# CLI Commands

Define CLI docks with `dock`. Parameters use `take`, types use `like`,
execution uses `call` with `bind`.

## Basic Command

```tree
dock make
  take name
    like text
    need true

  take title, code t
    like text

  call make-deck
    bind name, read name
    bind title, read title
```

Running:

```bash
make my-project --title "My Project"
make my-project -t "My Project"
```

## Positional Arguments

Arguments matched by position rather than by flag. Order matters.

```tree
dock copy
  take source
    like path
    need true

  take target
    like path
    need true
```

```bash
copy ./src ./dist
```

Variadic positional (collects remaining args):

```tree
dock concat
  take file
    list path
    need true
```

```bash
concat a.txt b.txt c.txt
```

## Short and Long Options

The field name becomes the long option (`--title`). Use `code` for the
short alias (`-t`).

```tree
take title, code t
  like text
```

```bash
--title "hello"
-t "hello"
```

## Types

### Text

```tree
take name
  like text
```

### Integer

```tree
take port, code p
  like int
```

### Boolean

Boolean flags need no value on the command line. They also support
automatic `--no-*` negation.

```tree
take force, code f
  like bool
```

```bash
--force       # true
-f            # true
--no-force    # false
```

### Path

```tree
take config, code c
  like path
```

### Enum

Use `case` children to define allowed values.

```tree
take mode, code m
  like case
    case dev
    case test
    case prod
  base dev
```

```bash
--mode prod
-m dev
```

## Defaults and Requiredness

Mark a parameter as required:

```tree
take name
  like text
  need true
```

Set a default value with `base`:

```tree
take host
  like text
  base <localhost>
```

```tree
take port
  like int
  base mark 3000
```

## Repeatable Options

Use `list` instead of `like` to accept multiple values.

```tree
take tag
  list text
```

```bash
--tag one --tag two --tag three
```

The values collect into a list.

## Environment Variable baseback

Bind an option to an environment variable. The CLI arg takes priority.
If no arg is given, the env var is checked before the default.

```tree
take token
  like text
  seed env, <APP_TOKEN>
```

Resolution order:

1. Explicit CLI argument
2. Environment variable
3. Config file value
4. Default (`base`)

## Subcommands

Nest `dock` blocks to define subcommands.

```tree
dock deck
  dock make
    take name
      like text
      need true

    call make-deck
      bind name, read name

  dock push
    take tag
      like text

    call push-deck
      bind tag, read tag
```

```bash
deck make my-project
deck push --tag v1.0
```

Deeper nesting works the same way:

```tree
dock deck
  dock remote
    dock add
      take name
        like text
        need true
      take url
        like text
        need true
```

```bash
deck remote add origin https://example.com
```

## Shared Option Groups

Use `tree` and `fuse` to share common flags across commands.

```tree
tree global-flags
  hook fuse
    take verbose, code v
      like bool
    take config, code c
      like path

dock make
  fuse global-flags
  take name
    like text
    need true

  call make-deck
    bind name, read name
    bind verbose, read verbose

dock push
  fuse global-flags
  take tag
    like text

  call push-deck
    bind tag, read tag
    bind verbose, read verbose
```

Now both `make` and `push` accept `--verbose` and `--config`.

## Visibility Marks

### Private (Hidden)

Hidden options do not appear in help output but still work.

```tree
take debug
  like bool
  mark private
```

### Deprecated

Deprecated options print a warning when used. Link to the replacement
with `call`.

```tree
take colour
  like bool
  mark deprecated
    call color
```

Using `--colour` prints: `warning: --colour is deprecated, use --color`.

### Experimental

Experimental options are shown with a warning in help output.

```tree
take turbo
  like bool
  mark experimental
```

## Validation

Use `mill` to attach a validation rule. The mill checks the parsed value
and rejects it with a message if invalid.

```tree
take port, code p
  like int
  mill integer
    bind min, mark 0
    bind max, mark 65535
```

```tree
take version, code v
  like text
  mill semver
```

Custom error messages come from the mill definition.

## Shell Completion

Provide dynamic completions for an option by binding a task that returns
a list of values.

```tree
take host
  like text
  seed call, call list-hosts
```

When the user presses tab after `--host`, the shell runs `list-hosts`
and offers the results.

## Preprocessing

Run normalization logic before the main execution.

```tree
dock make
  take title, code t
    like text

  save clean-title
    call trim-text
      bind text, read title

  call make-deck
    bind title, read clean-title
```

## Pre-Run and Post-Run Hooks

Define setup and teardown logic that runs around every command.

```tree
hook boot
  call load-config
  call load-env
  call setup-logger
  call check-auth

hook halt
  call close-files
  call flush-output
```

These run automatically before and after the command body.

## Execution

### Internal Function Call

Bind to a Seed task:

```tree
dock make
  take name
    like text
    need true

  call make-deck
    bind name, read name
```

### Shell Command

Execute a shell command directly:

```tree
dock init

  call <git init>
```

With dynamic arguments:

```tree
dock clone
  take url
    like text
    need true

  call <git clone>
    bind url, read url
```

## Output Format

Declare what format the command outputs.

```tree
dock list
  send text

dock list
  send json
```

This lets the framework handle `--format json` or `--format text`
automatically.

## Exit Codes

Define named exit codes for the dock.

```tree
seed code
  seed ok, mark 0
  seed help, mark 0
  seed input-error, mark 2
  seed auth-error, mark 3
  seed system-error, mark 1
```

Tasks can reference these by name when exiting:

```tree
halt flow, read input-error
```

## Parse Policy

Configure CLI parsing behavior at the dock level.

```tree
seed short-pack, true    # allow -abc (combined short flags)
seed long-equal, true    # allow --port=3000
seed stop-mark, true     # allow -- to end option parsing
seed case-fold, false    # case-sensitive matching
seed snake-long, true    # --dry_run matches --dry-run
```

## Examples

Attach usage examples to the dock. These appear in help output and can
double as test cases.

```tree
dock make
  show <basic>
    <make deck1 --title "First">

  show <production>
    <make deck1 --mode prod --host example.com>
```

## Full Example

A complete CLI dock definition:

```tree
tree global-flags
  hook fuse
    take verbose, code v
      like bool
    take quiet, code q
      like bool
    take config, code c
      like path

seed code
  case ok, mark 0
  case input-error, mark 2

dock deck
  dock make
    fuse global-flags

    take name
      like text
      need true

    take title, code t
      like text

    take author, code a
      like text

    take version, code v
      like text
      mill semver

    take mode, code m
      like case
        case dev
        case test
        case prod
      base dev

    take force, code f
      like bool

    take dry-run, code d
      like bool

    take host
      like text
      base <localhost>

    take port, code p
      like int
      base mark 3000
      mill integer
        bind min, mark 0
        bind max, mark 65535

    take tag
      list text

    take token
      like text
      seed env, <APP_TOKEN>

    show <basic>
      <deck make my-project --title "Hello">

    show <production>
      <deck make my-project --mode prod --host example.com>

    save clean-title
      call trim-text
        bind text, read title

    call make-deck
      bind name, read name
      bind title, read clean-title
      bind author, read author
      bind version, read version
      bind mode, read mode
      bind force, read force
      bind dry-run, read dry-run
      bind host, read host
      bind port, read port
      bind tags, read tag
      bind token, read token
      bind config, read config

  dock push
    fuse global-flags

    take tag
      like text

    call push-deck
      bind tag, read tag

  dock init

    call <git init>
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Positional arg | `take name` + `need true` | `take input, like path` |
| Long option | field name | `--title` |
| Short option | `code t` | `-t` |
| type | `like text` | `take name, like text` |
| Integer type | `like int` | `take port, like int` |
| Boolean flag | `like bool` | `take force, like bool` |
| Path type | `like path` | `take config, like path` |
| Enum type | `like case` + `case` children | `case dev` / `case prod` |
| Required | `need true` | `take name` / `need true` |
| Default | `base` | `base <localhost>` |
| Repeatable | `list text` | `take tag` / `list text` |
| Env baseback | `seed env` | `seed env, <APP_TOKEN>` |
| Subcommand | nested `dock` | `dock deck` / `dock make` |
| Shared flags | `tree` + `fuse` | `fuse global-flags` |
| Hidden | `mark private` | internal-only option |
| Deprecated | `mark deprecated` | warns, links replacement |
| Experimental | `mark experimental` | shown with warning |
| Validation | `mill` | `mill semver` |
| Completion | `seed call` | `seed call, call list-hosts` |
| Shell command | `call <...>` | `call <git init>` |
| Output format | `send text` / `send json` | machine-readable output |
| Exit codes | `seed code` + `case` | `case ok, mark 0` |
| Parse policy | `seed short-pack` etc. | `seed short-pack, true` |
| Examples | `show` | `show <basic>` |
| Pre-run | `dock boot` | `call check-auth` |
| Post-run | `dock exit` | `call flush-output` |
