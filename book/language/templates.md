# Templates

A template generates code at compile time. Define one with `tree`, give it parameters with `take`, and write its output under `hook fuse`. Instantiate it with `fuse`. Templates exist to remove repetition: write the shape once, stamp it out many times.

Maps to: a Rust macro, a C++ template, a code generator. The expansion happens during compilation, so there is zero runtime cost. Expanded code is type-checked like everything else, so a template that emits a type error is caught at the fuse site.

## Cheatsheet

| Head | Job |
| --- | --- |
| `tree <name>` | define a template |
| `take <param>` | declare a template parameter |
| `hook fuse` | the body the template emits |
| `hook bind` | an alternate emit body (used when fusing into a binding position) |
| `fuse <name>` | instantiate a template |
| `bind <param>, <value>` | pass a named argument to a `fuse` |
| `fuse read <param>` | resolve the template name from a parameter (dynamic fuse) |
| `site <name>` | an injection point inside a template body |
| `beam <name>` | at the fuse site, the block of code injected at the matching `site` |
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

`fuse` stamps out the body. Pass each parameter with `bind`.

```tree
fuse doubler
  bind name, int
```

That expands to:

```tree
task double-int
  take n, like number
  like number
  send back
    call multiply, read n, code 2
```

The `tree` definition itself is removed after expansion. Only the emitted code remains.

## Multiple parameters

List a `take` per parameter, and a `bind` per argument. Each becomes a `{param}` hole.

```tree
tree accessor
  take name
  take type
  hook fuse
    task get-{name}
      like {type}
    task set-{name}
      take value, like {type}

fuse accessor
  bind name, age
  bind type, number
```

This emits `get-age` (returning a `number`) and `set-age` (taking a `number` value).

## Slots and beams: injecting a block

A `{param}` hole fills in a single name. A `site` fills in a whole block of code. Mark the injection point in the body with `site <name>`, then supply the block at the fuse site with `beam <name>` and its children.

```tree
tree wrapper
  take name
  hook fuse
    form {name}
      site fields

fuse wrapper
  bind name, point
  beam fields
    link x, like number
    link y, like number
```

The `beam fields` block is injected where `site fields` sits, inside the substituted form name. The result:

```tree
form point
  link x, like number
  link y, like number
```

Use slots when a template wraps a body it does not know in advance: a record shell whose members vary, a handler whose steps the caller supplies.

## Removing repetition

Whenever a block of definitions differs only by a name or a type, lift it into a `tree` and `fuse` it per case. The before-and-after below collapses near-identical tasks into one template.

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
  take tag
  hook fuse
    task is-{name}
      take self
      like boolean
      send back
        call is-equal, read self, code {tag}

fuse is-color
  bind name, red
  bind tag, 0

fuse is-color
  bind name, green
  bind tag, 1
```

`code {tag}` substitutes the number argument into a `code` literal, so the first fuse emits `code 0` and the second `code 1`.

## A compile-time loop over an enumeration

A `host` block declares a compile-time list of names. A template can walk that list and fuse another template once per item. `fuse read <param>` resolves the inner template name from a parameter, and `{name}` substitutes the item.

```tree
host suit
  term hearts
  term spades

tree make-flag
  take name
  hook bind
    task is-{name}
      like boolean

tree each
  take items
  take maker
  hook fuse
    walk list, read items
      hook step
        take item
        fuse read maker
          read item

fuse each, read suit
  read make-flag
```

`fuse each` runs at compile time. It walks `suit` and fuses `make-flag` for each entry, generating `is-hearts` and `is-spades`. This is how you give a form a family of parallel members without writing each one. Defining the shape once keeps the code rich and free of copy-paste.

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

Fusing with `bind lang, english` produces a task `greet-english` whose body still holds `{{name}}` for the runtime to substitute.

## See also

- [structures](structures.md) for the `form` and `link` the templates above stamp out.
- [functions](functions.md) for the `task` shape inside a template body.
- [modules](modules.md) for importing a template from another package before `fuse`.
- [conventions](conventions.md) for naming generated members.
