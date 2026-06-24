# Traits

A trait is a named set of method signatures a type promises to provide. Define one with `mask`. Implement it for a type with `wear` (inside the form) or `suit` (standalone). Require it on a type parameter with `need`.

Maps to: a Rust trait, a Swift protocol, a Java interface, a Haskell typeclass.

## Cheatsheet

| Head | Job |
| --- | --- |
| `mask <name>` | define a trait: a list of `task` signatures |
| `task` (in a `mask`) | a required method, body omitted (signature only) |
| `task` with a body (in a `mask`) | a default method, used unless overridden |
| `head <param>` | a type parameter on the trait |
| `head <param>, base self` | a parameter defaulting to the implementing type |
| `wear <trait>` | implement a trait inside a `form` body |
| `suit <type>` | implement traits for a type defined elsewhere |
| `need <trait>` | require a trait on a type parameter (`head t, need <trait>`) |
| `take self` | the receiver of a trait method |
| `like self` | the implementing type, as a return type |

A method signature is a `task` with `take`/`like` lines but no `send back`. A default method is the same with a body.

## Defining a trait

A `mask` lists the methods an implementer must supply.

```tree
mask printable
  task to-text
    take self
    like text
```

Several methods, including a default. The default `is-unequal` is written in terms of `is-equal`, so an implementer only has to provide `is-equal`.

```tree
mask comparison
  task is-equal
    take self
    take other, like self
    like boolean

  task is-unequal
    take self
    take other, like self
    like boolean
    send back
      call not
        call is-equal, read self, read other
```

A trait can carry a type parameter. `base self` makes it default to the implementing type.

```tree
mask addition
  head output
  head other, base self

  task add
    take self
    take other
    like output
```

## Implementing on a form

`wear` attaches an implementation inside the form it belongs to.

```tree
form color
  case red
  case green
  case blue

  wear printable
    task to-text
      take self
      like text
      fork case, read self
        case red
          send back, text <red>
        case green
          send back, text <green>
        case blue
          send back, text <blue>
```

A form can wear several traits.

```tree
form color
  case red
  case green
  case blue

  wear printable
    task to-text
      take self
      like text
      fork case, read self
        case red
          send back, text <red>
        case green
          send back, text <green>
        case blue
          send back, text <blue>

  wear comparison
    task is-equal
      take self
      take other, like color
      like boolean
      send back
        call is-equal
          call to-number, read self
          call to-number, read other
```

## Implementing for an outside type

When the type lives in another module, implement with `suit`.

```tree
suit shape
  wear printable
    task to-text
      take self
      like text
      fork case, read self
        case circle
          send back, text <circle>
        case square
          send back, text <square>
```

## Trait bounds

`need` constrains a type parameter so it must implement a trait. The bound lets the body call that trait's methods.

```tree
task largest
  head t, need comparable
  take items
    like list
      like t
  like maybe
  send back
    call reduce, read items
      task pick
        take best, like t
        take item, like t
        like t
        fork test
          hook test
            call is-above, read item, read best
          hook hold
            send back, read item
          hook miss
            send back, read best
      call get, read items, code 0
```

Multiple bounds: repeat `need` under the same `head`.

```tree
task store
  head t, need hashable
    need printable
  take value, like t
  like void
  call write-line
    call to-text, read value
```

## Calling trait methods

Both call styles work. Function form names the method and passes the receiver. Member form reaches the method through `/`.

```tree
host label
  call to-text, read value      # function form

host label
  read value/to-text            # member form
```

Member form reads best for a method that takes only `self`. A method with arguments reads more clearly in function form.

## Self type

`take self` names the receiver. `like self` as a return type means "the implementing type," so each implementer returns its own type.

```tree
mask cloneable
  task clone
    take self
    like self
```

## See also

- [types](types.md) for type parameters and where `need` appears in a signature.
- [structures](structures.md) for `form`, `case`, and `make`.
- [matching](matching.md) for `fork case` inside trait methods.
- [collections](collections.md) for `list`, `set`, and `reduce`.
