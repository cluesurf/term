# Parsers

Define grammars with `mill`. Match patterns with `mine`. Build AST
nodes with `mint`.

## Two Types of Mill

There are two fundamentally different kinds of mill:

### Code Mills (String/Binary Parsers)

Code mills parse raw text or binary data. They operate on byte
streams and character sequences, similar to PEG or ABNF grammars.
These live in the `code.tree` package
(`deck/seed/deck/code.tree/code/`).

Examples of code mills:
- `cookie/mine.tree` - HTTP cookie header parsing (RFC 6265)
- `json/mine.tree` - JSON text parsing
- `http/mine.tree` - HTTP protocol parsing
- `html/mine.tree` - HTML parsing
- `csv/mine.tree` - CSV parsing
- `font/otf/mine.tree` - OpenType font binary parsing
- `image/png/mine.tree` - PNG binary parsing
- `uri/mine.tree` - URI parsing
- `tree/mine.tree` - .tree syntax parsing (the language itself)

Code mills match against raw input streams. They are traditional
parser grammars written in .tree syntax.

### Term Mills (Tree AST Transformers)

Term mills transform pre-parsed Tree AST nodes into typed IR nodes.
The input is NOT raw text. It is the generic Tree AST produced by
the Phase 0 tree parser. Term mills recognize keyword patterns in
the tree structure and construct typed surface AST nodes.

These live in the `base.tree` package
(`deck/seed/deck/term.tree/code/`).

Term mills use `mine term` to match tree nodes by keyword. For
example, `mine term, term bind` matches a TreeBlock whose keyword
is `bind`. They use `take` to extract values from matched nodes.

Examples of term mills:
- `code/` - Parse Term language keywords (task, form, call, etc.)
- `math/` - Parse proof keywords (rule, test, form, hold)
- `book/` - Parse documentation structure
- `deck/` - Parse package manifests

Term mills do not see characters or bytes. They see tree nodes
(blocks, strings, numbers) produced by the tree parser. Their job is
to give semantic meaning to keyword structures.

### How They Connect

