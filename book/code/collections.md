# Collections

Seed provides lists and maps as core data structures.

## Lists

Create a list with `make list`:

```tree
save items
  make list
    bind item, mark 1
    bind item, mark 2
    bind item, mark 3
```

Access elements:

```tree
save first
  call items/get
    bind index, mark 0
```

Add elements:

```tree
call items/push
  bind item, mark 4
```

Get the size:

```tree
save count
  call items/get-size
```

Check if empty:

```tree
fork test
  call items/is-empty
  hook true
    show text <no items>
```

Iterate over a list:

```tree
walk list
  read items
  hook tick
    take item
    show read item
```

## Maps

Create a map with `make find`:

```tree
save table
  make find
    bind key, text <name>
    bind value, text <alice>
```

Look up a value:

```tree
save name
  call table/get
    bind key, text <name>
```

Set a value:

```tree
call table/set
  bind key, text <age>
  bind value, mark 30
```

Check for a key:

```tree
fork test
  call table/has
    bind key, text <name>
  hook true
    show text <found>
```

Remove a key:

```tree
call table/remove
  bind key, text <name>
```

Iterate over entries:

```tree
walk list
  call table/get-entries
  hook tick
    take entry
    show read entry/key
    show read entry/value
```

## List Form (Stdlib)

```tree
form list
  head t

  task push
    take self
    take item, like t

  task pop
    take self

  task get
    take self
    take index, like u64

  task get-size
    take self
    like u64

  task is-empty
    take self
    like boolean
```

## Map Form (Stdlib)

```tree
form find
  head k
  head v

  task get
    take self
    take key, like k

  task set
    take self
    take key, like k
    take value, like v

  task has
    take self
    take key, like k
    like boolean

  task remove
    take self
    take key, like k

  task get-entries
    take self
    like list

  task get-keys
    take self
    like list

  task get-values
    take self
    like list
```
