# Collections

Seed provides lists and maps as core data structures.

## Lists

Create a list with `make list`:

```tree
save items
  make list
    save item, 1
    save item, 2
    save item, 3
```

or

```tree
save items
  make list
    1
    2
    3
```

Access elements:

```tree
save first
  call items/get
    bind index, 0
```

Add elements:

```tree
call items/push
  bind item, 4
```

Get the size:

```tree
save count
  call items/get-size
```

Check if empty:

```tree
fork test
  hook test
    call items/is-empty
  hook hold
    show <no items>
```

Iterate over a list:

```tree
walk list, read items
  hook next
    take site, name item
    show read item
```

## Maps

Create a map with `make find`:

```tree
save table
  make find
    save a, <name>
    save b, <alice>
```

Look up a value:

```tree
save name
  call table/get
    bind key, <name>
```

Set a value:

```tree
call table/set
  bind key, <age>
  bind value, 30
```

Check for a key:

```tree
fork test
  hook test
    call table/has
      bind key, <name>
  hook hold
    show <found>
```

Remove a key:

```tree
call table/remove
  bind key, <name>
```

Iterate over entries:

```tree
walk list, call table/get-entries
  hook next
    take site, name entry
    call show, read entry/key
    call show, read entry/value
```
