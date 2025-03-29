# The `line` file in StarTree

```
# file named foo.tree
hook bar
  take help
    take <-h>
    take <--help>
```

Matches from the CLI:

```
foo bar --help
```
