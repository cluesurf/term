# Parsers

Define grammars with `mill`. Match patterns with `mine`. Build AST
nodes with `mint`.

## Parser Definition (`mill`)

```tree
mill json-parser
  mine form json-value
```

## Match Patterns (`mine`)

### Literal Text

```tree
mine text, <hello>
mine text, <true>
mine text, <null>
```

### Character Class

```tree
mine code, <a..z>
mine code, <A..Z>
mine code, <0..9>
```

### Character Range

```tree
mine band, <0..9>
mine band, <a..f>
```

### Named Rule

```tree
mine term, <identifier>
mine term, <expression>
```

### Sequence

Match items in order:

```tree
mine line
  mine text, <[>
  mine term, <value>
  mine text, <]>
```

### Alternatives

Match one of several options:

```tree
mine list
  mine text, <true>
  mine text, <false>
  mine text, <null>
```

### Named Pattern

```tree
mine form, <identifier>
  mine line
    mine code, <a..z>
    mine room
      mine code, <a..z0..9->
```

### Conditional Match

```tree
mine test
  mine code, <0..9>
  hook true
    mine term, <number>
  hook false
    mine term, <identifier>
```

### Lookahead

Match without consuming:

```tree
mine head
  mine text, <=>
```

### Lookbehind

```tree
mine back
  mine text, <\n>
```

### Optional

```tree
mine room
  mine text, <->
```

### Any Order

Match in any order:

```tree
mine case
  mine term, <width>
  mine term, <height>
  mine term, <color>
```

### Negation

Match anything except:

```tree
mine miss
  mine text, <">
```

## AST Builder (`mint`)

### Emit Value

```tree
mint save, read node/text
```

### Append to Array

```tree
mint line, read item
```

### Add to Map

```tree
mint knit, read key, read val
```

### Delegate to Sub-Builder

```tree
mint form, form identifier
```

### Construct Object

```tree
mint make, form ast-node
```

## Full Example: Cookie Parser

```tree
mill cookie-parser
  mine form, <cookie-pair>
    mine line
      mine term, <cookie-name>
      mine text, <=>
      mine term, <cookie-value>
    mint make, form cookie
      mint save, read name
      mint save, read value

  mine form, <cookie-name>
    mine line
      mine miss
        mine list
          mine code, <0..31>
          mine code, <127>
          mine text, < >
          mine text, <;>
          mine text, <=>
      mint save

  mine form, <cookie-value>
    mine room
      mine list
        mine line
          mine text, <">
          mine term, <cookie-octets>
          mine text, <">
        mine term, <cookie-octets>
    mint save
```

## Mine Summary

| Variant | Purpose | Example |
| --- | --- | --- |
| `mine text` | Literal string | `mine text, <hello>` |
| `mine code` | Character class | `mine code, <a..z>` |
| `mine band` | Character range | `mine band, <0..9>` |
| `mine term` | Named rule ref | `mine term, <number>` |
| `mine line` | Sequence | `mine line` |
| `mine form` | Named pattern | `mine form, <id>` |
| `mine list` | Alternatives | `mine list` |
| `mine test` | Conditional | `mine test` |
| `mine head` | Lookahead | `mine head` |
| `mine back` | Lookbehind | `mine back` |
| `mine room` | Optional | `mine room` |
| `mine case` | Any order | `mine case` |
| `mine miss` | Negation | `mine miss` |

## Mint Summary

| Variant | Purpose | Example |
| --- | --- | --- |
| `mint save` | Emit value | `mint save, read text` |
| `mint line` | Append to list | `mint line, read item` |
| `mint knit` | Add to map | `mint knit, read k, read v` |
| `mint form` | Sub-builder | `mint form, form node` |
| `mint make` | Construct | `mint make, form ast` |
