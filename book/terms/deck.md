# The `deck` file in StarTree

A deck is a package, and this is how you define the package metadata.

```
deck @cluesurf/deck
  mark <0.0.1>
  head <A TreeCode Package Manager>
  term link-text
  term computation
  term philosophy
  term information
  term platform
  term white-label
  term compiler
  face <Lance Pollard>, site <lp@elk.fm>
  task ./task # the task loader
  read ./book # also a default
  lock apache-2
  sort tool
  link @cluesurf/star, mark <0.x.x>
  link @cluesurf/nest, mark <0.x.x>
  link @cluesurf/crow, mark <0.x.x>
  load work
  load host
```

### `mark`

This is the "version" of the package.

### `task`

```
task ./task
```

### `boot`

You can have a file run on StarTreetup. Just add this to your deck:

```
boot ./boot
```

This is good for doing dependency injection and such, for initializing
values, etc..
