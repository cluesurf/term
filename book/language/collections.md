# Collections

Three collections ship in the standard library: the **list** (a growable array), the **hash** (a key/value map), and the **set** (unique values). Each is a `form` with `task` methods you call by name. There is also an inductive **roll** (`nil | cons`), the proof-friendly cousin of `list`.

Maps to: `Array` / `Vec`, `Map` / `HashMap`, `Set` / `HashSet`, plus a classic cons-list.

## Cheatsheet

### Construction

| Collection | Build with | Empty value |
| --- | --- | --- |
| list | `make list` | `make list` |
| hash | `make find` | `make find` |
| set | `make set` then `bind items, make find` | same |
| roll | `make nil` / `make cons` | `make nil` |

A `form` literally named `list` is the native array. `make list` produces a native array value, and every list method delegates to a native array operation. The map type is built with `make find` (not `make hash`).

### List methods

| Method | Shape | Does |
| --- | --- | --- |
| `size` / `count` | `(self) number` | element count |
| `is-empty` | `(self) boolean` | true when length is 0 |
| `push` | `(self, item) number` | append, return new length |
| `pop` | `(self) t` | remove and return the last element |
| `get` | `(self, index) t` | element at an index |
| `set` | `(self, index, item) list` | overwrite in place |
| `clear` | `(self) list` | empty in place |
| `copy` | `(self) list` | shallow copy |
| `contains` | `(self, item) boolean` | membership |
| `index-of` / `last-index-of` | `(self, item) number` | first/last position, -1 if absent |
| `find-index` | `(self, test) number` | first index matching a test |
| `find` | `(self, test) maybe` | first element matching a test |
| `join` | `(self, separator) text` | join into text |
| `reverse` | `(self) list` | reversed copy |
| `concat` | `(self, other) list` | join two lists |
| `slice` | `(self, start, end) list` | sublist |
| `map` | `(self, call) list` | transform each element |
| `filter` | `(self, test) list` | keep elements passing a test |
| `any` / `all` | `(self, test) boolean` | exists / for-all |
| `reduce` | `(self, call, initial) s` | fold to one value |
| `first` / `last` | `(self) maybe` | end elements as a `maybe` |
| `take-first` / `drop-first` | `(self, count) list` | prefix / rest from the front |
| `take-last` / `drop-last` | `(self, count) list` | suffix / rest from the back |
| `take` / `drop` | `(self, count, side) list` | take/drop from a runtime side |
| `flatten` | `(self) list` | flatten one nesting level |
| `sum` / `product` | `(self) number` | numeric fold |
| `unique` | `(self) list` | drop duplicates |

### Hash methods

| Method | Shape | Does |
| --- | --- | --- |
| `get` | `(self, key) maybe` | value as a `maybe` (`none` if absent) |
| `get-or-default` | `(self, key, fallback) v` | value or a fallback |
| `set` | `(self, key, value) hash` | insert or overwrite |
| `has` | `(self, key) boolean` | key present |
| `remove` | `(self, key) boolean` | delete a key |
| `size` / `count` | `(self) number` | entry count |
| `is-empty` | `(self) boolean` | true when empty |
| `keys` / `values` | `(self) list` | all keys / all values |
| `clear` | `(self) hash` | empty in place |
| `merge` | `(self, other) hash` | copy entries from another map |

### Set methods

| Method | Shape | Does |
| --- | --- | --- |
| `insert` | `(self, item) set` | add a member |
| `has` | `(self, item) boolean` | membership |
| `remove` | `(self, item) boolean` | drop a member |
| `size` / `count` | `(self) number` | member count |
| `is-empty` | `(self) boolean` | true when empty |
| `to-list` | `(self) list` | members as a list |
| `clear` | `(self) set` | empty in place |
| `union` | `(self, other) set` | members of either |
| `intersect` / `intersection` | `(self, other) set` | members of both |
| `difference` | `(self, other) set` | in self, not other |
| `symmetric-difference` | `(self, other) set` | in exactly one |
| `is-subset` / `is-superset` | `(self, other) boolean` | containment tests |

### Calling style

Both forms work and mean the same thing:

