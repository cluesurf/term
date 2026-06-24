# Forms

A form is a `form` declared inside a [zone](components.md). Each field is a `link` with a type, optional default (`base`), and optional validation (`mill`). The form tracks draft values, dirty status, and per-field errors. Submit handling goes in `hook submit`.

Maps to: a typed form library (React Hook Form, Formik) where the schema, defaults, and validators are declared once and the framework manages draft state.

## Cheatsheet

| Form | Job |
| --- | --- |
| `form <name>` inside a `zone` | Declare a form and its fields |
| `link <field>, like <type>` | A typed field |
| `need true` | Mark a field required |
| `base <value>` | The field's default value |
| `mill <rule>` | Attach a validator (`email`, `uuid`, `integer`, `enum`, `text`, ...) |
| `mill <task>` | A custom validator referenced by task name |
| `read form` | The whole draft |
| `read form/<field>` | One field's current value |
| `read form/dirty` | Whether the form has unsaved changes |
| `read form/kink/<field>` | A field's validation error, if any |
| `hook submit` | Handle the submit (pass `read form` to a task) |
| `hook input` / `hook change` / `hook blur` | Field events |

## A basic form

```tree
zone login-form
  take host, like view
  form login
    link email, like text
      need true
      mill email
    link password, like text
      need true
      mill text
        bind min, code 8

  hook submit
    call login
      bind data, read form
      halt kink
```

## Field types

```tree
form profile
  link name, like text
    need true
    mill text
      bind min, code 2
      bind max, code 100
  link age, like number
    mill integer
      bind min, code 0
      bind max, code 150
  link agree, like boolean
    need true
    base false
  link role, like text
    base text <member>
    mill enum
      case admin
      case member
      case guest
```

## Validation rules

`mill` attaches a validator to a field. Built-in rules cover the common cases.

```tree
link email, like text
  need true
  mill email

link id, like text
  mill uuid

link phone, like text
  mill text
    bind match, text <^\+[0-9]{10,15}$>
```

A custom validator is a `task` taking the value, returning either a boolean or an error message. Reference it by name with `mill`.

```tree
task mill-username
  take value, like text
  fork test
    hook test
      call has-space, read value
    hook hold
      send back, text <username must not contain spaces>
  send back, true

zone profile-form
  take host, like view
  form profile
    link username, like text
      mill mill-username
```

## Defaults

`base` sets a field's initial value.

```tree
form settings
  link theme, like text
    base text <light>
  link page-size, like number
    base code 20
  link notify, like boolean
    base true
```

## Reading state and errors

The form tracks the draft. Read the whole thing with `read form`, one field with `read form/<field>`, the dirty flag with `read form/dirty`, and a field error with `read form/kink/<field>`.

```tree
zone user-form
  take host, like view
  form user
    link email, like text
      need true
      mill email

  zone label
    text <Email>
  zone input
    bind type, text <email>
    bind value, read form/email
  fork
    hook test
      read form/kink/email
    hook hold
      zone span
        bind class, text <error>
        read form/kink/email

  hook submit
    call save-user
      bind data, read form
      halt kink
```

## Field events

Handle per-field events with `hook input`, `hook change`, and `hook blur`. The event carries the new value.

```tree
zone search-form
  take host, like view
  save query
    call make-signal
      bind value, text <>
  zone input
    bind type, text <text>
    hook input
      take site, name event
      call write-signal
        bind self, read query
        bind value, read event/value
```

## Submitting

`hook submit` runs on form submission. Pass the draft to a task with `bind data`. Use `halt kink` to propagate an error like Rust's `?`, which stops the submit and surfaces the failure.

```tree
zone user-form
  take host, like view
  form user
    link name, like text
      need true
    link email, like text
      need true
      mill email

  hook submit
    call save-user
      bind data, read form
      halt kink
    call notify
      bind text, text <User saved>
```

To prevent a double submit, gate on a busy signal and disable the button while the save is in flight.

## Dynamic and multi-step forms

Render repeated field groups by holding a list signal and iterating with `walk list`. For a wizard, hold a step signal and switch panels with `fork case`. The list and signal APIs are on the [state](state.md) page. Field add and remove use the standard list operations from the standard library.
