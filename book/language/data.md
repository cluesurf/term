# Data

Term has a data format that is plain tree syntax with five heads and no code: `host`, `list`, `mesh`, `tree`, `fuse`, and the six literals. A data file is what a config file holds, what a service streams one record per line, and what `term mold` turns into JSON and back. The compiler compiles it to a module, and `@term/host` reads and writes it at run time.

Maps to: JSON, YAML and JSONL, in one grammar.

## Cheatsheet

| Write | Means |
| --- | --- |
| `host k, 123` | an entry with a scalar value |
| `host k` + entries beneath | an entry whose value is a map |
| `host k` alone | an empty map |
| `list k` + `5, 6, 7` beneath | a list of scalars |
| `list k` + `mesh` blocks beneath | a list of maps |
| `mesh` + entries beneath | one map inside a list, with no key |
| `list` (no key) inside a list | a nested list |
| `<text>`, `123`, `-3.5`, `0x1f`, `true`, `false`, `void` | the six literals (`void` is null) |
| `tree name` + entries | an anchor, declared before any data |
| `fuse name` inside a block | splice the anchor here, later keys win |
| `h(k,v)`, `l(k,...)`, `m(...)`, `t(name,...)`, `f(name)` | the compact form, one entry per line |
| `term mold file` | print as long form. `--pack` compact, `--json` JSON, `--check` only problems |

## The long form

```tree
host x
  host y
    host z, 123
  host w, <foo>
  list a
    5, 6, 7
  list member
    mesh
      host name, <foo>
    mesh
      host name, <bar>
```

That is this JSON:

```json
{ "x": { "y": { "z": 123 }, "w": "foo" }, "a": [5, 6, 7],
  "member": [{ "name": "foo" }, { "name": "bar" }] }
```

Keys are kebab in the file and become snake at the JSON boundary (`retry-after` is `"retry_after"`), and nowhere else.

## The compact form

The same tree with one-letter heads and parentheses. One entry per line, so a file of them is a stream.

```
h(x,h(y,h(z,123)),h(w,<foo>),l(a,5,6,7),l(member,m(h(name,<foo>)),m(h(name,<bar>))))
```

`term mold file --pack` writes it, `term mold file.line` reads it back into the long form.

## Anchors

`tree` names a block, `fuse` splices it, and an entry after the `fuse` with the same key replaces what the anchor brought. Anchors come first.

```tree
tree service-config
  host env, <prod>
  host retries, 3
  host version, 6.8

host vars
  host dev-service
    host config
      fuse service-config
      host version, 7.23
```

## What the compiler does with it

`term make` compiles a data file to a module whose default export is the value as a JSON literal, keys converted, anchors expanded, so an app can import it. A file is recognised as data by its content: every top-level head is one of the five, and nothing beneath them is code.

## Reading it in Term

```tree
load @term/host/code/base
  find read
  find write
  find to-json

task load-config
  take text, like text
  like data
  send back
    call read, read text
```

`read` gives a `data` value: a `hash` of entries, an `array`, a `text`, a `number`, a `decimal`, a `flag`, or `blank`. `write` gives the long form back, `pack` the compact one. `get-at` follows a path (`<x/member/1/name>`) to a `maybe data`.

## Reading into a form

```tree
form service
  link env, like text
  link retries, like number

task load-service
  take text, like text
  like service
  send back
    call fill
      call read(read text)
      like service
```

The `like` names the form and the compiler walks its fields: the result is a `service`, and a value that does not fit raises `data-mismatch` with `path` (`limit/burst`) and `reason` (`is text where number belongs`). `need false` fields may be absent, a nested form fills recursively, a `like list / like T` field item by item. `melt` with a `like` takes a form value back to data. Both work on every backend: TypeScript walks a spec at run time, Rust, Swift and Kotlin get a generated function per form.

## Checking a value against a shape

```tree
save config
  call fill
    call read(read text)
    call read(text <host env, \<text\>\nhost retries, \<number\>\nhost region, \<text?\>\n>)
```

The shape is data too: each key names a kind (`<text>`, `<number>`, `<decimal>`, `<flag>`, `<blank>`, `<map>`, `<list>`, `<any>`), a `?` lets the key be absent, a nested map checks a nested map, a list holds one item shape. `fill` gives the value as a host value for the json module's accessors, or raises `data-mismatch` with `path` (`limits/burst`) and `reason` (`is text where number belongs`). `melt` takes a host value back to data.

## Streams

```tree
save reader
  call make-reader
save found
  call feed(read reader, read line)
```

`feed` takes one compact line and gives `some` data or `none` (a blank line, a comment, a `t(` anchor line). A writer (`make-writer`, `emit`) sends a `t(` line the first time a value fuses an anchor. `read-lines` and `write-lines` do the same for a stream held as one text, and `term mold file --lines` prints a stream as the long form.

## The tools

`term form` lays a data file out canonically and keeps its comments. `term lint` reports the grammar's rules (`L031`). `term look` lists the keys as paths. `term make` compiles it to a module. A `role.tree` in the project can name which files are data over what their content says.

## What it is not

There is no `code`, `text`, `call` or `read` in a data file, no interpolation in its text (a `{` is a brace), and no way to compute anything. That absence is what lets a reader trust it. The full design is in the repository notes, `note/term/host/`.
