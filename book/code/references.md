# References

How to access values and fields.

## Read (Copy/Access)

Access a variable by name:

```tree
read x
```

Access a nested field:

```tree
read x/name
read x/foo/bar
```

Access a method result:

```tree
read self/length
```

## Optional Chaining

Add `?` after a name to safely access fields that might not exist:

```tree
read user?/email
read parent?/child?/name
```

If the value is absent, returns none instead of crashing.

## Path Syntax Summary

| Syntax | Meaning |
| --- | --- |
| `read x` | Copy value of x |
| `read x/y` | Access field y of x |
| `read x/y/z` | Access nested field z |
| `read x?/y` | Safe access (optional chain) |
