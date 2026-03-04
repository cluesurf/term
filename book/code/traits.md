# Traits

Define interfaces with `mask`. Implement them with `wear` (on a form)
or `suit` (standalone).

## Define a Trait (`mask`)

```tree
mask printable
  task to-text
    take self
    like text
```

```tree
mask numeric
  task to-number
    take self
    like u64
```

Trait with type parameter:

```tree
mask addition
  head output
  head other, base self
  task add
    take self, move true
    take other, move true
    like output
```

Trait with multiple methods:

```tree
mask comparison
  task is-equal
    take self
    take other
    like boolean
  task is-not-equal
    take self
    take other
    like boolean
```

## Implement on a Form (`wear`)

Attach a trait implementation directly to a form:

```tree
form color
  case red
  case green
  case blue

  wear printable
    task to-text
      take self, like color
      like text
      fork case, read self
        hook red
          send back, text <red>
        hook green
          send back, text <green>
        hook blue
          send back, text <blue>
```

Multiple traits on one form:

```tree
form color
  case red
  case green
  case blue

  wear printable
    task to-text
      take self, like color
      fork case, read self
        hook red
          send back, text <red>
        hook green
          send back, text <green>
        hook blue
          send back, text <blue>

  wear numeric
    task to-number
      take self, like color
      fork case, read self
        hook red
          send back, mark 1
        hook green
          send back, mark 2
        hook blue
          send back, mark 3
```

Custom methods (not from a mask):

```tree
form color
  case red
  case green
  case blue

  wear helpers
    task warmth
      take self, like color
      fork case, read self
        hook red
          send back, mark 1
        hook green
          send back, mark 0
        hook blue
          send back, mark 0
```

## Standalone Implementation (`suit`)

Implement a trait on a form defined elsewhere:

```tree
suit shape
  wear printable
    task to-text
      take self, like shape
      fork case, read self
        hook circle
          send back, text <circle>
        hook square
          send back, text <square>
```

## Conditional Implementation (`coat`)

Implement a trait only when type parameters satisfy constraints:

```tree
coat form
  head item, base clone
  head allocator, base allocator
  suit list
    head item
    head allocator
    wear clone
      task clone
        take self, loan true
```

Multiple constraints:

```tree
coat form
  head item, base hash
  head allocator, base allocator
  suit list
    head item
    head allocator
    wear hash
      task hash
        take self, loan true
```

## Trait Bounds (`need`)

Require a type parameter to implement a trait:

```tree
task sort
  head t, need comparable
  take items, like list
  like list
```

```tree
form set
  head t, need hashable
```

## Self Type

Methods use `self` to reference the current instance:

```tree
mask cloneable
  task clone
    take self, loan true
    like self
```

```tree
form counter
  link value, like u64

  task increment
    take self, flex true
```

## Conversion Trait

```tree
mask conversion
  head target
  task cast
    take self
    like target
```
