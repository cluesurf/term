# Templates

Define reusable code patterns with `tree`. Instantiate them with
`fuse`. Templates expand at compile time.

## Define a Template (`tree`)

A template takes parameters and generates code:

```tree
tree doubler
  take name

  hook fuse
    task double-{name}
      take n, like u64
      like u64
      send back
        call mul
          bind a, read n
          bind b, 2
```

## Instantiate (`fuse`)

Generate code from a template:

```tree
fuse doubler
  bind name, <int>
```

This produces:

```tree
task double-int
  take n, like u64
  like u64
  send back
    call mul
      bind a, read n
      bind b, 2
```

## Template with Multiple Parameters

```tree
tree accessor
  take name
  take type

  hook fuse
    task get-{name}
      like {type}
    task set-{name}
      take value, like {type}
```

## Compile-Time Interpolation

Single braces `{name}` substitute at compile time:

```tree
tree is-even
  take size

  hook fuse
    task is-even
      take n, like mark-{size}
      send back
        call is-equal
          bind a
            call intersect-bitwise
              bind a, read n
              bind b, 1
        bind b, 0
```

## Template Hooks

Templates use `hook fuse` or `hook fuse` to define their output:

```tree
tree interval-methods
  take name

  hook fuse
    task get-{name}
      like u32
    task set-{name}
      take value, like u32
    task add-{name}s
      take value, like u32
```

## Slots and Beams

`slot` marks a place you can return to in future contexts. `beam`
returns to that slot to emit content. Use this when you need to
dynamically build definitions, like adding links to a form during
iteration.

```tree
form x
  slot self
  walk list, read something
    hook next
      take site
      beam self
        link {site/name}, like {site/type}
```

Here we dynamically define `link` fields on the form. The `beam`
tells the compiler what context the DSL terms apply to.

Another example, emitting into a template output:

```tree
tree define-each
  take list
  take template-name

  hook fuse
    slot file
    walk list, read list
      hook next
        take site, name item
        beam file
          fuse {template-name}
            read item
```

## Fuse Inside a Form

Templates can be used inside form definitions:

```tree
form date
  fuse define-each, read interval
    read define-interval
```

## Runtime vs Compile-Time Interpolation

| Syntax | When | Use |
| --- | --- | --- |
| `{name}` | Compile time | Template expansion |
| `{{name}}` | Runtime | String interpolation |

Compile-time interpolation happens during template expansion.
Runtime interpolation happens when the program runs.

```tree
tree greeter
  take lang

  hook fuse
    task greet-{lang}
      take name, like text
      send back
        text <hello {{name}} in {lang}>
```

Fusing `greeter` with `bind lang, text <english>` produces:

```tree
task greet-english
  take name, like text
  send back
    text <hello {{name}} in english>
```

The `{lang}` was replaced at compile time. The `{{name}}` stays
for runtime.
