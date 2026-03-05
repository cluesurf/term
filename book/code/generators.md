# Generators

Generate output strings with `lace`. A lace is a template that
produces text by combining literal strings, variable references, and
sub-templates.

## Basic Lace

Define a lace with `take` for input, then `lace text` to emit
strings and `lace form` to call sub-templates:

```tree
lace greeting
  take name
  lace text, text <hello >
  lace text, read name
```

## Calling Sub-Templates

Use `lace form` to delegate to another lace, passing binds:

```tree
lace document
  take tree
  lace text, text <!doctype html>
  lace form, form node
    bind node, read tree
```

## Walking Collections

Use `walk` inside a lace to iterate over children:

```tree
lace content
  take node

  walk node/head
    test test-match
      bind base, read seed/form
      bind head, read form flow
      hook rise
        lace text, read seed/text
      hook fall
        lace form, form node
          bind node, read seed
```

## HTML Example

A complete HTML generator from `code.tree`:

```tree
lace document
  take tree
  lace text, text <!doctype html>
  lace form, form node
    bind node, read tree

lace node
  take node
  lace form, form node-base
    bind node, read node
  lace form, form content
    bind node, read node
  lace form, form node-head
    bind node, read node

lace node-base
  take node
  lace text, text <<>
  lace text, read node/name
  lace text, text < >
  lace form, form bind-list
    bind node, read node
  lace text, text <>>

lace bind-list
  take node
  walk node/bind
    lace text, read seed/name
    lace text, text <=>
    lace text, text <'>
    lace form, form bind-bond
      bind bond, read seed/bond
    lace text, text <'>

lace node-head
  take node
  lace text, text <</>
  lace text, read node/name
  lace text, text <>>
```

## Lace Commands

| Command | Purpose |
| --- | --- |
| `lace text` | Emit a literal or variable string |
| `lace form` | Call a sub-template with binds |
| `walk` | Iterate over a collection in the template |
| `test` | Conditional output |
