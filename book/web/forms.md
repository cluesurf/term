# Forms

There is no form construct. A form is built from parts that exist: an input carries `name <ref>`, a click handler reads it with `get-value`, a check task decides, and a [signal](state.md) holds the message the page shows. The blog's post editor in `deck/site/test/site/face/blog.tree` is written this way.

An earlier version of this page described a `form` declared inside a component, with `mill email` validators, `need true`, `base` defaults, `read form/dirty`, and `hook submit`. The component grammar has no `form` node, and none of that compiles.

Maps to: an uncontrolled form in plain DOM code: read each field when it is needed, validate in a function, show the error from state.

## Cheatsheet

| Piece | How |
| --- | --- |
| A field | `view input` with `name <ref>` |
| Read a field | `call get-value, read <ref>` |
| Clear a field | `call set-value` with the ref and `text <>` |
| Validate | an ordinary task returning a boolean or a message |
| Show an error | a `signal` of text, read in a `view p` |
| Submit | `seed click` on a button, with the handler as its body |
| Field events | `seed input` or `seed change` on the input |
| Focus | `call focus` / `call blur` with the ref |

All the DOM tasks are in `@term/site/code/dom/dom`: `get-value`, `set-value`, `focus`, `blur`, `set-attribute`, `get-attribute`, and `listen-event` for a handler that receives the DOM event.

## A basic form

```tree
load @term/site/code/dom/dom
  find view
  find get-value
  find set-value

load @term/site/code/view/reactive
  find signal
  find make-signal
  find read-signal
  find write-signal

# read the field, check it, then either report the problem or hand the value on
task submit-email
  take field, like view
  take problem, like signal text
  take on-submit
    like task
      take email, like text
  save email
    call get-value, read field
  fork test
    hook test
      call email/includes, text <@>
    hook hold
      call write-signal
        bind self, read problem
        bind value, text <>
      call on-submit
        read email
      call set-value
        read field
        text <>
    hook miss
      call write-signal
        bind self, read problem
        bind value, text <An email address has an @ in it>

view email-form
  take host, like view
  take on-submit
    like task
      take email, like text
  save problem
    call make-signal
      text <>
  view label
    text <Email>
  view input
    name email-field
    seed type, text <email>
  view button
    seed click
      call submit-email
        read email-field
        read problem
        read on-submit
    text <Subscribe>
  view p
    read
      call read-signal, read problem
```

`on-submit` is a task the caller passes in, so the same form can save to a database, post to a server, or do nothing in a test.

## Validation rules

A validator is a `task` taking the value and returning a message, empty when the value is fine. There are no built-in field rules, so write the check the field needs.

```tree
# a username has 2 to 32 characters and no spaces
task check-username
  take value, like text
  like text
  fork test
    hook test
      call value/includes, text < >
    hook hold
      send back, text <username must not contain spaces>
  fork test
    hook test
      call is-below
        read value/length
        code 2
    hook hold
      send back, text <username is too short>
  fork test
    hook test
      call is-above
        read value/length
        code 32
    hook hold
      send back, text <username is too long>
  send back, text <>
```

## Defaults

A field's starting value is an attribute on the input.

```tree
load @term/site/code/dom/dom
  find view

view settings-form
  take host, like view
  view input
    name theme
    seed value, text <light>
  view input
    name page-size
    seed type, text <number>
    seed value, text <20>
```

## Reading state and errors

Read a field by its ref when it is needed. Show an error by reading the signal that holds it. A `fork test` hides the error line while the signal is empty.

```tree
load @term/site/code/dom/dom
  find view

load @term/site/code/view/reactive
  find signal
  find make-signal
  find read-signal

view email-field
  take host, like view
  take problem, like signal text
  view label
    text <Email>
  view input
    name field
    seed type, text <email>
  fork test
    hook test
      call is-unequal
        call read-signal, read problem
        text <>
    hook hold
      view span
        seed class, text <error>
        read
          call read-signal, read problem
```

## Field events

Handle a field event with `seed input`, `seed change`, or `seed blur` on the input, and the handler as its body. Typing writes no signal by itself. Read the value in the handler and write it.

```tree
load @term/site/code/dom/dom
  find view
  find get-value

load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

view search-form
  take host, like view
  save query
    call make-signal
      bind value, text <>
  view input
    name field
    seed type, text <text>
    seed input
      call write-signal
        bind self, read query
        bind value
          call get-value, read field
  view p
    read
      call read-signal, read query
```

## Submitting

There is no `submit` event that reads the whole form. A button's click handler reads each field by its ref, validates, and hands the values on. To prevent a double submit, hold a busy signal, set the button's `disabled` attribute with `set-attribute` while the save is in flight, and clear it after.

## Dynamic and multi-step forms

Render repeated field groups by holding a list signal and iterating with `walk list`. For a wizard, hold a step signal and switch panels with `fork test`. The list and signal APIs are on the [state](state.md) page. Field add and remove use the standard list operations from the standard library.