```tree
call get, read items, code 0     # function form
read items/get                   # member form, when the call takes only self
```

A method with arguments reads more clearly in function form. See [operators](operators.md) for `link` chaining.

## Lists

Build a list, then push and read elements. `make list` on its own is the empty list.

```tree
host items
  make list

call push, read items, code 1
call push, read items, code 2
call push, read items, code 3

host first
  call get, read items, code 0      # 1

host count
  call size, read items             # 3
```

`get` returns the raw element. `first` and `last` return a [maybe](structures.md) so the empty case is handled in the types.

```tree
host head
  call first, read items            # make some / bind value, code 1
```

### Transforming

`map`, `filter`, and `reduce` take a function. A function parameter is declared with a nested `like task` (see [functions](functions.md)).

```tree
task double-all
  take xs
    like list
      like number
  like list
    like number
  send back
    call map, read xs
      task each
        take n, like number
        like number
        send back
          call multiply, read n, code 2

task total
  take xs
    like list
      like number
  like number
  send back
    call reduce, read xs
      task step
        take running, like number
        take n, like number
        like number
        send back
          call add, read running, read n
      code 0
```

`sum` is the same fold built in: `call sum, read xs`.

### Iterating

To walk a list element by element, use `walk`. The bound element comes in through `take site, name <label>`.

```tree
walk list, read items
  hook next
    take site, name value
    call write-line, read value
```

`turn next` skips to the next element and `halt` breaks out. Full loop forms are in [loops](loops.md).

## Hashes

The map type is built with `make find`. Keys and values are generic.

```tree
host ages
  make find

call set, read ages, text <ada>, code 36
call set, read ages, text <bob>, code 41

host one
  call get, read ages, text <ada>          # make some / bind value, code 36

host backup
  call get-or-default, read ages, text <eve>, code 0   # 0
```

`get` returns a `maybe`, so a missing key is `none` rather than a crash. Iterate by walking the `keys` list.

```tree
walk list
  call keys, read ages
  hook next
    take site, name key
    call write-line, read key
    call write-line
      call get-or-default, read ages, read key, code 0
```

`merge` folds another map into this one, and `clear` empties it.

```tree
call merge, read ages, read more-ages
call clear, read ages
```

## Sets

A set is built on `make find` for O(1) membership. Construct it by binding its inner map.

```tree
host seen
  make set
    bind items
      make find

call insert, read seen, text <red>
call insert, read seen, text <red>      # no-op, already present

host n
  call size, read seen                  # 1
```

The algebra operations return a new set.

```tree
host both
  call union, read seen, read other

host common
  call intersection, read seen, read other

host only-mine
  call difference, read seen, read other

fork test
  hook test
    call is-subset, read seen, read other
  hook hold
    call write-line, text <seen fits inside other>
```

Read the members back out with `to-list`.

```tree
walk list
  call to-list, read seen
  hook next
    take site, name item
    call write-line, read item
```

## The roll (inductive list)

A `roll` is the cons-list written as a `form` with two cases. It is empty (`nil`) or a head element on top of a tail roll (`cons`). Where `list` is a native array, a `roll` is built one cons at a time and its laws are checkable by the type system. See [math](../math/readme.md) for the proofs.

Maps to: a hand-written `data List a = Nil | Cons a (List a)`.

```tree
form roll
  case nil
  case cons
    link item, like natural
    link more, like roll
```

Build one by nesting `make cons`, ending in `make nil`.

```tree
host one-two
  make cons
    bind item, code 1
    bind more
      make cons
        bind item, code 2
        bind more
          make nil
```

Walk it by matching on the shape. This recursion computes the length.

```tree
task length
  take xs, like roll
  like number
  fork case, read xs
    case nil
      send back, code 0
    case cons
      link more
      send back
        call add
          code 1
          call length, read more
```

`case cons` binds the tail with `link more`, then the body recurses on it. Matching is covered in [matching](matching.md).

## See also

- [loops](loops.md) for `walk`, `turn next`, `halt`.
- [matching](matching.md) for `fork case` over `maybe`, `roll`, and your own types.
- [structures](structures.md) for `maybe`, generics, and building your own collections.
- [operators](operators.md) for `link` chaining of method calls.
