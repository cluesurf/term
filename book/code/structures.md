# Structures

Define data types with `form`. Three syntax patterns:

1. **Base form**: Define constructors with `link` fields.
2. **Alias form**: Give a new name to an existing type with `like`.
3. **Enum form**: List possible values with `case`.

## Base Form (Struct)

A basic form with fields and methods:

```tree
form user
  link email, like text

  task login
    take email
    take password
    call service/login
      read email
      read password
```

## Alias Form

Give a shorter name to a complex type:

```tree
form x
  like user
```

## Enum (Sum Type)

Use `case` for variants:

```tree
form boolean
  case true
  case false
```

```tree
form maybe
  case some
    link value
  case none
```

```tree
form result
  head t
  head e
  case okay
    link value, like t
  case error
    link value, like e
```

```tree
form order
  case less
  case equal
  case more
```

```tree
form nat
  case zero
  case succ
    link pred
```

## Struct (Product Type)

Use `link` without `case` for a plain record:

```tree
form kink
  link code, like text
  link note, like text
  link hint, like text
```

```tree
form pair
  head a
  head b
  link first, like a
  link second, like b
```

## Case with Fields

Each `case` can have `link` fields (constructor arguments):

```tree
form shape
  case circle
    link radius, like f64
  case rect
    link width, like f64
    link height, like f64
```

```tree
form tree
  case leaf
    link value, like u64
  case node
    link left, like tree
    link right, like tree
```

## Generic Type Parameters (`head`)

Add type parameters with `head`:

```tree
form box
  head t
  link value, like t
```

Multiple type parameters:

```tree
form hash
  head k
  head v
```

With trait bounds:

```tree
form sorted-list
  head t, need comparable
```

## Type Annotations (`like`)

Annotate fields and parameters with types:

```tree
link name, like text
link age, like u32
link active, like boolean
```

Reference another form as a type:

```tree
link color, like color
link items, like list
```

### Generic Type References

Pass type parameters to generic forms:

```tree
like list
  like u64
like maybe
  like text
```

### Function Types

Describe a closure or function-typed parameter:

```tree
like task
  head x
  take y
  like z
```

### Union and Intersection Types

```tree
like or
  like u8
  like u16
  like u32
```

```tree
like and
  like readable
  like writable
```

## Trait Bounds (`need`)

Constrain a type parameter to implement a trait:

```tree
form set
  head t, need hashable
```

## Constraints (`hold`)

Add a constraint on a form:

```tree
form positive
  hold, call is-valid
```

## Self Type

Reference the current form within its own methods:

```tree
form counter
  link value, like u64

  task increment
    take self, flex true
```

## Void Type

Represents no value:

```tree
task do-nothing
  like void
```

## Stability (`firm`)

Mark a definition as stable (part of the public API contract):

```tree
task safe-divide
  firm true
  take a, like u64
  take b, like u64
```

## Visibility

`hide` makes a field or form private:

```tree
form list
  link data, hide true
```

## Construction (`make`)

Create instances with `make`:

```tree
make pair
  bind first, mark 1
  bind second, mark 2
```

```tree
make some
  bind value, text <hello>
```

No-arg constructors:

```tree
make none
make true
make false
make zero
```

Nested construction:

```tree
make node
  bind left
    make leaf
      bind value, mark 1
  bind right
    make leaf
      bind value, mark 2
```

## Dock (Platform-Specific)

Forms can have platform-specific implementations:

```tree
form integer
  link dock
    like or
      like integer-32
      like integer-grow
```

## Union Types (`or`)

Express a value that can be one of several types:

```tree
link code
  like or
    like u8
    like u16
    like u32
```

## Methods on Forms

Define methods directly inside a form:

```tree
form list
  head t

  task push
    take self, flex true
    take item, like t

  task pop
    take self, flex true

  task get
    take self
    take index, like u64

  task get-size
    take self
    like u64

  task is-empty
    take self
    like boolean
```

## Standalone Functions for a Form

Define functions associated with a form via a namespace:

```tree
form user

host user-task
  task create
  task delete

call user-task/create
```
