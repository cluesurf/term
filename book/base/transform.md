# Data Transformation (`seed cast`)

Declare named transformations that map one data shape to another.
Useful for converting API responses to database models, normalizing
form data, reshaping CSV rows into typed records, and any case where
input and output structures differ.

## Simple Field Mapping

Rename and restructure fields with `bind` and `read`:

```tree
seed cast, name api-to-db
  take input, like api-user
  like db-user

  bind id, read input/user-id
  bind name, read input/display-name
  bind email, read input/email
```

The `take` line declares the input. The `like` line declares the
output shape. Each `bind` maps one output field from a source path.

## Computed Fields

Use `call` to transform values during mapping:

```tree
seed cast, name api-to-db
  take input, like api-user
  like db-user

  bind id, read input/user-id
  bind full-name
    call join-text
      bind parts, make list
        read input/first-name
        read input/last-name
      bind glue, text < >
  bind email
    call lower-text
      bind text, read input/email
  bind created-at
    call now
```

Any task can be called inside a `bind` block. The return value
becomes the field value.

## Nested Object Mapping

Map nested structures by nesting `make` blocks:

```tree
seed cast, name flatten-address
  take input, like api-order
  like db-order

  bind id, read input/order-id
  bind total, read input/total
  bind address
    make address
      bind street, read input/shipping/street
      bind city, read input/shipping/city
      bind zip, read input/shipping/zip-code
```

Or go the other direction and flatten nested input into a flat
output:

```tree
seed cast, name flatten-user
  take input, like nested-user
  like flat-user

  bind name, read input/profile/name
  bind email, read input/account/email
  bind city, read input/profile/address/city
```

## List Transformations

Use `walk list` to transform each item in a collection:

```tree
seed cast, name map-users
  take input, like api-response
  like list, of db-user

  walk list, read input/users
    hook next
      take site, name user
      make db-user
        bind id, read user/id
        bind name, read user/name
        bind email, read user/email
```

Filter items during transformation:

```tree
seed cast, name active-users
  take input, like api-response
  like list, of db-user

  walk list, read input/users
    hook next
      take site, name user
      fork test
        hook test
          call is-equal
            bind a, read user/status
            bind b, text <active>
        hook hold
          make db-user
            bind id, read user/id
            bind name, read user/name
```

## Flattening and Grouping

Flatten nested lists with chained `walk list` blocks:

```tree
seed cast, name flatten-tags
  take input, like list, of article
  like list, of text

  walk list, read input
    hook next
      take site, name article
      walk list, read article/tags
        hook next
          take site, name tag
          read tag/name
```

Group items by a key field:

```tree
seed cast, name group-by-role
  take input, like list, of user
  like hash, of list, of user

  save result, make hash
  walk list, read input
    hook next
      take site, name user
      save key, read user/role
      fork test
        hook test
          call has-key
            bind hash, read result
            bind key, read key
        hook hold
          call push
            bind list, read result/{key}
            bind item, read user
        hook miss
          save result/{key}, make list
            read user
  send back, read result
```

## Conditional Mapping

Use `fork test` for fields that depend on conditions:

```tree
seed cast, name normalize-status
  take input, like api-user
  like db-user

  bind id, read input/id
  bind status
    fork test
      hook test
        call is-equal
          bind a, read input/role
          bind b, text <admin>
      hook hold
        text <elevated>
      hook miss
        text <standard>
```

Use `fork case` to branch on known values:

```tree
seed cast, name map-tier
  take input, like subscription
  like db-subscription

  bind id, read input/id
  bind level
    fork case, read input/plan
      case free
        mark 0
      case basic
        mark 1
      case premium
        mark 2
```

## Default Values

Provide fallback values for missing or empty fields:

```tree
seed cast, name safe-user
  take input, like api-user
  like db-user

  bind name, read input/name
  bind email, read input/email
  bind role
    fork test
      hook test
        call is-void
          bind value, read input/role
      hook hold
        text <member>
      hook miss
        read input/role
  bind avatar
    fork test
      hook test
        call is-void
          bind value, read input/avatar-url
      hook hold
        text <https://example.com/default.png>
      hook miss
        read input/avatar-url
```

## Composing Transforms

Chain transforms by calling one cast from another:

```tree
seed cast, name api-to-db
  take input, like api-user
  like db-user

  bind id, read input/user-id
  bind email, read input/email
  bind name, read input/display-name

seed cast, name response-to-db
  take input, like api-response
  like list, of db-user

  walk list, read input/users
    hook next
      take site, name user
      call api-to-db
        bind input, read user
```

Reuse a shared transform across multiple casts:

```tree
seed cast, name normalize-address
  take input, like raw-address
  like address

  bind street
    call trim-text
      bind text, read input/street
  bind city
    call capitalize-text
      bind text, read input/city
  bind zip, read input/zip

seed cast, name order-to-db
  take input, like api-order
  like db-order

  bind id, read input/order-id
  bind address
    call normalize-address
      bind input, read input/shipping
```

## Common Use Cases

### API Response to Database Model

```tree
seed cast, name api-to-db
  take input, like api-user
  like db-user

  bind id, read input/user-id
  bind full-name
    call join-text
      bind parts, make list
        read input/first-name
        read input/last-name
      bind glue, text < >
  bind email, read input/email
  bind created-at
    call parse-timestamp
      bind text, read input/created
```

### CSV Row to Typed Record

```tree
seed cast, name csv-row
  take row, like hash
  like user

  bind name, read row/name
  bind email
    call lower-text
      bind text, read row/email
  bind age
    call parse-integer
      bind text, read row/age
  bind active
    call is-equal
      bind a, read row/active
      bind b, text <true>
```

### Form Data Normalization

```tree
seed cast, name normalize-form
  take input, like form-data
  like user-profile

  bind name
    call trim-text
      bind text, read input/name
  bind email
    call lower-text
      bind text
        call trim-text
          bind text, read input/email
  bind phone
    call strip-text
      bind text, read input/phone
      bind chars, text <-() >
```

## Feature Summary

| Feature              | Syntax                                      |
| -------------------- | ------------------------------------------- |
| Declare transform    | `seed cast, name x`                         |
| Input parameter      | `take input, like source-type`              |
| Output shape         | `like target-type`                          |
| Map field            | `bind field, read input/path`               |
| Computed field       | `bind field` + indented `call function`     |
| Construct object     | `make type` + `bind` children               |
| Construct list       | `make list` + items                         |
| Iterate list         | `walk list, read path` + `hook next`        |
| Conditional          | `fork test` + `hook test`/`hook hold`/`hook miss` |
| Branch on value      | `fork case, read path` + `case x`           |
| Default value        | `fork test` with `call is-void` check       |
| Chain transforms     | `call other-cast` inside a `bind` or `walk` |
| Nested access        | `read input/parent/child/field`             |
