# Laws and proofs in Term

What a `rule` means, what owes what, and what the compiler refuses.
Written 2026-09-18 when the claim wall landed (`law-proof-gate-0002`).
The project is [project/law-proof-gate.md](archive/law-proof-gate.md)
and the design it follows is
[../research/repo/bend/laws.md](../research/repo/bend/laws.md).

## The one sentence

**A `rule` states a claim, a `task` of the same name proves it, and
between the two the name is declared and not defined.**

## Two shapes of rule

Told apart by one thing: whether the rule states a `show` goal.

### A claim

No `show`. The rule declares a name at a type and owes a proof.

```tree
rule symmetry
  head a
  take x, like a
  take y, like a
  take proof
    like equal a x y
  like equal a y x

task symmetry
  take x
  take y
  take proof
  fork case, read proof
    case refl
      send back
        make equal/refl
```

`head` is a generic, `take` is a parameter, `like` is the result. The
fill states the name and its parameters and nothing else: **it inherits
the claim's generics, result, and any parameter type it left blank**,
so the type is written once, on the rule.

### A theorem

Has a `show`. The rule is a law over its binders, and the goal becomes
a `hold` the prover must discharge.

```tree
rule add-zero
  seat a, like number
  show
    is-equal
      call add
        read a
        code 0
      read a
```

Here `seat` is a universal binder, `take` (or `have`) is a hypothesis
the goal is proved under, `find` is an existential witness, `base true`
postulates it as an axiom, and the proof steps are the same vocabulary
a `hold` takes: `fold`, `case`, `calm`, `melt`, `cite`, `meet`, `fork`,
`hint`, `turn`, `seek` (formerly `auto`).

## What the compiler refuses

| the shape | what happens |
| --- | --- |
| a claim with no fill | `open-claim`. The build fails |
| a claim with `note open` | compiles, and the build line says how many are open |
| code that runs calling an unfilled claim | `open-claim-used`. The build fails |
| a fill whose body does not inhabit the claim | `type-mismatch`, like any other declaration |
| a goal the prover refutes | `unproven`. The build fails |
| **a goal the prover cannot reach** | `unchecked-hold`. **The build fails** |

That last row is the one that changed. Until 2026-09-18 it was a
warning, and two plainly false laws compiled clean under it:
`a * b == a * a` over two naturals, and `secret a == a` where `secret`
adds one. Neither is true and neither was refused, because the linear
prover could not reach either and "could not reach" was reported as a
warning.

**Not proven is not proven.** A claim nobody checked and a claim
somebody checked are not the same thing, and a gate that cannot tell
them apart is not a gate.

## `note open`

```tree
rule halve-is-exact
  note open
  take n, like number
  like number
```

An open claim compiles, because a book under construction has to, and
the build says so every time:

```
  ✓ Compiled 1 file to host/
  ✗ 1 claim open: halve-is-exact
```

It is still not proven, so **running code may not call it**. It is a
promise, and a program cannot be built on one.

This is Bend's `?TODO`: a way to leave a hole that is counted rather
than hidden.

## Why a `task` and not a `test`

A proof term is a function. `task` is the word for a function in Term.

`test` is the word for something the test runner runs, and the test
preprocessor rewrites every `test <phrase>` block into
`task <slug> / note async / like boolean / ... / send back true`. A
proof of `equal a y x` that returns a boolean is not a proof of
anything.

The six proofs in `deck/base/code/proof/` were
written as `test <name>` beside `rule <name>`, connected by nothing but
a shared spelling, and none of them held a `want` assertion. They were
converted to `task` when the wall landed. Nothing stops the shape
coming back yet, which is `law-proof-gate-0010`.

## What a fill must be, since 2026-10-02

A `task` of a claim's name is a proof only if all three hold, and each
failure has its own diagnostic:

| the fill | refused as |
| --- | --- |
| calls anything impure (native code, async, a body-less task) | `impure-proof` |
| is not shown to terminate | `looping-proof` |
| does not elaborate to ONE kernel term checked against the claim's type | `unverified-proof`, with the kernel's reason |
| calls a task, at any depth, that fails any of the three rows above | `unverified-proof`, naming that task and the call path to it |

