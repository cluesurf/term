# Datatypes in proofs

A plain `form` is a sum type. A `form` with an `head` index is something more: the type itself can carry a value. `vec 3` is a different type from `vec 4`. `eq a b` is the type of proofs that `a` equals `b`. These **indexed families** let you state claims the compiler enforces before anything runs, and they are the building blocks of every proof in this section.

Maps to: GADTs (Haskell, OCaml), dependent types and the identity type (Agda, Lean), and higher inductive types from homotopy type theory (HoTT).

## Cheatsheet

| Head | Job |
| --- | --- |
| `form <name>` | declare a datatype |
| `head <param>` | a type parameter (generic), or with `, like T` an index (a value the type carries) |
| `case <variant>` | a constructor |
| `link <field>, like T` | a field on a constructor |
| `head` under a `case` | pin the index this constructor produces |
| `mark prop` | truncate the type so any two elements are equal |
| `fork case, read e` | eliminate a proof, reading its index back out |

The key move is `head`. As `head t` it is an ordinary type parameter. As `head n, like nat` it is an **index**: a value baked into the type, so `vecnat` carrying `n` is genuinely a family of types, one per `n`.

## The identity type

Equality is not built in. It is a datatype with one constructor, `refl`, which can only build a proof that something equals **itself**. The index is the pair of values being compared.

```tree
form eq
  head a, like nat
  head b, like nat
  case refl
    link c, like nat
    head
      read c
    head
      read c
```

`refl c` produces a value of type `eq c c`. There is no way to make `eq 0 1`, because `refl` forces both indices to the same `c`. That impossibility *is* the meaning of equality.

To **use** a proof of `a = b`, eliminate it with `fork case`. The single `refl` arm binds `c`, and because matching `refl` teaches the compiler that `a` and `b` are both `c`, you may read the shared value back out.

```tree
task diag
  take a, like nat
  take b, like nat
  take e, like eq
    head
      read a
    head
      read b
  like nat
  fork case, read e
    case refl
      link c
      send back
        read c
```

The base library ships these proofs over this identity type. `refl` builds `a = a`, `symmetry` turns `a = b` into `b = a`, `transitivity` chains `a = b` and `b = c` into `a = c`, and `substitution` transports a property along an equality, all by `fork case` on `refl`. A proof of `a = b` lets you **transport** a value of `vec a` into `vec b`.

## Length-indexed vectors

The classic indexed family: a list that carries its length in its type. `vnil` has length `zero`. `vcons` onto a vector of length `count` produces one of length `succ count`. The `head` lines on each constructor pin that length.

```tree
form vecnat
  head n, like nat
  case vnil
    head
      make zero
  case vcons
    link count, like nat
    link item, like nat
    link rest, like vecnat
    head
      read count
    head
      make succ
        bind prior
          read count
```

Now a function can **demand** an exact length in its signature. The index is part of the type, so the requirement is checked when you call the function, not inside it.

```tree
task expects-two
  take v, like vecnat
    head
      make succ
        bind prior
          make succ
            bind prior
              make zero
  like nat
  send back
    make zero
```

`expects-two` only accepts a `vecnat` of length `2`. Passing the empty vector or a length-1 vector is rejected by the type, before anything runs. An out-of-bounds index, like reading the head of an empty vector, becomes a type error you cannot write down rather than a crash you hit later.

## Higher types

A `mark prop` on a `form`, or an index whose values are themselves equalities, lets you build **higher inductive types**: datatypes with not just points but paths between them. These come from homotopy type theory. Here is the smallest taste of each.

### Truncation

`mark prop` forgets all structure but inhabitedness. Inside the truncation, any two elements are equal, even when the underlying values differ.

```tree
form squash
  mark prop
  case wrap
    link val, like nat
```

`wrap 0 = wrap 1` holds inside `squash`, while `0 = 1` in plain `nat` stays false. Use this when you want to know that *a* value exists but must not depend on *which* one.

### The circle

One point and one **loop** from the point to itself, where the loop is a genuine, non-trivial path. The circle does not collapse to a point. The loop is modeled as a value of an identity type from `base` to `base`.

```tree
form circle
  case base

form path
  head a, like circle
  head b, like circle
  case id
    link c, like circle
    head
      read c
    head
      read c

task loop
  like path
    head
      make base
    head
      make base
```

A map out of the circle is given by a point and a loop in the target, and the loop's action computes to that target loop. This is how you talk about winding and identity at the type level.

### Set quotients

Glue chosen elements together with a path, so a function out of the quotient **must respect** the gluing. Representatives stay distinct definitionally and are identified only through the glue.

```tree
form quot
  case cls
    link rep, like nat

task glue
  like qpath
    head
      make cls
        bind rep
          make zero
    head
      make cls
        bind rep
          make succ
            bind prior
              make succ
                bind prior
                  make zero
```

`glue` is a path identifying the class of `0` with the class of `2`. A function out of `quot` that would tell glued elements apart cannot be built, so the quotient really is the set of equivalence classes, enforced by the type.

## How they fit together

- `head ... , like T` turns a type into a **family** indexed by a value.
- The identity type `eq` is the family that makes "equal" a thing you can prove and transport.
- Length-indexed vectors are the family that makes "wrong size" a type error.
- `mark prop` and equality-valued indices give you **higher** types: truncations, the circle, and quotients.

Every datatype here is checked by the compiler. A well-typed construction goes through. An ill-typed one, the empty vector where two are required, or a function that separates glued elements, is rejected.

## Where to go next

- [readme](readme.md) for stating and discharging claims with `show hold` and the tactics.
- [induction](induction.md) for `fold`, which inducts over exactly these datatypes.
- [structures](../language/structures.md) for `form`, `case`, and `head` as everyday data.
