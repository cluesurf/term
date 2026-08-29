<h3 align='center'>@term/host</h3>
<p align='center'>
  Term data: a tree-syntax data format
</p>

<br/>

## What it is

The `host` dialect: tree syntax with five heads (`host`, `list`,
`mesh`, `tree`, `fuse`) and six literals, and nothing that computes.
A long form that reads like YAML, a compact form that packs like JSON
one record per line, and anchors in the words Term already has.

```tree
host x
  host y
    host z, 123
  host w, <foo>
  list a
    5, 6, 7
```

```
h(x,h(y,h(z,123)),h(w,<foo>),l(a,5,6,7))
```

The design and the implementation plan live in the repository notes,
`note/term/host/`, starting at `readme.md` there. This package is the
Term-side reader, writer, anchor expander, JSON bridge and stream
reader described in `06-package-and-cli.md`. The compiler's own path
for data files and the `term mold` verb are in `@term/make` and
`@term/call`.

## Status

Scaffolded 2026-08-28. `code/base.tree` declares the value forms and
the two exceptions. The modules the plan names are the next step.
