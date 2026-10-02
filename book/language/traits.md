# Traits

A trait is a named set of method signatures a type promises to provide. Define one with `mask`. Implement it for a type with `wear` (inside the form) or `suit` (standalone). Require it on a type parameter with `need`.

Maps to: a Rust trait, a Swift protocol, a Java interface, a Haskell typeclass.

## Cheatsheet

| Head | Job |
| --- | --- |
| `mask <name>` | define a trait: a list of `task` signatures |
| `task` (in a `mask`) | a required method, body omitted (signature only) |
| `head <param>` | a type parameter on the trait |
| `head <param>, base self` | a parameter defaulting to the implementing type |
| `wear <trait>` | implement a trait inside a `form` body |
| `suit <type>` | implement traits for a type defined elsewhere |
| `need <trait>` | require a trait on a type parameter (`head t, need <trait>`) |
| `take self` | the receiver of a trait method |
| `like self` | the implementing type, as a return type |

A method signature is a `task` with `take`/`like` lines but no `send back`. An implementer must supply every method its mask declares. There are no default methods: a mask method that has a body is still required of every implementer, and the build names each one that is missing (`incomplete-instance`).

## Defining a trait

A `mask` lists the methods an implementer must supply.

```tree
mask printable
  task to-text
    take self
    like text
```

A mask with several methods. An implementer provides both.

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
mask printable
  task to-text
    take self
    like text

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

A form can wear several traits. With `printable` and `comparison` defined as above:

```tree fragment
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
          call to-text, read self
          call to-text, read other

    task is-unequal
      take self
      take other, like color
      like boolean
      send back
        call is-unequal
          call to-text, read self
          call to-text, read other
```

## Implementing for an outside type

When the type lives in another module, implement with `suit`. Here `shape` is the form from [structures](structures.md) and `printable` the mask above:

```tree fragment
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

`need` constrains a type parameter so it must implement a trait. The bound lets the body call that trait's methods, in member form on a value of the parameter's type.

```tree
mask ranked
  task outranks
    take self
    take other, like self
    like boolean

task largest
  head t, need ranked
  take items
    like list
      like t
  like t
  send back
    call items/reduce
      task pick
        take best, like t
        take item, like t
        like t
        fork test
          hook test
            call item/outranks
              read best
          hook hold
            send back, read item
          hook miss
            send back, read best
      call items/get
        code 0
```

Multiple bounds: repeat `need` under the same `head`.

```tree
load @term/base/code/console
  find log

mask hashable
  task hash
    take self
    like number

mask printable
  task to-text
    take self
    like text

task store
  head t, need hashable
    need printable
  take value, like t
  like void
  call log
    call value/to-text
```

## Calling trait methods

On a value of a concrete type, call a trait method in function form: name the method and pass the receiver first. Inside a task that is generic over a bound, as in `largest` and `store` above, reach the method through `/` in member form, with the receiver before the slash.

```tree fragment
save label
  call to-text, read value      # function form, a concrete `color`

save label
  call value/to-text            # member form, a `value` of a bound type `t`
```

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
