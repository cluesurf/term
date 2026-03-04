# Templates

Define reusable code patterns with `tree`. Instantiate them with
`fuse`. Templates expand at compile time.

## Define a Template (`tree`)

A template takes parameters and generates code:

```tree
tree doubler
  take name

  hook bind
    task double-{name}
      take n, like u64
      like u64
      back call mul
        bind a, read n
        bind b, mark 2
```

## Instantiate (`fuse`)

Generate code from a template:

```tree
fuse doubler
  bind name, text <int>
```

This produces:

```tree
task double-int
  take n, like u64
  like u64
  send back
    call mul
      bind a, read n
      bind b, mark 2
```

## Template with Multiple Parameters

```tree
tree accessor
  take name
  take type

  hook bind
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

  hook bind
    task is-even
      take n, like mark-{size}
      send back
        call is-equal
          bind a
            call intersect-bitwise
              bind a, read n
              bind b, mark 1
        bind b, mark 0
```

## Template Hooks

Templates use `hook bind` or `hook fuse` to define their output:

```tree
tree interval-methods
  take name

  hook bind
    task get-{name}
      like u32
    task set-{name}
      take value, like u32
    task add-{name}s
      take value, like u32
```

## Slots and Beams

`slot` defines an insertion point. `beam` emits content into a slot.

```tree
tree wrapper
  take content

  hook bind
    slot body
    beam body
      fuse content
```

## Iteration in Templates

Loop over a list to generate multiple definitions:

```tree
tree define-each
  take list
  take template-name

  hook fuse
    slot file
    walk list, loan list
      hook step
        take item
        beam file
          fuse {template-name}
            loan item
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

  hook bind
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