The last row landed later the same day. The kernel checks a fill with
every task it calls read at that task's SIGNATURE, so a fill that
called a helper the kernel had declined proved whatever the helper's
signature said. A helper typed `equal a x x -> equal a x y` made any
two values equal. `groundingOf` in `check/claim.ts` walks the call
graph. A separate-compilation stub has no body to walk, so its own unit
stamps `grounded` on the task when the kernel accepted it and
everything below it, and an unstamped stub is not grounded.

Before this, any task of the right name counted. A self-call proved any
claim, so did a body with no `send back` at all, and so did a claim
stated at a type the kernel could not read. The stdlib's `absurd` was
false (`void` is a value the stdlib builds) and is now stated over
`never`, a type with no values. All of it is in
[proof-by-default/readme.md](readme.md).

## Equality

`equal` is an indexed family over its two values, written
`like equal a / head / read x / head / read y`. Until 2026-10-02 it
took them as fields and was written `like equal a x y`, which the
checker read as `equal a`: the kernel proved any two values equal, and
every equality proof in the stdlib was checked against a statement that
named no values. The stdlib's `refl`, `symmetry`, `transitivity`,
`congruence` and `substitution` are proven against the family now.

A match does not rewrite a variable already in scope whose type mentions
the matched indices. When a proof needs that (`transitivity` has
`right : equal a y z` in scope while it matches `left : equal a x y`),
match in a helper that returns a FUNCTION over the dependent value, the
convoy: see `chain` and `carry` beside the two proofs that use them.
The kernel checks the convoy as one term since 2026-10-02. Before,
the inline `task id` could not name the enclosing task's generic `a`
in its own annotations, so the kernel declined both helpers and
`transitivity` and `substitution` rested on bodies nobody checked.

A match refines the RESULT, not what is in scope, and since 2026-10-05 it does
so in two more places. A match on a plain form whose result mentions the
subject (`sift n` in a task returning `accessible n`) checks each branch at
its constructor (`accessible zero`, `accessible (succ prior)`). A match on an
indexed family whose index is headed by a constructor teaches every branch
that index's arguments, with no branch impossible: `below m (succ p)` matched
at `next k`, whose index is `succ k`, is checked with p and m set to k. Both
are what `seed.tree/code/relation/well-founded.tree` needed to prove every
natural accessible. A claim's proof the kernel refuses is `unverified-proof`,
with the kernel's reason.

A family of types is a parameter that is a task to `type`
(`take p / like task / take value, like a / like type`), used as a type
with `like p / head / read x`.

The proof step that searches the proven lemmas is `seek`. It was `auto`,
which is not in `hold/base/terms.json`.

## The gate

**`term hold`** is it. One line, a non-zero exit while any file fails to
compile, any claim is open, or any tier-0 obligation is unproven and not
named in the project's `hold.json`. `--commit` rewrites `hold.json` and
prints how many entries that added. It also prints what the kernel did
with every task and the trust ledger. The cross-backend differential it
used to run is `term hold --cross`.

## What is not built yet
- **The claim and its proof in separate files with separate owners**, so
  a human owns one and an agent owns the other.
  `law-proof-gate-0003`. The checker already works over a whole
  program, so the mechanism is there; what is missing is the
  convention and whatever pulls both files into the build.
- **A graded eval corpus** that measures whether models can close a law
  they are handed. `law-proof-gate-0008`.

## Where the code is

| file | what |
| --- | --- |
| `deck/make/code/check/claim.ts` | the wall: `fillClaims` then `checkClaims` |
| `deck/make/code/compile/mint-bridge.ts` | `ruleOf`, which tells the two shapes apart |
| `deck/mill/code/tree/code/rule/def/mine.tree` | the grammar: what a rule's children are |
| `deck/mill/code/tree/code/rule/def/mint.tree` | the binds: **a site needs both halves or it never reaches the form** |
| `deck/make/code/check/holds.ts` | the prover, and the three verdicts |
| `deck/make/code/parser/diagnostic.ts` | `open-claim`, `open-claim-used`, `unchecked-hold` |
| `test/check/claim.ts` | 20 checks, controls included |

One thing that cost an hour and is worth knowing: **a mill site needs a
`mine` alternative AND a `mint` bind.** The `fields` a form carries come
from the mint side. A site added to the grammar's `mine` half alone
parses and then vanishes, with no error anywhere. Rebake with
`pnpm term:mill-bundle --commit` after either edit.
