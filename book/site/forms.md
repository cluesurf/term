# Forms

Declare forms with `form` inside a `zone`. Each field uses `link` with
a type, validation rules via `mill`, and defaults via `base`. Submit
handling goes in `hook submit`.

## Basic Form

```tree
zone login-form
  form login
    link email, like text
      need true
      mill email
    link password, like text
      need true
      mill text
        bind min, mark 8

  hook submit
    call login
      bind data, read form
```

## Field Types

### Text

```tree
link name, like text
  need true
  mill text
    bind min, mark 2
    bind max, mark 100
```

### Number

```tree
link age, like u32
  mill integer
    bind min, mark 0
    bind max, mark 150
```

### Boolean (Checkbox)

```tree
link agree, like wave
  need true
  base wave false
```

### Select (Enum)

```tree
link role, like text
  base text <member>
  mill enum
    case admin
    case member
    case guest
```

### Date

```tree
link birthday, like date
  mill date
    bind min, text <2000-01-01>
    bind max, text <2030-12-31>
```

### File

```tree
link avatar, like file
  mill file
    bind max-size, mark 5242880
    bind accept, text <image/png, image/jpeg>
```

## Validation Rules

### Required

```tree
link email, like text
  need true
```

### Min and Max Length

```tree
link username, like text
  mill text
    bind min, mark 3
    bind max, mark 32
```

### Pattern

```tree
link phone, like text
  mill text
    bind match, text <^\+[0-9]{10,15}$>
```

### Custom Validation

Define a custom mill task and reference it by name.

```tree
task mill-username
  take value, like text
  fork test
    hook test
      call has-space, read value
    hook hold
      send back, text <username must not contain spaces>
  send back, wave true

zone profile-form
  form profile
    link username, like text
      mill mill-username
```

## Default Values

Use `base` to set the initial value for a field.

```tree
form settings
  link theme, like text
    base text <light>
  link page-size, like u32
    base mark 20
  link notify, like wave
    base wave true
```

## Form State

The form tracks draft values and dirty status automatically. Access
the current draft with `read form`. Check whether the form has
unsaved changes with `read form/dirty`.

```tree
zone edit-form
  form user
    link name, like text
    link email, like text

  zone status
    fork test
      hook test
        read form/dirty
      hook hold
        zone span
          text <Unsaved changes>

  hook submit
    call save-user
      bind data, read form
```

Access individual field values with `read form/name` or
`read form/email`.

## Error Display

Validation errors are available per field via `read form/kink/FIELD`.
Display them next to each field.

```tree
zone user-form
  form user
    link email, like text
      need true
      mill email

  zone field
    zone label
      text <Email>
    zone input
      seed type, text <email>
      seed value, read form/email
    fork test
      hook test
        read form/kink/email
      hook hold
        zone span
          seed class, text <error>
          read form/kink/email

  hook submit
    call save-user
      bind data, read form
```

## Dynamic Forms

Add and remove fields with `save` and list operations. Use `walk list`
to render repeated field groups.

```tree
zone tag-form
  save tags, list text <>

  zone button
    text <Add Tag>
    hook click
      call list/push
        bind list, read tags
        bind value, text <>

  walk list, read tags
    hook next
      take site, name tag
      take slot, name index
      zone field
        zone input
          seed value, read tag
          hook input
            take site, name event
            call list/save
              bind list, read tags
              bind slot, read index
              bind value, read event/value
        zone button
          text <Remove>
          hook click
            call list/toss
              bind list, read tags
              bind slot, read index

  hook submit
    call save-tags
      bind tags, read tags
```

## Multi-Step Forms

Use a `save` variable to track the current step and `fork case` to
show the right panel.

```tree
zone wizard
  save step, mark 1

  form account
    link email, like text
      need true
      mill email
    link password, like text
      need true

  form profile
    link name, like text
      need true
    link bio, like text

  fork case, read step
    case 1
      zone step-one
        zone input
          seed type, text <email>
          seed value, read account/email
        zone input
          seed type, text <password>
          seed value, read account/password
        zone button
          text <Next>
          hook click
            save step, mark 2

    case 2
      zone step-two
        zone input
          seed value, read profile/name
        zone input
          seed value, read profile/bio
        zone button
          text <Back>
          hook click
            save step, mark 1
        zone button
          text <Submit>
          hook click
            call create-account
              bind account, read account
              bind profile, read profile
```

## File Upload

Handle file inputs with `like file` fields. Access the selected file
from the input event.

```tree
zone upload-form
  form upload
    link document, like file
      need true
      mill file
        bind max-size, mark 10485760
        bind accept, text <application/pdf>

  zone input
    seed type, text <file>
    seed accept, text <application/pdf>
    hook change
      take site, name event
      save form/document, read event/file

  zone button
    seed type, text <submit>
    text <Upload>

  hook submit
    call upload-file
      bind file, read form/document
      halt kink
```

## Form Submission

