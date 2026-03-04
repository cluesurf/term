# Primitives

Seed has six literal types: integers, floats, strings, booleans,
character codes, and symbols.

## Numbers

```tree
number 1
number 3.14
number -2.46
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

### Codes

```tree
something #b000
```

### Compile-Time Interpolation

Single braces substitute at compile time:

```tree
tree greeter
  take name

  hook bind
    task greet-{name}
      send back, text <hello {name}>
```

### Runtime Interpolation

Double braces substitute at runtime:

```tree
task greet
  take name, like text
  send back, text <hello {{name}}>
```

## Symbols (`term`)

Named symbolic values, used for enum-like constants:

```tree
host color
  term red
  term green
  term blue
```

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
| `like f32` | 32-bit float |
| `like f64` | 64-bit float |
| `like text` | String |
| `like boolean` | Boolean |
| `like void` | No value |
