# Querying collections

Most data work is filtering, transforming, and summarizing a collection. The `list` type carries the full set of verbs as methods, so a query is a chain of `map` / `filter` / `reduce` over a list. Sets and maps add membership and key operations on top. The `ordering` type is the currency for comparing.

Maps to: JavaScript array methods, Rust iterator adapters, or LINQ.

## Cheatsheet

### list (`@term/base/code/list`)

| Verb | Does |
| --- | --- |
| `map` | transform each item into a new list |
| `filter` | keep items that pass a test |
| `reduce` | fold the list into a single value with an accumulator |
| `find` | the first item passing a test, as a `maybe` |
| `find-index` | the index of the first match (or below zero) |
| `any` / `all` | whether some / every item passes a test |
| `contains` | whether a value is present |
| `index-of` / `last-index-of` | position of a value |
| `first` / `last` | the end items, as a `maybe` |
| `size` / `count` / `is-empty` | length facts |
| `push` / `pop` | add to / remove from the back |
| `get` / `set` | read / write at an index |
| `slice` / `take-first` / `drop-first` / `take-last` / `drop-last` | sub-ranges |
| `concat` / `flatten` | join lists |
| `reverse` | a reversed copy |
| `unique` | drop duplicates |
| `join` | a single text, items separated |
| `sum` / `product` | numeric folds |
| `copy` / `clear` | shallow copy / empty in place |

### set (`@term/base/code/set`)

| Verb | Does |
| --- | --- |
| `insert` / `remove` / `has` | membership |
| `union` / `intersection` / `difference` / `symmetric-difference` | set algebra |
| `is-subset` / `is-superset` | containment |
| `size` / `count` / `is-empty` / `to-list` / `clear` | shape and conversion |

### hash (`@term/base/code/hash`)

| Verb | Does |
| --- | --- |
| `get` | a key's value, as a `maybe` |
| `get-or-default` | a key's value, or a fallback |
| `set` / `remove` / `has` | write / delete / test a key |
| `keys` / `values` | the lists of keys and values |
| `merge` | copy another map's entries in |
| `size` / `count` / `is-empty` / `clear` | shape |

### ordering and statistics

| Name | Module | Does |
| --- | --- | --- |
| `from-numbers` | `code/ordering` | the three-way comparator for two numbers |
| `reverse` | `code/ordering` | flip a comparison (ascending to descending) |
| `is-less` / `is-equal` / `is-greater` | `code/ordering` | read off a comparison |
| `total` / `mean` / `least` / `greatest` / `span` | `code/statistics` | summarize a list of numbers |

## Map, filter, reduce

These three cover most queries. `map` changes each item, `filter` drops items, `reduce` collapses the list. Each takes an inline `task` as its argument.

```tree
load @term/base/code/list
  find list

# the squares of the even numbers
task even-squares
  take values, like list
  like list
  send back
    call map
      call filter
        read values
        task is-even
          take n, like number
          like boolean
          send back
            call is-equal
              call modulo
                read n
                code 2
              code 0
      task square
        take n, like number
        like number
        send back
          call multiply
            read n
            read n
```

`reduce` folds with a running total and an initial value.

```tree
load @term/base/code/list
  find list

task total-length
  take words, like list
  like number
  send back
    call reduce
      read words
      task add-length
        take running, like number
        take word, like text
        like number
        send back
          call add
            read running
            read word/length
      code 0
```

## Finding and testing

`find` returns the first match as a `maybe`, so a miss is `none` rather than a crash. `any` and `all` ask about the whole list.

```tree
load @term/base/code/list
  find list

task first-big
  take values, like list
  send back
    call find
      read values
      task over-ten
        take n, like number
        like boolean
        send back
          call is-above
            read n
            code 10

task has-negative
  take values, like list
  like boolean
  send back
    call any
      read values
      task is-negative
        take n, like number
        like boolean
        send back
          call is-below
            read n
            code 0
```

## Summarizing

For numeric lists, the `statistics` module reads off the common aggregates directly. `least`, `greatest` and `span` need a non-empty list and say so with a `have`, so a task that calls them states the same `have` (or checks the length first).

```tree
load @term/base/code/list
  find list

load @term/base/code/statistics
  find mean
  find greatest
  find span

task summary
  take values, like list
  have
    call is-above
      read values/length
      code 0
  save average
    call mean
      read values
  save high
    call greatest
      read values
  save spread
    call span         # greatest minus least
      read values
```

## Sorting

Sorting needs a comparator: a function that returns an `ordering`. The `from-numbers` task is the base comparator for numbers, and `reverse` flips it for descending order. `list` has no sort method yet, so the comparator is what you write today and hand to your own sort.

```tree
load @term/base/code/ordering
  find ordering
  find from-numbers

# compare two records by their score, descending
task by-score-desc
  take left, like record
  take right, like record
  like ordering
  send back
    call reverse
      call from-numbers
        read left/score
        read right/score
```

A comparator that returns `less`, `equal`, or `greater` plugs into any ordered structure.

## Set and map queries

A `set` answers membership and the standard algebra. A `hash` answers key lookups, returning a `maybe` so a missing key is handled, not assumed.

```tree
load @term/base/code/set
  find set

load @term/base/code/hash
  find hash

# the tags in both sets
task shared
  take mine, like set
  take theirs, like set
  send back
    call intersection
      read mine
      read theirs

# a config value with a default
task port
  take config, like hash
  send back
    call get-or-default
      read config
      text <port>
      code 8080
```

## A full query

These compose. A typical pipeline filters, maps, then summarizes.

```tree
load @term/base/code/list
  find list

load @term/base/code/statistics
  find mean

form item
  link price, like number
  link in-stock, like boolean

# the average price of in-stock items
task average-in-stock
  take items, like list
  like number
  save in-stock
    call filter
      read items
      task available
        take it, like item
        like boolean
        send back, read it/in-stock
  save prices
    call map
      read in-stock
      task price-of
        take it, like item
        like number
        send back, read it/price
  send back
    call mean
      read prices
```
