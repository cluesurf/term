# Primitives

Seed has four literal types: integers, strings, booleans, and
symbols.

## Numbers

```tree
mark 1
mark 42
mark 100
```

## Strings

Wrap text in angle brackets:

```tree
text <hello>
text <hello world>
```

Multiline:

```tree
text <
  This is a longer
  string that spans
  multiple lines.
>
```

### Compile-Time Interpolation

Single braces substitute at compile time:

```tree
tree greeter
  take name

  hook bind
    task greet-{name}
      send back, <hello {name}>
```

### Runtime Interpolation

Double braces substitute at runtime:

```tree
task greet
  take name, like text
  send back, <hello {{name}}>
```

## Symbols (`term`)

Named symbolic values, used for enum-like constants:

```tree
host color
  term red
  term green
  term blue
```

## Null (`null`)

The host null literal, for the `dynamic` / host boundary: JSON null, a JS `null` handed to an FFI, the value `is-null` tests for. It is typed `dynamic` and emitted as each host's null (`null` on node and kotlin, `serde_json::Value::Null` on rust, `NSNull()` on swift).

```tree
send back
  null
```

`null` is distinct from `void` / `unit` (no value, emitted as `undefined`). For an *optional* value in ordinary typed code, prefer `maybe` / `make none` over `null`. Reserve `null` for the host / `dynamic` boundary.

## Type Annotations for Primitives

| Seed Type | Meaning |
| --- | --- |
| `like u8` | Unsigned 8-bit integer |
| `like u16` | Unsigned 16-bit integer |
| `like u32` | Unsigned 32-bit integer |
| `like u64` | Unsigned 64-bit integer |
| `like i8` | Signed 8-bit integer |
| `like i16` | Signed 16-bit integer |
| `like i32` | Signed 32-bit integer |
| `like i64` | Signed 64-bit integer |
| `like text` | String |
| `like boolean` | Boolean |
| `like void` | No value |
