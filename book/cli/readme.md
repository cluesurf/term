# Building a command-line tool

A Term command-line tool is a set of `hook` blocks. Each `hook` names a command, declares its arguments and options with `take`, binds a `task` to run, and carries its own help text. The compiler lowers a `hook` into a route, and the dispatcher parses the user's `argv` against it: it descends subcommands, matches flags and positionals, fills defaults, coerces types, and renders `--help`. You write the shape, the dispatcher does the parsing.

This page is about authoring **your own** CLI in Term. For the `term` command itself (the tool that builds and runs your project) see [tool/readme.md](../toolchain/readme.md).

Maps to: yargs, clap, or Cobra, but declared in the same `.tree` syntax as the rest of your program.

## Cheatsheet

A command is a `hook`. Its children declare the command and its inputs.

| Head | Where | Does |
| --- | --- | --- |
| `hook <name>` | top level, or nested | declare a command (nest for a subcommand) |
| `note <text>` | child of `hook` or `take` | help text for the command or option |
| `task <name>` | child of `hook` | the task to run when the command is invoked |
| `take <name>` | child of `hook` | declare an argument or option |
| `like <type>` | child of `take` | the option's type (`text`, `number`, `wave` for a boolean) |
| `code <letter>` | child of `take` | a short flag alias (`-t`) |
| `bind <value>` | child of `take` | the default value when the flag is absent |
| `pick <value>` | child of `take`, repeatable | restrict to a fixed set of allowed values |
| `many` | child of `take` | collect the remaining positionals into a list |

A `take` with no `bind` is required. A `take, like wave` is a boolean flag, and the dispatcher accepts its `--no-` form automatically.

## A minimal command

```tree
hook greet
  note <Print a friendly greeting>
  task run-greet
  take name
    note <Who to greet>
```

This declares a `greet` command with one positional argument bound to the `run-greet` task. The `note` lines become the `--help` text.

```bash
greet ada
greet --help
```

The named task receives the parsed arguments.

```tree
task run-greet
  take name, like text
  like number
  call write-line
    call join
      text <hello, >
      read name
  send back, code 0
```

## Options, types, and short flags

A `take` with a `like` type becomes a `--flag value` option. Add `code` for a one-letter alias. The field name is the long flag.

```tree
hook serve
  note <Start the dev server>
  task run-serve
  take port, like number
    note <Port to listen on>
    code p
    bind 3000
  take host, like text
    note <Host to bind>
    bind <localhost>
```

```bash
serve --port 8080
serve -p 8080
serve              # port falls back to 3000, host to localhost
```

A number flag is coerced from text to a number. A missing flag with a `bind` default fills in. A missing flag without a default is an error.

## Boolean flags

A `take, like wave` is a switch. Present means true. The dispatcher also accepts the `--no-` form for false, with no extra declaration.

```tree
hook build
  task run-build
  take watch, like wave
    note <Rebuild on change>
```

```bash
build --watch        # watch = true
build --no-watch     # watch = false
build                # watch is unset
```

## Defaults

A `bind` child sets the value used when the flag is absent. It shows up in `--help` as the default.

```tree
take runs, like number
  note <Fuzz inputs per seed>
  bind 3000
```

## Restricting values with pick

Repeat `pick` to list the allowed values. The dispatcher rejects anything outside the set with a clear message.

```tree
take mode
  note <Build mode>
  pick <dev>
  pick <prod>
  bind <dev>
```

```bash
build --mode prod
build --mode staging   # rejected: not one of dev, prod
```

## Collecting the rest with many

A `take` marked `many` gathers every remaining positional into a list. Pair it with `like list`.

```tree
hook concat
  task run-concat
  take files, like list
    note <Files to join>
    many
```

```bash
concat a.txt b.txt c.txt   # files = [a.txt, b.txt, c.txt]
```

## Subcommands

Nest a `hook` inside a `hook` to build a subcommand. The parent groups, each child is its own command with its own takes and task.

```tree
hook deck
  note <Manage decks>
  hook make
    note <Create a new deck>
    task run-make
    take name
      note <Deck name>
  hook push
    note <Publish a deck>
    task run-push
    take tag, like text
      note <Release tag>
```

```bash
deck make my-project
deck push --tag v1.0
```

Nest deeper the same way for `deck remote add`, and so on.

## Sharing options across commands

Common flags (a `--verbose`, a `--config`) repeat across commands. Define them once as a template with `tree` and pull them into each command with `fuse`. See [templates](../language/templates.md) for the full template mechanism.

```tree
tree common-flags
  hook fuse
    take verbose, like wave
      note <Print extra output>
      code v
    take config, like text
      note <Path to config file>
      code c

hook make
  fuse common-flags
  task run-make
  take name
    note <Deck name>
```

Both the template's flags and the command's own `take`s reach the bound task.

## A complete CLI

```tree
hook hunt
  note <Automated bug-hunt over .tree files>
  task call-hunt
  take glob
    note <Directory to hunt>
  take runs, like number
    note <Fuzz inputs per seed>
    bind 3000
  take seeds, like number
    note <Distinct fuzz seeds>
    bind 4
  take json, like wave
    note <Machine-readable output>
```

This lowers to a `hunt` command bound to `call-hunt`. Running it, `glob` binds to the first positional, `runs` and `seeds` fill from their defaults unless overridden, numbers coerce from text, `--no-json` negates the boolean, and `hunt --help` renders entirely from the `note` lines and defaults above. The task then does the work.

```tree
task call-hunt
  take glob, like text
  take runs, like number
  take seeds, like number
  take json, like wave
  like number
  # ... run the hunt, print the report ...
  send back, code 0
```

The task's return number is the process exit code. Send back `0` for success, a non-zero code for failure.
