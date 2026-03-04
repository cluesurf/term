# Primitives

Seed has six literal types: integers, floats, strings, booleans,
character codes, and symbols.

## Integers (`mark`)

```tree
mark 0
mark 42
mark 1000
```

Binary, octal, and hex:

```tree
mark #b0101
mark #o755
mark #xff
```

Negative numbers use a function call:

```tree
call sub
  bind a, mark 0
  bind b, mark 5
```

## Floats (`comb`)

```tree
comb 3.14
comb 1.0
comb 0.5
```

## Strings (`text`)

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
      back text <hello {name}>
```

### Runtime Interpolation

Double braces substitute at runtime:

```tree
task greet
  take name, like text
  back text <hello {{name}}>
```

## Booleans (`wave`)

```tree
wave true
wave false
```

## Character Codes (`code`)

Byte or character values in binary or hex:

```tree
code #b01000001
code #xff
code #x41
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
