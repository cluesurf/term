# Tests

A test in Term is ordinary code. You write a `.tree` file, build small test values with `case` and `check`, assert with the `want` family, and run them with `term test`. For laws that should hold for every input, you do not sample. You state a `rule` and let the type checker prove it. Both styles live in the same file and both run under one command.

Maps to: unit tests (assert on examples) and property tests / proofs (assert on all inputs).

## Cheatsheet

| Write | Means |
| --- | --- |
| `case name` | a test: a name plus an async work returning a boolean |
| `check name, got, expect` | a quick equality test built from two values |
| `want got, expect` | assert two values are equal (returns boolean) |
| `want-true got` | assert a boolean is true |
| `want-false got` | assert a boolean is false |
| `want-text got, part` | assert text `got` contains `part` |
| `deny got, expect` | assert two values differ |
| `want-over got, bound` | assert `got` is above `bound` |
| `want-under got, bound` | assert `got` is below `bound` |
| `call run, read tests` | run a list of tests, print results, return a tally |
| `rule name` | a proof: a law the checker discharges, run like a test |
| `show hold` | state the obligation a rule must satisfy |
| `calm hold` | settle the obligation by computation (reflexivity) |
| `fold x` | prove by structural induction over `x` |
| `cite lemma` | use an already-proven rule |

Import the test library:

```tree
load @cluesurf/base/code/test
  find case
  find check
  find want
  find want-true
  find want-text
  find run
```

Run everything:

```bash
term test            # run every test
term test parser     # only tests whose name contains "parser"
```

## A quick example test

`check` is the convenience form: a name and the two values to compare. It captures both now and compares them when run.

```tree
load @cluesurf/base/code/math
  find add

task test-add
  like test
  send back
    call check
      text <add two and three>
      call add, mark 2, mark 3
      mark 5
```

`call check` returns a `test` meta object. The first argument is the name, the second is the value you got, the third is what you expect.

## A test with setup

When a test needs steps before the assertion, use `case` with a closure. The work is an async task returning a boolean. End it with a `want` call.

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
          mark 42
        send back
          call want
            call items/size
            mark 1
```

`case` takes the name and the work. The work builds a list, pushes to it, and asserts the size is one with `want`. The work returns the boolean that `want` produced.

## The assertion family

Every `want` returns a boolean, so a work ends by sending one back. Pick the one that reads clearly.

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
        save a, call want, mark 4, mark 4
        save b, call deny, mark 4, mark 5
        # booleans
        save c, call want-true, wave true
        save d, call want-false, wave false
        # text containment
        save e, call want-text, text <hello world>, text <world>
        # ordered bounds
        save f, call want-over, mark 10, mark 3
        save g, call want-under, mark 3, mark 10
        send back
          read a
```

`want` and `deny` compare values. `want-true` and `want-false` check a boolean. `want-text` checks containment. `want-over` and `want-under` check strict bounds. Each returns whether it held.

## Running a suite

Collect tests into a list and hand it to `run`. It executes each, prints the result, and returns a tally of passes and failures.

```tree
load @cluesurf/base/code/test
  find run

task main
  note async
  like number
  save tests
    make list
  call tests/push
    call test-add
  call tests/push
    call test-list-push
  save tally
    call run
      read tests
      wait true
  send back, mark 0
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
  head a, like natural
  show hold
    call is-equal
      call plus
        read a
        call zero
      read a
  fold a
```

`head a, like natural` quantifies over every natural. `fold a` proves it by structural induction: the `zero` case and the `succ` case, each discharged automatically. Chain a previously proven rule into a later one with `cite`.

## Where to put tests

Tests are plain `.tree` files. Keep them near the code they cover and name them by what they check. `term test` discovers them and runs each. Use unit tests (`case`, `check`) for behavior on examples, and rules (`rule`, `show hold`) for laws that must hold everywhere.

See [math](../math/readme.md) for the full proof system: `calm`, `fold`, `cite`, and `auto`. See [debugging](debugging.md) for reading a failed assertion's diagnostic frame.
