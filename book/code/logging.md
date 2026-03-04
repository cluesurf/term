# Logging

Six log levels, from least to most severe.

## Log Levels

| Keyword | Level | Use |
| --- | --- | --- |
| `dive` | Trace | Detailed debugging info |
| `hint` | Debug | Debugging info |
| `show` | Info | General information |
| `tell` | Warning | Something might be wrong |
| `kink` | Error | Something failed |
| `bust` | Critical | System is broken |

## Usage

### Info (`show`)

```tree
show <server started>
show {result}
```

Log a variable:

```tree
task print-all
  take items
  walk list
    read items
    hook tick
      take item
      show {item}
```

### Trace (`dive`)

```tree
dive text <entering parse function>
```

### Debug (`hint`)

```tree
hint text <cache miss for key>
```

### Warning (`tell`)

```tree
tell text <deprecated function called>
```

### Error (`kink`)

```tree
kink text <failed to connect>
```

### Critical (`bust`)

```tree
bust text <fatal: database corrupted>
```

## Logging Values

Log any expression:

```tree
show read count
show call get-name
show mark 42
show text <checkpoint reached>
```
