# Iterators

Loop with `walk`. Four variants cover different iteration patterns.

## While Loop (`walk test`)

Loop while a condition is true:

```tree
save i, mark 0
save total, mark 0
walk test
  call lt
    bind a, read i
    bind b, mark 10
  hook step
    save total
      call add
        bind a, read total
        bind b, read i
    save i
      call add
        bind a, read i
        bind b, mark 1
send back, read total
```

## For-Each (`walk list`)

Iterate over a collection:

```tree
walk list
  read items
  hook tick
    take item
    show read item
```

Process each item:

```tree
save total, mark 0
walk list
  read numbers
  hook tick
    take n
    save total
      call add
        bind a, read total
        bind b, read n
```

## Range Loop (`walk size`)

Loop over a numeric range:

```tree
walk size
  mark 0
  mark 10
  hook step
    take i
    show read i
```

## Iterator Protocol (`walk site`)

Iterate using an iterator object:

```tree
walk site
  read iter
  hook tick
    take item
    call process
      bind item, read item
```

## Break (`halt`)

Exit a loop early:

```tree
save found, wave false
walk list
  read items
  hook tick
    take item
    fork test
      call is-match, bind item, read item
      hook true
        save found, wave true
        halt
```

## Continue (`next`)

Skip to the next iteration:

```tree
walk list
  read items
  hook tick
    take item
    fork test
      call is-skip, bind item, read item
      hook true
        next
    call process
      bind item, read item
```

## Iterator Form (Stdlib)

The standard library defines the iterator interface:

```tree
form walk
  head t

  task get-next
    take self, flex true

  task get-size
    take self
    like u64

  task map
    head s
    take self
    like walk

  task filter
    take self
    like walk

  task collect
    take self
    like list

  task reduce
    take self

  task zip
    take self
    take other, like walk

  task flatten
    take self
    like walk

  task get-first
    take self

  task test-all
    take self
    like boolean

  task test-any
    take self
    like boolean
```

## Walk Variant Summary

| Variant | Traditional | Hook | Use |
| --- | --- | --- | --- |
| `walk test` | `while (cond)` | `hook step` | Condition-based loop |
| `walk list` | `for x in list` | `hook tick` | Collection iteration |
| `walk size` | `for i in 0..n` | `hook step` | Counted loop |
| `walk site` | `for x in iter` | `hook tick` | Iterator protocol |