The Phase 0 tree parser always runs first on `.tree` files,
producing generic Tree AST. Then a term mill (determined by the
file's role) transforms that Tree AST into typed IR.

Code mills are used when Seed programs need to parse external
formats at runtime or compile time. They define grammars for data
formats (JSON, HTTP, CSV, binary formats) that Seed code can use.

## The Mine/Mint Architecture

A mill has two halves that work together:

- **mine** (parser) - Matches patterns in the input stream and emits
  named nodes via `take`. The mine parses tree structure into labeled
  events.
- **mint** (builder) - Watches the mine's event stream. When the mine
  emits a node, the mint catches it with `case`, stores it with `slot`,
  and when the mine finishes a complete node, the mint's `hook make`
  fires to construct the final typed AST node via `make`.

Mine and mint are defined in separate files but are interwoven at
runtime. The mine drives the parsing, and the mint observes each
successfully parsed node as it arrives. This supports lazy/JIT
evaluation and error recovery. The mint defines the final AST node
shapes that the compiler uses for type checking and code generation.

### Data Flow

```
input stream
  -> mine (pattern match, emit named nodes via `take`)
    -> mint (observe via `case`, store via `slot`)
      -> hook make (fires when mine completes a node)
        -> make (construct typed AST node)
```

### How `take` Names Map to `case` Names

The `take` names in the mine correspond directly to the `case` names
in the mint. When the mine does `take path`, the mint's `case path`
fires. This is the contract between mine and mint:

```
mine load                     mint load, like import
  mine term, term load
    mine text
      take path          ->     case path
    mine list                     slot path
      mine form, form find
        take find        ->     case find, mint reference
                                  slot reference
```

## Mine Scoping Rules

There are two levels of `mine` usage:

**Top-level `mine`** defines a named rule. The second word is a custom
name you choose:

```tree
mine indented-term
  take indent, like size
  mine form, form indent
    bind abind, read indent
  mine form, form inline-term
```

```tree
mine comment
  mine <#>
  mine < >
  mine maybe
    mine not
      mine <\n>
```

**Nested keywords** (inside a rule body) use specific built-in keywords.
These are NOT custom names. They are fixed operations that differ
between code mills and term mills. Two prefixes: `mine` (match/check)
and `look` (lookaround without consuming).

### Code Mill Nested Keywords

| Nested keyword | Purpose | Example |
|----------------|---------|---------|
| `mine <...>` | Match literal string | `mine <hello>` |
| `mine range` | Match character range | `mine range, <a>, <z>` |
| `mine form` | Delegate to named rule | `mine form, form number` |
| `mine flow` | Sequence (in order) | children matched in order |
| `mine list` | Repetition | `bind minimum` / `bind maximum` for bounds |
| `mine any` | Alternatives (one of) | first matching child wins |
| `mine test` | Conditional | `hook test` / `hook hold` / `hook miss` |
| `mine maybe` | Optional (zero or one) | `mine maybe` + child |
| `mine not` | Negation (not this) | `mine not` + child |
| `mine any` | Any order | children in any order |
| `look after` | Lookahead (no consume) | `look after` + child |
| `look before` | Lookbehind (no consume) | `look before` + child |

### Term Mill Nested Keywords

| Nested keyword | Purpose | Example |
|----------------|---------|---------|
| `mine term` | Match tree node by keyword | `mine term, term bind` |
| `mine form` | Delegate to named rule | `mine form, form sift` |
| `mine case` | Match one of several alternatives | variant dispatch |
| `mine list` | Match repeated children | collect into list |
| `mine maybe` | Optional child | `mine maybe` + child |
| `mine text` | Match raw text content | extract string value |
| `mine path` | Match a path/road expression | extract path |
| `take` | Extract and emit named value | `take name` |

You cannot invent new nested keywords. `mine size-repeat` is NOT valid.
To express "repeat N times", compose the built-in keywords.

## Code Mill: Match Patterns (`mine`)

These patterns apply to code mills (string/binary parsing).

### Literal Text

```tree
mine <hello>
mine <true>
mine <null>
```

### Character Range

Match a range of characters:

```tree
mine range
  bind start, <a>
  bind end, <z>
```

Can do short form:

```tree
mine range, <a>, <z>
```

```tree
mine range
  bind start, <A>
  bind end, <Z>
```

```tree
mine range
  bind start, <0>
  bind end, <9>
```

Or code points:

```tree
mine range
  bind start, 0
  bind end, 9
```

### Delegate to Named Rule

```tree
mine form, form identifier
mine form, form expression
mine form, form number
```

### Sequence

Match items in order:

```tree
mine flow
  mine <[>
  mine form, form value
  mine <]>
```

### Alternatives

Match one of several options:

```tree
mine any
  mine <true>
  mine <false>
  mine <null>
```

### Repetition

Repeat a child pattern (zero or more by default):

```tree
mine list
  mine range, <a>, <z>
```

With bounds:

```tree
mine list
  bind minimum, 1
  bind maximum, 3
  mine range, <0>, <9>
```

### Named Pattern

```tree
mine identifier
  mine list
    mine range
      bind start, <a>
      bind end, <z>
    mine maybe
      mine range
        bind start, <a>
        bind end, <z>
```

### Conditional Match

```tree
mine test
  hook test
    meet and
      call is-equal
        something
      call is-equal
        something
        else
  hook hold
    mine form, form number
  hook miss
    mine form, form identifier
```

### Check (Lookahead / Lookbehind)

Match without consuming. Use `look after` for lookahead, `look before`
for lookbehind:

```tree
look after
  mine <=>
```

```tree
look before
  mine <\n>
```

### Optional

```tree
mine maybe
  mine <->
```

### Negation

Match anything except:

```tree
mine not
  mine <">
```

## Term Mill: Match Patterns (`mine`)

These patterns apply to term mills (Tree AST transformers).

### Match Tree Node by Keyword

`mine term` matches a TreeBlock by its keyword:

```tree
mine bind
  mine term, term bind
    mine term
      take name
    mine maybe
      mine form, form sift
        take sift
```

Each `take` emits a named value that the mint watches via `case`.
The name you give to `take` must match the `case` name in the
corresponding mint.

### Match Any Child Term

`mine term` without arguments matches the next child:

```tree
mine term
  take value
```

### Match Text Content

`mine text` matches raw text content from the tree:

```tree
mine load
  mine term, term load
    mine text
      take path
```

### Match Alternatives with `mine case`

`mine case` matches one of several possible child types. Only one
child matches per parse event:

```tree
mine sift
  mine case
    mine text
      take text
    mine form, form link
      take link
    mine form, form call
      take call
    mine form, form make
      take make
```

### Match Repeated Children with `mine list`

`mine list` matches zero or more children of a given form. Each
match emits a `take` event, which the mint accumulates into a list
via `slot`:

```tree
mine form
  mine term, term form
    mine term
      take name
    mine list
      mine form, form head
        take head
    mine list
      mine form, form task
        take task
```

### Match Optional Children with `mine maybe`

`mine maybe` matches zero or one child:

```tree
mine find
  mine term, term find
    mine term
      take text
    mine maybe
      mine term, term name
        mine term
          take name
```

### Full Term Mill Example

The `form` keyword (type definition) mine:

```tree
mine form
  mine term, term form
    mine term
      take name
    mine list
      mine form, form head
        take head
    mine list
      mine form, form link
        take link
    mine list
      mine form, form bond
        take bond
    mine list
      mine form, form rein
        take rein
    mine list
      mine form, form task
        take task
```

## AST Builder (`mint`)

The `mint` DSL is the builder half of a mill. While `mine` parses the
input stream, `mint` observes the parse events and constructs typed AST
nodes.

### Declaring a Mint Builder

Top-level `mint` declares a named builder and its output type:

```tree
mint load, like import
```

The `like` clause references the target `form` that this mint
constructs. Import the form at the top of the file:

```tree
load @cluesurf/base/code/import
  find import
  find import-reference
```

### Watching Mine Events with `case`

Each `case` watches for when the mine emits a node with a matching
`take` name. When the mine does `take path`, the mint's `case path`
fires:

```tree
mint load, like import
  case path
    slot path
  case find, mint reference
    slot reference
```

**Simple case** stores the raw value directly:

```tree
case path
  slot path
```

**Delegating case** passes the matched node to a sub-mint builder:

```tree
case find, mint reference
  slot reference
```

When `case find, mint reference` matches, the node is handed to
`mint reference` which constructs its own typed result (an
`import-reference`). That result is then stored in `slot reference`.

### Storing Values with `slot`

`slot` stores a temporary variable for use in `hook make`. It has
two behaviors depending on the target form field:

- **Scalar storage**: If the target form field is a single value
  (`link name, like term`), `slot` stores it (last write wins).
- **List accumulation**: If the target form field is a list
  (`link reference, list import-reference`), each `slot` call pushes
  the value into a temporary array.

```tree
case path
  slot path          # scalar: stores one path string

case find, mint reference
  slot reference     # list: pushes each reference into array
```

### Constructing the Node with `hook make`

`hook make` is a special callback that fires when the mine finishes
parsing the current node. Inside, use `make` to construct the final
typed AST node, and `bind`/`read` to wire up fields from stored slots:

```tree
hook make
  make import
    bind path, read path
    bind reference, read reference
```

`make import` creates an `import` form instance. `bind path, read path`
sets the `path` field to the value stored in the `path` slot.

### Variant/Union Types

When a mint represents a variant (one of several possible types),
each `case` delegates to a different sub-mint. Only one case fires
per parse event, and the result passes through:

```tree
mint sift
  case text
    slot value
  case link, mint link
    slot value
  case move, mint move
    slot value
  case read, mint read
    slot value
  case call, mint call
    slot value
  case make, mint make
    slot value
```

Each case stores into the same `slot value`. The corresponding mine
uses `mine case` for alternatives:

```tree
mine sift
  mine case
    mine text
      take text
    mine form, form link
      take link
    mine form, form move
      take move
    mine form, form call
      take call
    mine form, form make
      take make
```

### Nested Mints for Complex Structures

Mints compose by delegation. A parent mint delegates to child mints
via `case <name>, mint <child>`. Each child mint has its own `like`
type, `case`/`slot` logic, and `hook make`:

```tree
mint call, like call
  case name
    slot name
  case bind, mint bind
    slot bind
  case hook, mint hook
    slot hook
  hook make
    make call
      bind name, read name
      bind bind, read bind
      bind hook, read hook

mint hook, like hook
  case name
    slot name
  case base, mint base
    slot base
  case flow, mint flow
    slot flow
  case task, mint task
    slot task
  hook make
    make hook
      bind name, read name
      bind base, read base
      bind flow, read flow
      bind task, read task
```

### Top-Level Dispatch

The top-level mint dispatches to sub-mints for each keyword type.
It acts as a router, with no `hook make` of its own:

```tree
mint code
  case form, mint form
    slot form
  case task, mint task
    slot task
  case call, mint call
    slot call
  case load, mint load
    slot load
  case test, mint test
    slot test
```

### Complete Reference Example: Load/Import

The canonical mine/mint pair for parsing `load` statements:

**mine** (`code/load/mine.tree`):

```tree
mine load
  mine term, term load
    mine text
      take path
    mine list
      mine form, form find
        take find

mine find
  mine term, term find
    mine term
      take text
    mine maybe
      mine term, term name
        mine term
          take name
```

**mint** (`code/load/mint.tree`):

```tree
load @cluesurf/base/code/import
  find import
  find import-reference

mint load, like import
  case path
    slot path
  case find, mint reference
    slot reference
  hook make
    make import
      bind path, read path
      bind reference, read reference

mint reference, like import-reference
  case text
    slot name
  case name
    slot alias
  hook make
    make import-reference
      bind name, read name
      bind alias, read alias
```

The mapping:
- `take path` -> `case path` -> `slot path` -> `bind path, read path`
- `take find` -> `case find, mint reference` -> `slot reference` -> `bind reference, read reference`
- `take text` -> `case text` -> `slot name` -> `bind name, read name`
- `take name` -> `case name` -> `slot alias` -> `bind alias, read alias`

Note that the `slot` name can differ from the `case` name. The `case`
matches the mine's `take` name. The `slot` stores under the name used
by `read` in `hook make`. This lets you rename values between parsing
and construction.

## Full Example: Cookie Parser (Code Mill)

```tree
mill cookie
  bind mine, load ./mine
  bind mint, load ./mint
```

```tree
mine cookie
  mine form, form cookie-pair
    mine flow
      mine form, form cookie-name
      mine <=>
      mine form, form cookie-value

mine cookie-name
  mine list
    mine not
      mine any
        mine range, <0>, <31>
        mine <127>
        mine < >
        mine <;>
        mine <=>

mine cookie-value
  mine maybe
    mine any
      mine flow
        mine <">
        mine form, form cookie-octets
        mine <">
      mine form, form cookie-octets
```

## Summary (Code Mill)

| Keyword | Purpose | Example |
| --- | --- | --- |
| `mine <...>` | Literal string | `mine <hello>` |
| `mine range` | Character range | `mine range, <a>, <z>` |
| `mine form` | Delegate to named rule | `mine form, form number` |
| `mine flow` | Sequence | children in order |
| `mine list` | Repetition | `bind minimum` / `bind maximum` for bounds |
| `mine any` | Alternatives | first matching child |
| `mine test` | Conditional | `hook test` / `hook hold` / `hook miss` |
| `mine maybe` | Optional | zero or one |
| `mine not` | Negation | match anything except |
| `look after` | Lookahead | match without consuming |
| `look before` | Lookbehind | match behind cursor |

## Summary (Term Mill)

| Keyword | Purpose | Example |
| --- | --- | --- |
| `mine term` | Match tree node | `mine term, term bind` |
| `mine form` | Delegate to named rule | `mine form, form sift` |
| `mine case` | Match alternatives | variant dispatch |
| `mine list` | Match repeated children | collect into list |
| `mine maybe` | Optional child | `mine maybe` + child |
| `mine text` | Match text content | extract string |
| `mine path` | Match path | extract path |
| `take` | Emit named value | `take name` |

## Mint Summary

| Keyword | Purpose | Example |
| --- | --- | --- |
| `mint x, like y` | Declare builder for form type | `mint load, like import` |
| `case x` | Watch for mine event by name | `case path` |
| `case x, mint y` | Watch and delegate to sub-mint | `case find, mint reference` |
| `slot x` | Store value (scalar or list push) | `slot path` |
| `hook make` | Callback when mine finishes node | `hook make` |
| `make x` | Construct typed AST node | `make import` |
| `bind x, read y` | Set field from stored slot | `bind path, read path` |
