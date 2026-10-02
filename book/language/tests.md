# Tests

A test in Term is ordinary code. You write a `.tree` file, open each test with `test <name>`, assert with `want hold` or `want miss`, and run them with `term test`. For laws that should hold for every input, you do not sample. You state a `rule` and let the type checker prove it. Both styles live in the same file and both run under one command.

Maps to: unit tests (assert on examples) and property tests / proofs (assert on all inputs).

## Cheatsheet

| Write | Means |
| --- | --- |
| `test <name>` | a test: a name, then the steps and assertions indented under it |
| `want hold` | assert the boolean expression under it is true |
| `want miss` | assert the boolean expression under it is false |
| `want hold, read flag` | the one-line form, for an expression that fits on the line |
| `rule name` | a proof: a law the checker discharges, run like a test |
| `show hold` | state the obligation a rule must satisfy |
| `calm hold` | settle the obligation by computation (reflexivity) |
| `fold x` | prove by structural induction over `x` |
| `cite lemma` | use an already-proven rule |

The whole assertion surface is one word with two modes: `want hold` for "this is true", `want miss` for "this is false". The expression under it is any call that returns a boolean. Equality is `call is-equal`. Containment is `call contains`. Bounds are `call is-above` / `call is-below`. There is no separate assertion for each one.

A `test` needs no import. `term test` finds every file under `code/` and `test/` that holds a `test`, `hold` or `rule`, rewrites each `test` block into a task that fails at its first unmet `want`, and runs it.

Run everything:

```bash
term test            # run every test
term test parser     # only test files whose path or text contains "parser"
```

## A quick example test

`test` takes a name, written as a text literal. The body under it is ordinary code ending in an assertion.

```tree
test <add two and three>
  want hold
    call is-equal
      call add
        code 2
        code 3
      code 5
```

The name is what `term test` prints beside `ok` or the failure. `want hold` checks that `is-equal` returned true.

## A test with setup

When a test needs steps before the assertion, put them in the body before the `want`.

```tree
load @term/base/code/list
  find size

test <push grows the list>
  save items
    make list
  call items/push
    code 42
  want hold
    call is-equal
      call size(read items)
      code 1
```

The body builds a list, pushes to it, and asserts the size is one. A test may carry any number of `want` lines. The first one that fails ends the test.

## The assertion surface

`want hold` and `want miss` are the only assertions. Everything under them is a plain operator call that already returns a boolean. Pick whatever reads clearly.

```tree
load @term/base/code/text
  find contains

test <assorted assertions>
  # equality and its negation
  want hold
    call is-equal
      code 4
      code 4
  want miss
    call is-equal
      code 4
      code 5
  # a boolean asserts itself
  save ready, true
  want hold, read ready
  # text containment
  want hold
    call contains
      text <hello world>
      text <world>
  # ordered bounds
  want hold
    call is-above
      code 10
      code 3
  want hold
    call is-below
      code 3
      code 10
```

`is-equal` compares values. A boolean value is its own assertion. `call contains` checks text containment. `call is-above` and `call is-below` check strict bounds. Each returns whether it held, and `want` turns the answer into a pass or a failure.

## Running a suite

There is no suite object to build. Every `test` block in the project is one test, and `term test` runs them all, prints one line per test, and exits non-zero when any failed.

```bash
term test
```

```
  code/sample.tree
    ok  add two and three
    ok  push grows the list
    ok  assorted assertions

  ✓ 3 tests passed
```

## Proof-as-test: laws that hold for every input

A unit test checks one example. A `rule` checks a claim for all inputs, and the checker proves it. A rule runs under `term test` like any other test, but it cannot fail at runtime. It either type-checks or the build stops.

State the obligation with `show hold`, then discharge it.

```tree
form natural
  case zero
  case succ
    link prior, like natural

task one
  like natural
  send back
    make succ
      bind prior
        make zero

task two
  like natural
  send back
    make succ
      bind prior
        call one

task plus
  take a, like natural
  take b, like natural
  like natural
  fork case, read a
    case zero
      send back
        read b
    case succ
      send back
        make succ
          bind prior
            call plus
              read prior
              read b

rule one-plus-one-is-two
  show hold
    call is-equal
      call plus
        call one
        call one
      call two
  calm hold
```

`show hold` states what must be true: `plus one one` equals `two`. `calm hold` settles it by computation. The checker reduces both sides to the same normal form, so the law holds with no test data.

For a law over all inputs, bind the universal variable and prove by induction. This rule goes in the same file as `natural` and `plus` above:

```tree fragment
rule plus-zero-right
  mark a, like natural
  show hold
    call is-equal
      call plus
        read a
        make zero
      read a
  fold a
```

`mark a, like natural` quantifies over every natural. `fold a` proves it by structural induction: the `zero` case and the `succ` case, each discharged automatically. Chain a previously proven rule into a later one with `cite`.

Never write a proof as a `test`. A `test` block becomes a task that returns a boolean, which proves nothing about the inputs it did not try. A proof is a `rule`.

## Where to put tests

Tests are plain `.tree` files. Keep them near the code they cover, or in the package's `test/` directory, and name them by what they check. `term test` discovers them and runs each. Use `test` blocks (`want hold`, `want miss`) for behavior on examples, and rules (`rule`, `show hold`) for laws that must hold everywhere.

See [math](../math/readme.md) for the full proof system: `calm`, `fold`, `cite`, and `seek`. See [debugging](debugging.md) for reading a failed assertion's diagnostic frame.
