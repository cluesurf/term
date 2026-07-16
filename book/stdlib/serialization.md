# Serialization

Serialization turns a value into text you can store or send, and back. The `json` module is the standard path. It wraps each backend's native JSON library, so there is no hand-rolled parser and the behavior matches the platform. A parsed value is an opaque **dynamic** value (a JavaScript any, a Rust `serde_json::Value`, a Swift or Kotlin `Any`). You read fields off it with typed accessors, and you build one back up with the maker tasks.

Maps to: `JSON.parse` / `JSON.stringify`, or `serde_json` on Rust.

## Cheatsheet

All tasks live in `@cluesurf/seed/code/json`.

### Parse and print

| Task | Does |
| --- | --- |
| `parse` | text to a dynamic value |
| `stringify` | a dynamic value to text |

### Read a parsed value

| Task | Does |
| --- | --- |
| `get-field` | the value at an object key (dynamic) |
| `get-item` | the value at an array index (dynamic) |
| `as-number` | a dynamic value as a number |
| `as-text` | a dynamic value as text |
| `as-boolean` | a dynamic value as a boolean |
| `is-null` | whether the value is null |
| `field-text` | `get-field` then `as-text`, in one step |
| `field-number` | `get-field` then `as-number` |
| `field-boolean` | `get-field` then `as-boolean` |

### Build a value to print

| Task | Does |
| --- | --- |
| `make-object` | a new empty object |
| `set-field` | set a key on an object, returns the object so calls chain |
| `make-array` | a new empty array |
| `push-item` | append to an array, returns the array |
| `from-text` / `from-number` / `from-boolean` | a scalar dynamic value |
| `make-null` | the null value |

The reader side and the builder side mirror each other. Field accessors read a typed form out of dynamic JSON. The makers assemble a dynamic value from a typed form, ready to stringify.

## Parsing into a typed form

Parse the text once, then read each field with the typed accessor. `field-text`, `field-number`, and `field-boolean` combine the field lookup and the coercion, so the common case is one call per field.

```tree
load @cluesurf/seed/code/json
  find parse
  find field-text
  find field-number

form user
  link name, like text
  link age, like number

task read-user
  take raw, like text
  like user
  save value
    call parse
      read raw
  send back
    make user
      bind name
        call field-text
          read value
          text <name>
      bind age
        call field-number
          read value
          text <age>
```

Given `{"name":"ada","age":36}`, `read-user` produces a typed `user`.

## Reading nested and array values

Walk into nested objects with `get-field` and into arrays with `get-item`, then coerce at the leaf.

```tree
load @cluesurf/seed/code/json
  find parse
  find get-field
  find get-item
  find as-text

# pull data/items[0]/label out of a JSON blob
task first-label
  take raw, like text
  like text
  save root
    call parse
      read raw
  send back
    call as-text
      call get-field
        call get-item
          call get-field
            read root
            text <items>
          code 0
        text <label>
```

## Building and printing

To serialize, assemble a dynamic value with the makers, then `stringify`. `set-field` and `push-item` return their container, so the calls chain naturally.

```tree
load @cluesurf/seed/code/json
  find make-object
  find set-field
  find from-text
  find from-number
  find stringify

task write-user
  take person, like user
  like text
  save object
    call set-field
      call set-field
        call make-object
        text <name>
        call from-text
          read person/name
      text <age>
      call from-number
        read person/age
  send back
    call stringify
      read object
```

## Round-tripping

`parse` and `stringify` are inverses for any JSON value. Reading a form out and writing it back gives equivalent text, which makes the pair safe for storage, caching, and message passing.

```tree
task round-trip
  take raw, like text
  like text
  send back
    call stringify
      call parse
        read raw
```

For binary formats and field-renaming wire schemas, define your own mapping tasks on the same pattern: a reader that pulls typed fields out, and a writer that assembles them back. The `json` module is the reference for that shape.
