# Error Definition and Handling in TermTree

First, in some library, you define your error:

```
load @cluesurf/star/code/kink
  find suit fill

kink syntax-error
  head <Syntax error>
  code 1
  hint <To fix this syntax error, try x>

  link text, like text
  link link, like text
  link band, like text

  link show, void text
  link link, void text

  wear fill
    task fill
      take self
      save self/show, call make-kink-show, loan self/text
      save self/link, loan self/link
```

The `code` is meant to be transformed into a string so you can get nice
codes to use in search engines. It's not necessary to define a code.

Then you specify somewhere how the error is rendered, on the CLI. There
is a default renderer, but you can override it on a per-error basis if
you really want to.

```
load @cluesurf/star/code/kink
  find suit show

load ./halt
  take kink syntax-error

kink syntax-error
  wear show
    task show
      take self
      take call, list halt-call
      call make-kink-text
        loan self
        loan call
```

Then you can throw your actual error:

```
load ./halt
  take kink syntax-error

# somewhere in the code
halt syntax-error
  bind text, loan text
  bind link, loan link
  bind band, call make-band, loan text
```

The `halt` basically does:

```
back
  make syntax-error
    ...
```

## Notes

- error definitions in js
- link text

Should you be able to override stuff from external libraries.

Need to return a list of nodes for printing.

JSON vs. tree vs. x vs. y.

You could have a trait which calls a specific method on the thing.

```
lace syntax-error
  take kink

  lace form, form head
    bind kink, loan kink
  lace form, form link
    bind link, loan kink/link
    bind band, loan kink/band

lace head
  take kink
  lace form, form note
    bind note, loan kink/note
  lace form, form code
    bind code, loan kink/code

lace note
  take note, like text

  lace term, term note
    lace text, loan note

lace code
  take code, like size

  save code-text
    call make-code-text
      loan code

  lace term, term code
    bind fill, loan blue
    lace text, loan code-text
      bind fill, loan gray
```

Then, you specify the method that will be used to render the code.

```
mask render-1
  task render-1

mask render-2
  task render-2

task render
  take kink, like render-2
  call kink/render-2

save global/error-handler, loan render
```
