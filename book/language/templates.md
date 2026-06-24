# Templates

A template generates code at compile time. Define one with `tree`, give it parameters with `take`, and write its output under `hook fuse`. Instantiate it with `fuse`. Templates exist to remove repetition: write the shape once, stamp it out many times.

Maps to: a Rust macro, a C++ template, a code generator. The expansion happens during compilation, so there is zero runtime cost.

## Cheatsheet

| Head | Job |
| --- | --- |
| `tree <name>` | define a template |
| `take <param>` | declare a template parameter |
| `hook fuse` | the body the template emits |
| `fuse <name>` | instantiate a template |
| `{param}` | compile-time substitution of a parameter inside the body |
| `{{name}}` | runtime string interpolation (left untouched by expansion) |

A template's `take` parameters are names, not typed values. The body under `hook fuse` is a code shape with `{param}` holes that the compiler fills in when you `fuse`.

## Defining a template

`tree` names the template, `take` lists its parameters, and `hook fuse` holds the code to emit. Inside the body, `{name}` is replaced by the argument.

```tree
tree doubler
  take name

  hook fuse
    task double-{name}
      take n, like number
      like number
      send back
        call multiply, read n, code 2
```

## Instantiating

`fuse` stamps out the body with the argument bound.

```tree
fuse doubler
  read int
```

That expands to:

```tree
task double-int
  take n, like number
  like number
  send back
    call multiply, read n, code 2
```

## Multiple parameters

List a `take` per parameter. Each becomes a `{param}` hole.

```tree
tree accessor
  take name
  take kind

  hook fuse
    task get-{name}
      take self
      like {kind}
    task set-{name}
      take self
      take value, like {kind}
```

```tree
fuse accessor
  read width
  read number
```

## Using a template inside a form

A `fuse` placed inside a `form` body emits its output as members of that form. This is the standard way to give a record a family of parallel accessors without repeating them.

```tree
host interval
  term year
  term month
  term day

tree interval-accessor
  take name

  hook fuse
    task get-{name}
      take self
      like number
    task add-{name}s
      take self
      take value, like number

form date
  link year, like number
  link month, like number
  link day, like number

  fuse define-each, read interval
    read interval-accessor
```

`define-each` walks the `interval` list and fuses `interval-accessor` once per entry, so `date` gets `get-year`, `add-years`, `get-month`, and so on. Defining the shape once keeps the form rich and free of copy-paste.

## Removing repetition

Whenever a block of definitions differs only by a name or a type, lift it into a `tree` and `fuse` it per case. The before-and-after below collapses three near-identical tasks into one template.

Before:

```tree
task is-red
  take self
  like boolean
  send back
    call is-equal, read self, code 0

task is-green
  take self
  like boolean
  send back
    call is-equal, read self, code 1
```

After:

```tree
tree is-color
  take name
  take code

  hook fuse
    task is-{name}
      take self
      like boolean
      send back
        call is-equal, read self, mark {code}

fuse is-color
  read red
  read 0

fuse is-color
  read green
  read 1
```

## Compile-time versus runtime interpolation

Two brace forms look similar but happen at different times.

| Syntax | When | Use |
| --- | --- | --- |
| `{name}` | compile time | template expansion |
| `{{name}}` | runtime | text interpolation |

A single brace is filled while the template expands. A double brace survives expansion and is filled when the program runs.

```tree
tree greeter
  take lang

  hook fuse
    task greet-{lang}
      take name, like text
      like text
      send back
        text <hello {{name}} in {lang}>
```

Fusing with `read english` produces a task `greet-english` whose body still holds `{{name}}` for the runtime to substitute.

## See also

- [structures](structures.md) for the `form` and `link` the templates above stamp out.
- [functions](functions.md) for the `task` shape inside a template body.
- [modules](modules.md) for importing a template from another package before `fuse`.
- [conventions](conventions.md) for naming generated members.
