# Proving in Term

Term's type system can **prove things**. You state a claim with `show hold`, give one tactic line, and the compiler checks it. A claim that is true compiles. A claim that is false is rejected. That rejection is the whole point: a proof you can run is a proof you cannot fudge.

This works because types *are* propositions. A type that has a value is a true proposition (the value is its proof). A type with no value is a false one. So "prove this" and "build a value of this type" are the same job, and the compiler already does that job.

Maps to: a proof assistant (Coq, Lean, Agda) with dependent types, where checking a proof is checking a program.

## Cheatsheet

A proof is a `rule` with a `show hold` body and a tactic.

```tree
rule my-claim
  show hold
    call is-equal      # the comparison head
      <left>
      <right>
  calm hold            # the tactic that discharges it
```

### Keywords

| Head | Job |
| --- | --- |
| `rule <name>` | name a proof |
| `mark x, like T` | bind a universally quantified variable (prove it for **all** `x`) |
| `show hold` | state the claim to prove |
| `hold` | a checked claim (as an obligation on a `task`, not a full `rule`) |
| `cite <lemma>` | bring a proven lemma into the proof |

### Comparison heads (the claim inside a `hold`)

| Head | Means | Example claim |
| --- | --- | --- |
| `call is-equal` | left equals right | `2 + 2 = 4` |
| `call is-unequal` | left differs from right | `2 ≠ 3` |
| `call is-above` | left > right | `x⁴ − 3x² + 3 > 0` |
| `call is-below` | left < right | `0 < 1` |
| `call is-minimum` | left ≥ right | `(xy − z)² ≥ 0` |
| `call is-maximum` | left ≤ right | `n ≤ n + 1` |

Inside the comparison you build the two sides with the ordinary value heads you already know: `call add`, `call multiply`, `call subtract`, `make succ`, `read x`, `code 0`. A claim is just a comparison of two expressions.

### Tactics (the line that discharges the claim)

| Tactic | What it does | Reach |
| --- | --- | --- |
| `calm hold` | settle the claim by **computing** both sides to normal form | definitional equality, decided arithmetic, polynomial positivity |
| `fold <var>` | **structural induction** over an inductive value | universal laws over `nat` and other `form`s (see [induction](induction.md)) |
| `cite <lemma>` | rewrite using an already-proven `rule` | chaining lemmas into a bigger proof |
| `auto` | **bounded search** over known lemmas plus computation | goals reachable without naming the lemma by hand |

`calm hold` is the workhorse. If the two sides compute to the same value, the claim holds. If they cannot, it fails. `fold` and `cite` and `auto` exist for the claims that computation alone cannot close, where you need induction or a previously proven fact.

## A `hold` is a checked claim

The simplest use is not even a separate proof. A `hold` written inside a `task` is a precondition the compiler verifies at every point the value flows.

```tree
task safe-step
  take n, like nat
  hold
    call is-minimum
      call add
        read n
        code 1
      code 1
  send back
    call add, read n, code 1
```

The `hold` says `n + 1 ≥ 1`. The compiler decides it once and for all `n`, before the task ever runs. A claim that did not hold for some `n` would be a compile error here, not a runtime surprise.

A full `rule` is the same idea given a name so other proofs can `cite` it.

## Definitional equality

The most basic proof: two expressions that compute to the same value. Define a recursive function and ask the compiler to confirm a specific result.

```tree
form nat
  case zero
  case succ
    link prior, like nat

task double
  take n, like nat
  like nat
  fork case, read n
    case zero
      send back
        make zero
    case succ
      link prior
      send back
        make succ
          bind prior
            make succ
              bind prior
                call double
                  read prior

rule double-one
  show hold
    call is-equal
      call double
        make succ
          bind prior
            make zero
      make succ
        bind prior
          make succ
            bind prior
              make zero
  calm hold
```

`calm hold` runs `double` on `1`, gets `2`, compares it to the literal `2`, and the claim holds. No induction is needed because both sides are closed values that compute all the way down.

## A false claim is rejected (the soundness control)

Change the right side to `3` and the proof does not compile.

```tree
rule double-one-wrong
  show hold
    call is-equal
      call double
        make succ
          bind prior
            make zero
      make succ
        bind prior
          make succ
            bind prior
              make succ
                bind prior
                  make zero
  calm hold
```

`double 1` computes to `2`, the right side is `3`, and `2 ≠ 3`, so `calm hold` cannot settle it. The compiler reports the gap. This is the control you keep around: a checker that accepts everything proves nothing. Term accepts the true claim above and rejects this one.

## Deciding arithmetic

`calm hold` does not only unfold functions. Over the integers it decides linear constraints, including which equations have integer solutions.

```tree
rule no-solution
  mark x, like integer
  show hold
    call is-unequal
      call multiply
        code 2
        read x
      code 3
  calm hold
```

This proves `2x ≠ 3` for every integer `x`. The companion claim `2x = 4` is satisfiable, so the matching inequality is *not* a theorem and Term would leave it unproven. The engine answers both honestly.

## Nonlinear inequalities (Term decides polynomial positivity)

The deciding power extends to polynomials. Term proves inequalities that hold for **all** real values, including hard ones with no sum-of-squares certificate.

```tree
rule quartic-positive
  mark x, like integer
  show hold
    call is-above
      call add
        call subtract
          call multiply
            call multiply
              read x
              read x
            call multiply
              read x
              read x
          call multiply
            code 3
            call multiply
              read x
              read x
        code 3
      code 0
  calm hold
```

This proves `x⁴ − 3x² + 3 > 0` for every `x`. The same tactic proves the Motzkin polynomial `x⁴y² + x²y⁴ − 3x²y² + 1 ≥ 0` and the Choi-Lam form, classic non-negative polynomials that are provably not sums of squares. A polynomial that dips below zero somewhere is rejected. A square is always non-negative, and Term knows it:

```tree
rule square-nonneg
  mark x, like integer
  mark y, like integer
  mark z, like integer
  show hold
    call is-minimum
      call multiply
        call subtract
          call multiply
            read x
            read y
          read z
        call subtract
          call multiply
            read x
            read y
          read z
      code 0
  calm hold
```

This proves `(xy − z)² ≥ 0` for all `x`, `y`, `z`.

## Letting the search find the lemma

When a claim needs a known fact plus a little computation, `auto` finds it for you.

```tree
rule use-auto
  mark a, like nat
  show hold
    call is-equal
      make succ
        bind prior
          call plus
            read a
            make zero
      make succ
        bind prior
          read a
  auto
```

`auto` closes this from the `plus`-zero law plus computation, so you never name the lemma. A non-theorem is left unproven rather than wrongly closed, the same honesty as `calm hold`.

## Where to go next

- [induction](induction.md) for `fold`, proving a law for every value.
- [datatypes](datatypes.md) for the identity type, indexed families, and higher types.
- [structures](../language/structures.md) for the `form` and `fork case` these proofs are built on.
