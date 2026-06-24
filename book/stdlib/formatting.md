# Formatting

Formatting is turning a value into display text: padding a number, casing a word, joining a list, building a label. The `text` module carries the string operations, `list/join` assembles pieces, and `rune` handles single characters. This page covers what is in the box today, then sketches the higher-level number, unit, and currency formatting that builds on it.

Maps to: the JavaScript `String` methods plus `Array.join`, or Rust's `format!` building blocks.

## Cheatsheet

### text (`@cluesurf/base/code/text`)

| Task | Does |
| --- | --- |
| `to-upper-case` / `to-lower-case` | change case |
| `trim` / `trim-start` / `trim-end` | drop surrounding whitespace |
| `pad-left` / `pad-right` | pad to a width with a fill string |
| `substring` | a slice by start and end index |
| `split` | break into a list on a delimiter |
| `replace` / `replace-all` | substitute text |
| `starts-with` / `ends-with` / `contains` | test for a substring |
| `index-of` / `last-index-of` | find a substring's position |
| `char-at` / `char-code-at` | a single character or its code |

### list (`@cluesurf/base/code/list`)

| Task | Does |
| --- | --- |
| `join` | join items into one text with a separator |

### rune (`@cluesurf/base/code/rune`)

| Task | Does |
| --- | --- |
| `is-ascii-digit` / `is-ascii-letter` / `is-ascii-whitespace` | ASCII category tests |
| `is-letter` / `is-number` / `is-whitespace` / `is-uppercase` / `is-lowercase` / `is-alphanumeric` / `is-control` | full Unicode category tests |
| `to-uppercase` / `to-lowercase` | Unicode case mapping of one code point |

## Padding to a fixed width

`pad-left` and `pad-right` grow a string to a target width with a fill. This is how you right-align numbers or left-align labels in a table.

```tree
load @cluesurf/base/code/text
  find pad-left
  find pad-right

# 000042
host id
  call pad-left
    text <42>
    code 6
    text <0>

# "hello     "
host label
  call pad-right
    text <hello>
    code 10
    text < >
```

## Casing

```tree
load @cluesurf/base/code/text
  find to-upper-case

host shout
  call to-upper-case
    text <hello>      # HELLO
```

For a single character, `rune` does Unicode-correct case mapping and category tests over the whole code space.

```tree
load @cluesurf/base/code/rune
  find make-rune

host is-digit
  call is-ascii-digit
    call make-rune
      code 55          # the rune '7', true
```

## Joining pieces

Build a line by collecting parts into a list and joining them. `join` puts the separator between items and nothing on the ends.

```tree
load @cluesurf/base/code/list
  find list

task path-of
  take parts, like list
  like text
  send back
    call join
      read parts
      text </>
```

## Building a labeled value

Combine the pieces to format a display string. `split` and `join` together let you reshape delimited text.

```tree
load @cluesurf/base/code/text
  find split

# turn "a,b,c" into "a | b | c"
task respace
  take raw, like text
  like text
  send back
    call join
      call split
        read raw
        text <,>
      text < | >
```

## Number, unit, and currency formatting

Locale-aware number formatting (grouping separators, compact notation like `1.5M`, percentages, ordinals), unit conversion (kilometers to miles, Celsius to Fahrenheit), and money (a fixed-point amount with a currency) are display concerns that build on the primitives above. The intended shape is:

- A **number formatter** takes a value plus a locale and precision, and returns text. Grouping and the decimal mark follow the locale.
- A **measure** pairs a numeric value with a unit, and a conversion maps it to a compatible unit. Mixing incompatible dimensions (length and weight) is a type error.
- A **money** value holds an amount in the currency's smallest unit (cents for USD, whole yen for JPY) as an integer, so arithmetic never drifts. Formatting applies the currency's symbol and decimal places.

These follow the same delegate-to-the-host pattern as `json` and `rune`: a clean Term-level API on top of each platform's locale library. Until a given formatter is part of `@cluesurf/base`, compose the display yourself from `pad-left`, casing, and `join`, which are exact and identical on every backend.
