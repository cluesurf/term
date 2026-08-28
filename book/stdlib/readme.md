# The standard library

`@cluesurf/seed` is the library that ships in the box. It is written in Term itself, in `.tree` files under `code/`, so every module reads like the code in the rest of this book. Each module is one type or one small family of functions. You bring a module in with `load` and use what it exposes.

Maps to: Rust's `std`, Go's standard library, the JavaScript built-ins plus a curated set of helpers.

## The modules

Every module lives at `@cluesurf/seed/code/<name>`. Load the form or task you need with `find`.

| Module | Path | What it gives you |
| --- | --- | --- |
| numbers | `code/math` | `absolute`, `minimum`, `maximum`, `power`, `sign`, `square-root`, `clamp`, `greatest-common-divisor`, `factorial` |
| floats | `code/float` | floating-point math (real division, roots, rounding) |
| rationals | `code/rational` | exact fractions |
| text | `code/text` | string operations: `split`, `substring`, `trim`, `replace`, `pad-left`, `contains`, casing |
| runes | `code/rune` | a single Unicode code point and its category predicates |
| boolean | `code/boolean` | `and`, `or`, `not` |
| maybe | `code/maybe` | an optional value (`some` / `none`) |
| result | `code/result` | a success-or-error value (`okay` / `error`) |
| list | `code/list` | the array type and its map / filter / reduce / sort verbs |
| hash | `code/hash` | a key-value map |
| set | `code/set` | a collection of unique values |
| pair | `code/pair` | a two-value tuple |
| ordering | `code/ordering` | the three-way comparison result (`less` / `equal` / `greater`) |
| plain-date | `code/plain-date` | a calendar date with no time zone |
| duration | `code/duration` | a span of elapsed time |
| statistics | `code/statistics` | `total`, `mean`, `least`, `greatest`, `span` over a list |
| json | `code/json` | parse, stringify, and navigate JSON |
| bytes | `code/bytes` | raw byte buffers |
| uuid | `code/uuid` | unique identifiers |
| regex | `code/regex` | pattern matching |
| range | `code/range` | a numeric interval |

Reference-style detail pages: [datetime](datetime.md), [validation](validation.md), [serialization](serialization.md), [queries](queries.md), [formatting](formatting.md).

## Loading a module

A `load` block names a package path, then `find` names each thing to pull in. Use `find`, never `take`, inside a `load`.

```tree
load @cluesurf/seed/code/list
  find list

load @cluesurf/seed/code/maybe
  find maybe
  find unwrap-or
```

After that, the names are in scope. A method on a form is called by name (`call get`) or member-style through the value (`call self/push`). A free task is called directly (`call total`).

## A first taste

```tree
load @cluesurf/seed/code/list
  find list

load @cluesurf/seed/code/statistics
  find mean

# the average of a list of numbers
task average
  take scores, like list
  like number
  send back
    call mean
      read scores
```

## How the library is organized

- **Scalar types** (`number`, `text`, `boolean`) and their helpers live directly in `code/`.
- **Container types** (`list`, `hash`, `set`, `pair`) carry their operations as methods on the form.
- **Wrapper types** (`maybe`, `result`) model presence and failure. They replace null and exceptions for ordinary control flow. See [errors](../language/errors.md) for `halt <form>` and `halt kink`, which handle the exceptional path.
- **Domain types** (`plain-date`, `duration`, `uuid`, `regex`) each own one well-defined value.

Every method that needs the host (a system clock, the JSON parser, Unicode tables) delegates to a per-platform native file under `code/native/<platform>/`. The public API is the same on every backend. Only the implementation differs.

## A note on numbers

`number` is the platform integer (`i64` on Rust, `Int`/`Long` on the JVM, a JavaScript number). Integer division truncates and rounding is the identity, so for exact fractional work reach for the `float` or `rational` module. The [datetime](datetime.md) and [duration](datetime.md) types are built entirely on integer arithmetic, which is why they give the same answer on every backend.
