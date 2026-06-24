# Tests

A test in Term is ordinary code. You write a `.tree` file, build small test values with `case`, assert with `want` or `deny`, and run them with `term test`. For laws that should hold for every input, you do not sample. You state a `rule` and let the type checker prove it. Both styles live in the same file and both run under one command.

Maps to: unit tests (assert on examples) and property tests / proofs (assert on all inputs).

## Cheatsheet

| Write | Means |
| --- | --- |
| `case name` | a test: a name plus an async work returning a boolean |
| `want got, expect` | assert two values are equal (returns boolean) |
| `deny got, expect` | assert two values differ (returns boolean) |
| `call run, read tests` | run a list of tests, print results, return a tally |
| `rule name` | a proof: a law the checker discharges, run like a test |
| `show hold` | state the obligation a rule must satisfy |
| `calm hold` | settle the obligation by computation (reflexivity) |
| `fold x` | prove by structural induction over `x` |
| `cite lemma` | use an already-proven rule |

The whole assertion surface is two words: `want` for equality, `deny` for inequality. Every other check is an ordinary operator returned directly. A boolean asserts itself (`send back, read flag`). Containment is `call contains`. Bounds are `call is-above` / `call is-below`. There is no separate assertion for each one.

Import the test library:

```tree
load @cluesurf/base/code/test
  find case
  find want
  find deny
  find run
```

Run everything:

```bash
term test            # run every test
term test parser     # only tests whose name contains "parser"
```

## A quick example test

`case` takes a name and a work. The work is an async task returning a boolean. End it with a `want` call.

```tree
load @cluesurf/base/code/test
  find case
  find want
load @cluesurf/base/code/math
  find add

task test-add
  like test
  send back
    call case
      text <add two and three>
      task work
        note async
        like boolean
        send back
          call want
            call add, code 2, code 3
            code 5
```

`call case` returns a `test` meta object. The first argument is the name, the second is the work. The work computes a value and asserts it with `want`, which returns whether the two sides were equal.

## A test with setup

When a test needs steps before the assertion, put them in the work before the final `want`.

```tree
load @cluesurf/base/code/test
  find case
  find want

task test-list-push
  like test
  send back
    call case
      text <push grows the list>
      task work
        note async
        like boolean
        save items
          make list
        call items/push
          code 42
        send back
          call want
            call items/size
            code 1
```

The work builds a list, pushes to it, and asserts the size is one. The work returns the boolean that `want` produced.

## The assertion surface

`want` and `deny` are the only assertions. Everything else is a plain operator call that already returns a boolean, so you return it directly. Pick whatever reads clearly.

```tree
task test-asserts
  like test
  send back
    call case
      text <assorted assertions>
      task work
        note async
        like boolean
        # equality and its negation
        save a, call want, code 4, code 4
        save b, call deny, code 4, code 5
        # a boolean asserts itself
        save c, read a
        # text containment
        save d, call contains, text <hello world>, text <world>
        # ordered bounds
        save e, call is-above, code 10, code 3
        save f, call is-below, code 3, code 10
        send back
          read a
```

`want` and `deny` compare values. A boolean value is its own assertion. `call contains` checks text containment. `call is-above` and `call is-below` check strict bounds. Each returns whether it held.

## Running a suite

Collect tests into a list and hand it to `run`. It executes each, prints the result, and returns a tally of passes and failures.

```tree
load @cluesurf/base/code/test
  find run

# the module body runs the suite: no main task
save tests
  make list
call tests/push
  call test-add
call tests/push
  call test-list-push
call run
  read tests
  wait true
```

`run` is async, so the call carries `wait true`. See [async](async.md) for `wait`.

## Proof-as-test: laws that hold for every input

A unit test checks one example. A `rule` checks a claim for all inputs, and the checker proves it. A rule runs under `term test` like any other test, but it cannot fail at runtime. It either type-checks or the build stops.

State the obligation with `show hold`, then discharge it.

```tree
form natural
  case zero
  case succ
    link prior, like natural

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

For a law over all inputs, bind the universal variable and prove by induction.

```tree
rule plus-zero-right
  mark a, like natural
  show hold
    call is-equal
      call plus
        read a
        call zero
      read a
  fold a
```

`mark a, like natural` quantifies over every natural. `fold a` proves it by structural induction: the `zero` case and the `succ` case, each discharged automatically. Chain a previously proven rule into a later one with `cite`.

## Where to put tests

Tests are plain `.tree` files. Keep them near the code they cover and name them by what they check. `term test` discovers them and runs each. Use unit tests (`case`, `want`, `deny`) for behavior on examples, and rules (`rule`, `show hold`) for laws that must hold everywhere.

See [math](../math/readme.md) for the full proof system: `calm`, `fold`, `cite`, and `auto`. See [debugging](debugging.md) for reading a failed assertion's diagnostic frame.
