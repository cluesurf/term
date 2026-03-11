# Validation (`mill`)

Validation in Seed uses `mill` to declare reusable schemas that
constrain input data. Mills validate fields by type, format, range, and
custom rules. They work with route handlers, CLI arguments, form
submissions, and anywhere structured input needs checking before use.

## Basic Field Validation

Declare a mill with `link` fields. Each field has a type (`like`) and
optional constraints.

```tree
mill user-input
  link name, like text
    need true
  link email, like text
    need true
  link bio, like text
    need false
```

Fields are required by default. Use `need false` to mark optional
fields.

### Default Values

Provide a fallback with `base`:

```tree
mill settings
  link theme, like text
    base <light>
  link page-size, like u32
    base mark 25
  link notify, like wave
    base wave true
```

When a field is missing from input, the default value is used instead
of raising a validation error.

### Nullable Fields

Use `void true` to allow null:

```tree
mill profile
  link avatar, like text
    void true
  link deleted-at, like timestamp
    void true
```

## Type Constraints

### String Length

```tree
mill signup
  link username, like text
    need true
    bind min, mark 3
    bind max, mark 20
  link password, like text
    need true
    bind min, mark 8
    bind max, mark 128
  link display-name, like text
    bind max, mark 50
```

### Number Range

```tree
mill product-filter
  link price-min, like f64
    bind min, mark 0
  link price-max, like f64
    bind max, mark 999999
  link quantity, like u32
    bind min, mark 1
    bind max, mark 10000
```

### List Size

```tree
mill bulk-action
  link ids, like list
    like u64
    bind min, mark 1
    bind max, mark 100
  link tags, like list
    like text
    bind max, mark 10
```

The `bind min`/`bind max` on a list constrains the number of items.

## Format Validators

Use `mill` as a child of `link` to apply a built-in format validator.

### Email

```tree
mill contact
  link email, like text
    need true
    mill email
```

### URL

```tree
mill bookmark
  link href, like text
    need true
    mill url
  link icon, like text
    mill url
    need false
```

### UUID

```tree
mill lookup
  link id, like text
    need true
    mill uuid
```

### Regex Pattern

```tree
mill account
  link slug, like text
    need true
    mill regex
      bind form, <^[a-z0-9\-]+$>
  link phone, like text
    mill regex
      bind form, <^\+?[1-9]\d{1,14}$>
```

### Date and Time

```tree
mill event
  link start-date, like text
    need true
    mill date
  link start-time, like text
    mill time
  link scheduled-at, like text
    mill datetime
```

## Enum Validation

Restrict a field to a fixed set of values with `case`:

```tree
mill task-input
  link status, like text
    need true
    case <pending>
    case <active>
    case <done>
  link priority, like text
    base <medium>
    case <low>
    case <medium>
    case <high>
    case <critical>
```

Enum validation rejects any value not in the listed cases.

## Nested Object Validation

Nest `mill` blocks to validate objects within objects:

```tree
mill order
  link customer, like form
    mill customer-detail
      link name, like text
        need true
      link email, like text
        need true
        mill email
  link shipping, like form
    mill address
      link street, like text
        need true
      link city, like text
        need true
      link zip, like text
        need true
        mill regex
          bind form, <^\d{5}(-\d{4})?$>
      link country, like text
        need true
        bind min, mark 2
        bind max, mark 2
```

Reference a previously defined mill for nested validation:

```tree
mill address
  link street, like text
    need true
  link city, like text
    need true
  link zip, like text
    need true

mill order
  link billing, like form
    mill address
  link shipping, like form
    mill address
```

## List Item Validation

Validate each item in a list by combining `like list` with nested
constraints:

```tree
mill team-input
  link members, like list
    like form
    bind min, mark 1
    bind max, mark 50
    mill member
      link name, like text
        need true
      link role, like text
        need true
        case <admin>
        case <editor>
        case <viewer>
```

Simple typed lists:

```tree
mill config
  link ports, like list
    like u32
    mill integer
      bind min, mark 1
      bind max, mark 65535
  link emails, like list
    like text
    mill email
```

## Cross-Field Validation

Use `hold` to express constraints that span multiple fields:

```tree
mill date-range
  link start, like text
    need true
    mill date
  link end, like text
    need true
    mill date
  hold is-minimum
    bind a, read end
    bind b, read start
```

Multiple cross-field rules:

```tree
mill transfer
  link from-account, like text
    need true
  link to-account, like text
    need true
  link amount, like f64
    need true
    bind min, mark 0
  hold is-not-equal
    bind a, read from-account
    bind b, read to-account
  hold is-above
    bind a, read amount
    bind b, mark 0
```

The `hold` blocks at the mill level run after all individual field
validations pass.

## Custom Validators

Define a custom validation task and reference it with `call`:

```tree
task check-username
  take value, like text
  send back, like wave
  save taken, call find-username
    bind name, read value
    halt kink
  fork test
    hook test
      call is-some, read taken
    hook hold
      halt kink, make mill-kink
        bind text, <username already taken>
  send back, wave true

mill registration
  link username, like text
    need true
    bind min, mark 3
    bind max, mark 20
    call check-username
  link email, like text
    need true
    mill email
```

The custom task receives the field value and should `halt kink` on
failure.

## Composing Validators (`fuse`)

Reuse common field groups across mills with `fuse`:

```tree
fuse timestamps
  tree self
    link created-at, like text
      mill datetime
    link updated-at, like text
      mill datetime
      need false

fuse auditable
  tree self
    link created-by, like text
      need true
      mill uuid
    link updated-by, like text
      need false
      mill uuid
```

Apply shared groups with `hook fuse`:

```tree
mill article
  link title, like text
    need true
    bind min, mark 1
    bind max, mark 200
  link body, like text
    need true
  hook fuse, timestamps
  hook fuse, auditable
```

This expands the `timestamps` and `auditable` fields into `article`
at compile time.

## Usage with Routes

Attach a mill to a route handler's `take body` to validate request
bodies:

```tree
task make-user
  take body
    mill user-input
  save user, call create-user
    bind name, read body/name
    bind email, read body/email
    halt kink
  send back, read user

mill user-input
  link name, like text
    need true
    bind min, mark 2
    bind max, mark 100
  link email, like text
    need true
    mill email
  link age, like u32
    need false
    bind min, mark 13
```

The mill runs before the task body executes. If validation fails, the
route returns an error response automatically.

### Query Parameter Validation

```tree
task list-users
  take query
    mill user-query
  save users, call find-users
    bind role, read query/role
    bind page, read query/page
    halt kink
  send back, read users

mill user-query
  link role, like text
    need false
    case <admin>
    case <editor>
    case <viewer>
  link page, like u32
    base mark 1
    bind min, mark 1
  link size, like u32
    base mark 20
    bind min, mark 1
    bind max, mark 100
```

## Usage with CLI

Validate CLI arguments with `mill` on `take` parameters:

```tree
task serve
  take port, code p
    like u32
    mill integer
      bind min, mark 1
      bind max, mark 65535
  take host, code h
    like text
    base <localhost>
  take workers, code w
    like u32
    base mark 4
    mill integer
      bind min, mark 1
      bind max, mark 64
```

The `code` gives the short flag alias. The mill validates the parsed
value before the task runs.

### CLI with Enum

```tree
task deploy
  take env, code e
    like text
    need true
    case <dev>
    case <staging>
    case <prod>
  take region, code r
    like text
    base <us-east-1>
    case <us-east-1>
    case <us-west-2>
    case <eu-west-1>
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Required field | `need true` | `link name` / `need true` |
| Optional field | `need false` | `link bio` / `need false` |
| Default value | `base <val>` or `base mark N` | `base <light>` |
| Nullable | `void true` | `void true` |
| String length | `bind min`/`bind max` on `like text` | `bind min, mark 3` |
| Number range | `bind min`/`bind max` on numeric | `bind max, mark 100` |
| List size | `bind min`/`bind max` on `like list` | `bind max, mark 10` |
| Email format | `mill email` | `mill email` |
| URL format | `mill url` | `mill url` |
| UUID format | `mill uuid` | `mill uuid` |
| Regex pattern | `mill regex` / `bind form` | `bind form, <^[a-z]+$>` |
| Date format | `mill date` | `mill date` |
| Enum values | `case <val>` | `case <active>` |
| Nested object | `mill <name>` on `like form` | `mill address` |
| List items | nested type under `like list` | `like text` / `mill email` |
| Cross-field | `hold` at mill level | `hold is-minimum` |
| Custom check | `call <task>` | `call check-username` |
| Composition | `hook fuse, <template>` | `hook fuse, timestamps` |
| CLI flag | `code <letter>` | `code p` |
