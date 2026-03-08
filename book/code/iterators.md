# Iterators

Loop with `walk`. Four variants cover different iteration patterns.

## While Loop (`walk test`)

Loop while a condition is true:

```tree
save i, mark 0
save total, mark 0
walk test
  hook test
    call is-below
      bind a, read i
      bind b, mark 10
  hook hold
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
walk list, read items
  hook next
    take site, name item
    call show, read item
```

Process each item:

```tree
save total, mark 0
walk list, read numbers
  hook next
    take site, name n
    save total
      call add
        bind a, read total
        bind b, read n
```

## Range Loop (`walk size`)

Loop over a numeric range:

```tree
walk size
  bind base, 0
  bind head, 10
  hook next
    take slot, name i
    call show, read i
```

## Iterator Protocol (`walk form`)

Iterate using an iterator object:

```tree
walk form, read iter
  hook next
    take site, name item
    call process
      bind item, read item
```

### Pre/Post Conditions (`hold`)

Add invariants that must hold before and after each iteration:

```tree
walk form, read items
  hold
    call is-sorted
      bind list, read items
  hook next
    take site, name item
    call process
      bind item, read item
  hold
    call is-sorted
      bind list, read items
```

The first `hold` is the precondition (checked before the loop body).
The second `hold` is the postcondition (checked after each iteration).

## Break (`halt`)

Exit a loop early:

```tree
save found, wave false
walk list, read items
  hook next
    take site, name item
    fork test
      hook test
        call is-match
          bind item, read item
      hook hold
        save found, wave true
        halt flow
```

## Continue (`turn next`)

Skip to the next iteration:

```tree
walk list, read items
  hook next
    take site, name item
    fork test
      hook test
        call is-skip
          bind item, read item
      hook hold
        turn next
    call process
      bind item, read item
```

## Iterator Form (Stdlib)

The standard library defines the iterator interface:

```tree
form walk
  head t

  task get-next
    take self

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
| `walk test` | `while (cond)` | `hook test`/`hook hold` | Condition-based loop |
| `walk list` | `for x in list` | `hook next` | Collection iteration |
| `walk size` | `for i in 0..n` | `hook next` | Counted loop |
| `walk form` | `for x in iter` | `hook next` | Iterator protocol |