Use `hook submit` to handle form data. Call a task with `bind data`
to pass the form values. Use `halt kink` to propagate errors.

```tree
zone user-form
  form user
    link name, like text
      need true
    link email, like text
      need true
      mill email
    link role, like text
      base text <member>
      mill enum
        case admin
        case member

  hook submit
    call save-user
      bind data, read form
      halt kink
    call notify
      bind text, text <User saved>
```

### Prevent Double Submit

```tree
zone user-form
  save busy, wave false

  form user
    link name, like text

  zone button
    seed type, text <submit>
    seed disabled, read busy
    text <Save>

  hook submit
    save busy, wave true
    call save-user
      bind data, read form
      halt kink
    save busy, wave false
```

## Integrating with State Stores

Load shared state and update the store on submit.

```tree
load @app/store
  find user-store

zone edit-user
  save user, read user-store/current

  form profile
    link name, like text
      base read user/name
    link email, like text
      base read user/email

  hook submit
    call user-store/save
      bind data, read form
      halt kink
```

## Field Events

Handle individual field events with `hook input`, `hook change`,
and `hook blur`.

```tree
zone search-form
  save query, text <>

  zone input
    seed type, text <text>
    seed placeholder, text <Search...>
    seed value, read query
    hook input
      take site, name event
      save query, read event/value

  zone button
    seed type, text <submit>
    hook click
      call search
        bind query, read query
```

Blur validation:

```tree
zone email-field
  save touched, wave false
  save error, text <>

  zone input
    seed type, text <email>
    hook blur
      save touched, wave true
      save error
        call mill-email
          bind value, read form/email

  fork test
    hook test
      call and
        read touched
        read error
    hook hold
      zone span
        seed class, text <error>
        read error
```

## Full Example

A complete registration form with validation, error display, and
submission.

```tree
zone register-form
  form user
    link name, like text
      need true
      mill text
        bind min, mark 2
        bind max, mark 50
    link email, like text
      need true
      mill email
    link password, like text
      need true
      mill text
        bind min, mark 8
    link role, like text
      base text <member>
      mill enum
        case admin
        case member
    link agree, like wave
      need true

  zone field
    zone label
      text <Name>
    zone input
      seed type, text <text>
      seed value, read form/name
    fork test
      hook test
        read form/kink/name
      hook hold
        zone span
          seed class, text <error>
          read form/kink/name

  zone field
    zone label
      text <Email>
    zone input
      seed type, text <email>
      seed value, read form/email
    fork test
      hook test
        read form/kink/email
      hook hold
        zone span
          seed class, text <error>
          read form/kink/email

  zone field
    zone label
      text <Password>
    zone input
      seed type, text <password>
      seed value, read form/password
    fork test
      hook test
        read form/kink/password
      hook hold
        zone span
          seed class, text <error>
          read form/kink/password

  zone field
    zone label
      text <Role>
    zone select
      seed value, read form/role
      zone option
        seed value, text <admin>
        text <Admin>
      zone option
        seed value, text <member>
        text <Member>

  zone field
    zone label
      zone input
        seed type, text <checkbox>
        seed checked, read form/agree
      text <I agree to the terms>
    fork test
      hook test
        read form/kink/agree
      hook hold
        zone span
          seed class, text <error>
          read form/kink/agree

  zone button
    seed type, text <submit>
    text <Register>

  hook submit
    call register-user
      bind data, read form
      halt kink
    call notify
      bind text, text <Registration complete>

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Form declaration | `form name` inside `zone` | `form user` |
| Field | `link name, like type` | `link email, like text` |
| Required | `need true` | `need true` |
| Default value | `base value` | `base text <member>` |
| Text validation | `mill text` + `bind min/max` | `bind min, mark 2` |
| Pattern validation | `mill text` + `bind match` | `bind match, text <...>` |
| Email validation | `mill email` | `mill email` |
| Enum validation | `mill enum` + `case` | `case admin` |
| Integer validation | `mill integer` + `bind min/max` | `bind min, mark 0` |
| Date validation | `mill date` + `bind min/max` | `bind min, text <2000-01-01>` |
| File validation | `mill file` + `bind max-size/accept` | `bind max-size, mark 5242880` |
| Custom validation | `mill task-name` | `mill mill-username` |
| Form state | `read form` | `read form/email` |
| Dirty tracking | `read form/dirty` | `read form/dirty` |
| Field errors | `read form/kink/FIELD` | `read form/kink/email` |
| Submit handler | `hook submit` | `hook submit` + `call save` |
| Input event | `hook input` | `hook input` on `zone input` |
| Change event | `hook change` | `hook change` on `zone select` |
| Blur event | `hook blur` | `hook blur` on `zone input` |
| Dynamic fields | `walk list` + `list` ops | `call list/push` |
| Multi-step | `save step` + `fork case` | `fork case, read step` |
| File upload | `like file` + `mill file` | `seed type, text <file>` |
| CSS class | `seed class` | `seed class, text <error>` |
| Error propagation | `halt kink` | child of `call` |
