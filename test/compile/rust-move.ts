// Move-on-last-use in the Rust backend (the linearity / Perceus insight): a variable read EXACTLY ONCE in a function,
// not inside a loop or closure, is MOVED at that use instead of cloned -- saving a deep `String` copy or an `Rc`
// refcount bump. A variable read more than once, or read inside a loop, is still cloned (the always-correct fallback).
// This checks the EMITTED Rust: a single-use argument has no `.clone()`, a multi-use one keeps it. The roundtrip suite
// proves rustc accepts the moves. Run: npx tsx test/compile/rust-move.ts

import { parse } from '@cluesurf/make/code/parser/tree'
import { mill } from '@cluesurf/make/code/compile/mill'
import { resolve } from '@cluesurf/make/code/check/resolve'
import { check } from '@cluesurf/make/code/check/infer'
import { emitRust } from '@cluesurf/make/code/compile/rust'
import type { Program } from '@cluesurf/make/code/compile/node'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function frontEnd(text: string): Program {
  const parsed = parse({ file: 'b.tree', text })

  if (!parsed.ok) {
    throw new Error('parse failed')
  }

  const built = mill(parsed.tree, 'b.tree')

  if (!built.ok) {
    throw new Error('mill failed')
  }

  resolve(built.program, 'b.tree')
  check(built.program, 'b.tree')

  return built.program
}

// `take-one` consumes a text; `join-two` consumes two. Used as the call targets below.
const PRELUDE = `task take-one
  take s, like text
  like text
  send back
    read s

task join-two
  take a, like text
  take b, like text
  like text
  send back
    call add
      read a
      read b
`

// 1. a SINGLE-use variable argument is MOVED (no clone): `x` is read once, so `take-one(x)`, not `take-one(x.clone())`.
const single = emitRust(
  frontEnd(`${PRELUDE}
task pass-through
  take x, like text
  like text
  send back
    call take-one
      read x
`),
)
ok(
  'single-use argument is moved (no clone)',
  single.includes('take_one(x)') && !single.includes('take_one(x.clone())'),
  single,
)

// 2. a TWICE-used variable argument keeps the clone (it must survive to the second use): `join-two(x.clone(), x.clone())`
// (or at least the first must clone; the analysis declines the whole variable when its read count is above one).
const twice = emitRust(
  frontEnd(`${PRELUDE}
task duplicate
  take x, like text
  like text
  send back
    call join-two
      read x
      read x
`),
)
ok(
  'twice-used argument keeps the clone',
  twice.includes('x.clone()'),
  twice,
)

// 3. a variable used once but INSIDE A LOOP keeps the clone (the use re-executes each iteration, so a move would fail on
// the second iteration). `x` is read once textually, but inside a `walk` loop body.
const loop = emitRust(
  frontEnd(`${PRELUDE}
task in-loop
  take x, like text
  like text
  save out, text <>
  save i, code 0
  walk test
    hook test
      call is-below
        loan i
        code 3
    hook hold
      save out
        call take-one
          read x
      save i
        call add
          loan i
          code 1
  send back
    read out
`),
)
ok(
  'single use inside a loop keeps the clone',
  loop.includes('take_one(x.clone())'),
  loop,
)

console.log(`\nrust-move: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
