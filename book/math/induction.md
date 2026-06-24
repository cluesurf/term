# Proof by induction

Some claims are true for **every** value, not one. `double 1 = 2` is a single fact that `calm hold` can compute. `n + 0 = n` is a law: it must hold for `zero`, for `succ zero`, for every `nat` there will ever be. You cannot compute infinitely many cases. You prove the pattern once.

That tactic is `fold`. It runs **structural induction** over an inductive `form`: prove the base case, prove the step assuming the smaller case, and the kernel stitches them into a proof for all values.

Maps to: an induction proof in Lean or Coq (`induction n`), or the inductive cases of a recursive proof in Agda.

## Cheatsheet

| Head | Job |
| --- | --- |
| `mark x, like T` | bind the universally quantified variable (the "for all `x`") |
| `show hold` | state the law to prove |
| `fold <var>` | prove it by structural induction on `<var>` |
| `cite <lemma>` | rewrite the goal with a previously proven `rule` |

The shape of every induction proof:

```tree
rule the-law
  mark n, like nat        # for all n
  show hold
    call is-equal
      <expression in n>
      <expression in n>
  fold n                  # induct on n
```

`fold n` asks the kernel to:

1. Prove the claim for the base constructor (`zero`).
2. Prove it for `succ prior`, given that it already holds for `prior` (the induction hypothesis).

When both close by computation, the law is proved. If either case fails, the proof fails.

## The base law: `n + 0 = n`

Define addition by recursion on the first argument, then prove zero is a right identity.

```tree
form nat
  case zero
  case succ
    link prior, like nat

task plus
  take a, like nat
  take b, like nat
  like nat
  fork case, read a
    case zero
      send back, read b
    case succ
      link prior
      send back
        make succ
          bind prior
            call plus
              read prior
              read b

rule plus-zero
  mark n, like nat
  show hold
    call is-equal
      call plus
        read n
        make zero
      read n
  fold n
```

Why `fold` is needed here and `calm hold` is not enough: `plus` recurses on its **first** argument, so `plus n zero` is stuck while `n` is an unknown variable. There is nothing to compute. Induction unsticks it. The `zero` case is `plus zero zero = zero`, which computes. The `succ` case is `plus (succ p) zero = succ p`, which unfolds to `succ (plus p zero)`, and the induction hypothesis says `plus p zero = p`, closing it.

## Inducting on the other side: `0 + n = n`

The mirror law looks identical but is actually the easy one, because `plus` recurses on the first argument.

```tree
rule zero-plus
  mark n, like nat
  show hold
    call is-equal
      call plus
        make zero
        read n
      read n
  calm hold
```

Here `plus zero n` computes straight to `n` by the first match arm, so plain `calm hold` settles it with no induction at all. Use `calm hold` when one side already reduces. Reach for `fold` only when the recursion is stuck on a variable.

## Chaining lemmas with `cite`

A harder law usually leans on simpler ones. `cite` brings a proven `rule` into the current proof and rewrites the goal with it. Commutativity of addition needs both `plus-zero` and the "successor pushes out" lemma below.

```tree
rule plus-succ
  mark a, like nat
  mark b, like nat
  show hold
    call is-equal
      call plus
        read a
        make succ
          bind prior
            read b
      make succ
        bind prior
          call plus
            read a
            read b
  fold a

rule plus-commutes
  mark a, like nat
  mark b, like nat
  show hold
    call is-equal
      call plus
        read a
        read b
      call plus
        read b
        read a
  fold a
  cite plus-zero
  cite plus-succ
```

In the `succ` case of `plus-commutes`, the goal needs `plus b (succ a) = succ (plus b a)`, which is exactly `plus-succ`. The `zero` case needs `plus b zero = b`, which is `plus-zero`. Each `cite` rewrites with one lemma, and the `fold` carries the structure. This is how the **full commutative semiring of the naturals** is built: commutativity, associativity, and distributivity of `*` over `+`, each a `fold` chained from the laws proved before it.

## Inducting over your own type

`fold` is not special to `nat`. It works over any inductive `form`. A law about list length, for instance, inducts over the list constructors.

```tree
form roll
  head t
  case nil
  case cons
    link item, like t
    link more, like roll t

task size
  head t
  take xs, like roll t
  like nat
  fork case, read xs
    case nil
      send back
        make zero
    case cons
      link item
      link more
      send back
        make succ
          bind prior
            call size
              read more

rule size-cons
  head t
  mark item, like t
  mark more, like roll t
  show hold
    call is-equal
      call size
        make cons
          bind item, read item
          bind more, read more
      make succ
        bind prior
          call size
            read more
  calm hold
```

This last one closes by `calm hold` because `size (cons item more)` unfolds in one step. A law like `size (append xs ys) = size xs + size ys` would instead need `fold xs`, inducting over the structure of the first list. The rule is always the same: a fact about one constructor computes, a law about every value folds.

## When each tactic applies

- One side already reduces to the other: `calm hold`.
- The recursion is stuck on a universally bound variable: `fold <var>`.
- The step case needs a previously proven law: add `cite <lemma>` lines after the `fold`.
- You would rather not name the lemma: `auto` (bounded search, see [readme](readme.md)).

## Where to go next

- [readme](readme.md) for the tactic vocabulary and polynomial decisions.
- [datatypes](datatypes.md) for the indexed and higher types you can induct over.
