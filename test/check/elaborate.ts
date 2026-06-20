// Elaboration tests: the surface language is lowered into the sound dependent kernel, and the KERNEL is the
// authority. These prove the bridge actually checks (the `verified` set), exercises the quantitative machinery
// (the erased polymorphic equality used by ==), and that the kernel independently catches type errors.
// Run: npx tsx test/check/elaborate.ts

import { parse } from '@/code/parser/tree'
import { expandTemplates } from '@/code/compile/template'
import { mill } from '@/code/compile/mill'
import { resolve } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { elaborateReport } from '@/code/check/elaborate'
import type { Program } from '@/code/compile/node'

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

// run the front-end (parse -> mill -> resolve -> infer) to get a typed program, then hand it to the kernel bridge.
// infer's own diagnostics are ignored here on purpose: we want to observe the KERNEL's independent verdict.
function frontEnd(text: string): Program {
  const parsed = parse({ file: 't.tree', text })
  if (!parsed.ok)
    throw new Error(
      'parse failed: ' +
        parsed.diagnostics.map(d => d.message).join('; '),
    )
  const built = mill(expandTemplates(parsed.tree), 't.tree')
  if (!built.ok)
    throw new Error(
      'mill failed: ' +
        built.diagnostics.map(d => d.message).join('; '),
    )
  resolve(built.program, 't.tree')
  check(built.program, 't.tree')
  return built.program
}

const RECURSIVE_FIB = `task fibonacci
  take n, like number
  like number
  fork test
    hook test
      call is-below
        loan n
        mark 2
    hook hold
      send back n
    hook miss
      send back
        call add
          call fibonacci
            call subtract
              loan n
              mark 1
          call fibonacci
            call subtract
              loan n
              mark 2
`

// two functions, one calling the other: the kernel must resolve the cross-function call type
const TWO_FUNCTIONS = `task double
  take x, like number
  like number
  send back
    call add
      loan x
      loan x

task quadruple
  take x, like number
  like number
  send back
    call double
      call double
        loan x
`

// uses == : the surface == elaborates to the erased polymorphic equality (a multiplicity-0 type argument). If the
// quantitative machinery were broken this would not check.
const USES_EQUALITY = `task same
  take a, like number
  take b, like number
  like boolean
  send back
    call is-equal
      loan a
      loan b
`

// declared result type (boolean) disagrees with the body (returns a number). The kernel must reject it.
const WRONG_RESULT = `task bad
  take n, like number
  like boolean
  send back n
`

// a wrong-typed argument: subtract wants numbers, gets a boolean. The kernel must reject it.
const WRONG_ARGUMENT = `task oops
  take flag, like boolean
  like number
  send back
    call subtract
      loan flag
      mark 1
`

// a generic identity function, and a caller that uses it at a concrete type. The kernel must give identity a
// polymorphic type and solve the type argument at the call by unification.
const GENERIC = `task identity
  head t
  take item, like t
  like t
  send back item

task use-identity
  take n, like number
  like number
  send back
    call identity
      loan n
`

// a generic function whose two parameters share the type, called with mismatched types. The kernel must reject:
// the first argument fixes the type variable, the second then disagrees.
const GENERIC_MISMATCH = `task pair-equal
  head t
  take a, like t
  take b, like t
  like boolean
  send back
    call is-equal
      loan a
      loan b

task bad-call
  take n, like number
  take flag, like boolean
  like boolean
  send back
    call pair-equal
      loan n
      loan flag
`

// mutation + a while loop: the effect layer must type the assignments and the loop condition through the kernel
const WHILE_LOOP = `task sum-below
  take n, like number
  like number
  save total, mark 0
  save i, mark 0
  walk test
    hook test
      call is-below
        loan i
        loan n
    hook step
      save total
        call add
          loan total
          loan i
      save i
        call add
          loan i
          mark 1
  send back total
`

// an array constructed locally, then a for-each over it: the element type must flow to the loop variable
const FOR_EACH = `task sum-pair
  take a, like number
  take b, like number
  like number
  save total, mark 0
  save items
    make list
      loan a
      loan b
  walk list, loan items
    hook next
      take site, name x
      save total
        call add
          loan total
          loan x
  send back total
`

// a match (fork case) on an enum, in an effectful body
const MATCH = `form light
  case red
  case green

task code-of
  take c, like light
  like number
  fork case, read c
    case red
      send back, mark 0
    case green
      send back, mark 1
`

// async with await: the awaited result is typed transparently, so a typed async caller verifies
const ASYNC = `task double-async
  take n, like number
  like number
  wait true
  send back
    call add
      loan n
      loan n

task use-async
  take n, like number
  like number
  wait true
  send back
    call double-async
      loan n
      wait true
`

// an effectful type error: assigning a boolean to a number-typed mutable variable. The kernel must catch it.
const BAD_ASSIGN = `task wrong-assign
  take n, like number
  like number
  save total, mark 0
  save total, wave true
  send back total
`

function main(): void {
  const fib = elaborateReport(frontEnd(RECURSIVE_FIB), 't.tree')
  ok(
    'recursive fibonacci is verified by the kernel',
    fib.verified.includes('fibonacci'),
    JSON.stringify(fib.verified),
  )
  ok(
    'recursive fibonacci has no kernel diagnostics',
    fib.diagnostics.length === 0,
    fib.diagnostics.map(d => d.message).join('; '),
  )

  const two = elaborateReport(frontEnd(TWO_FUNCTIONS), 't.tree')
  ok(
    'cross-function calls verify (both functions)',
    two.verified.includes('double') &&
      two.verified.includes('quadruple'),
    JSON.stringify(two.verified),
  )
  ok(
    'cross-function program has no kernel diagnostics',
    two.diagnostics.length === 0,
  )

  const eq = elaborateReport(frontEnd(USES_EQUALITY), 't.tree')
  ok(
    '== verifies via the erased polymorphic equality (QTT)',
    eq.verified.includes('same'),
    JSON.stringify(eq.verified),
  )
  ok(
    'equality program has no kernel diagnostics',
    eq.diagnostics.length === 0,
    eq.diagnostics.map(d => d.message).join('; '),
  )

  const wrongResult = elaborateReport(frontEnd(WRONG_RESULT), 't.tree')
  ok(
    'kernel catches a wrong result type',
    wrongResult.diagnostics.some(d => d.message.startsWith('kernel:')),
    JSON.stringify(wrongResult.diagnostics.map(d => d.message)),
  )
  ok(
    'the rejected function is not in the verified set',
    !wrongResult.verified.includes('bad'),
  )

  const wrongArgument = elaborateReport(
    frontEnd(WRONG_ARGUMENT),
    't.tree',
  )
  ok(
    'kernel catches a wrong argument type',
    wrongArgument.diagnostics.some(d =>
      d.message.startsWith('kernel:'),
    ),
    JSON.stringify(wrongArgument.diagnostics.map(d => d.message)),
  )

  const generic = elaborateReport(frontEnd(GENERIC), 't.tree')
  ok(
    'generic identity is verified by the kernel',
    generic.verified.includes('identity'),
    JSON.stringify(generic.verified),
  )
  ok(
    'generic call resolves the type argument by unification',
    generic.verified.includes('use-identity'),
    JSON.stringify(generic.verified),
  )
  ok(
    'generic program has no kernel diagnostics',
    generic.diagnostics.length === 0,
    generic.diagnostics.map(d => d.message).join('; '),
  )

  const genericMismatch = elaborateReport(
    frontEnd(GENERIC_MISMATCH),
    't.tree',
  )
  ok(
    'generic function over a shared type variable verifies',
    genericMismatch.verified.includes('pair-equal'),
    JSON.stringify(genericMismatch.verified),
  )
  ok(
    'kernel catches a mismatched generic call (type variable disagreement)',
    genericMismatch.diagnostics.some(d =>
      d.message.startsWith('kernel:'),
    ),
    JSON.stringify(genericMismatch.diagnostics.map(d => d.message)),
  )

  // ---- effect layer: mutation, loops, match ----
  const whileLoop = elaborateReport(frontEnd(WHILE_LOOP), 't.tree')
  ok(
    'effectful function with mutation + while loop is kernel-verified',
    whileLoop.verified.includes('sum-below'),
    JSON.stringify(whileLoop.verified),
  )
  ok(
    'while-loop program has no kernel diagnostics',
    whileLoop.diagnostics.length === 0,
    whileLoop.diagnostics.map(d => d.message).join('; '),
  )

  const forEach = elaborateReport(frontEnd(FOR_EACH), 't.tree')
  ok(
    'for-each over an array is kernel-verified (element type flows to the loop variable)',
    forEach.verified.includes('sum-pair'),
    JSON.stringify(forEach.verified),
  )
  ok(
    'for-each program has no kernel diagnostics',
    forEach.diagnostics.length === 0,
    forEach.diagnostics.map(d => d.message).join('; '),
  )

  const match = elaborateReport(frontEnd(MATCH), 't.tree')
  ok(
    'match on an enum is kernel-verified',
    match.verified.includes('code-of'),
    JSON.stringify(match.verified),
  )
  ok(
    'match program has no kernel diagnostics',
    match.diagnostics.length === 0,
    match.diagnostics.map(d => d.message).join('; '),
  )

  const badAssign = elaborateReport(frontEnd(BAD_ASSIGN), 't.tree')
  ok(
    'kernel catches an ill-typed assignment in an effectful body',
    badAssign.diagnostics.some(d => d.message.startsWith('kernel:')),
    JSON.stringify(badAssign.diagnostics.map(d => d.message)),
  )

  const async = elaborateReport(frontEnd(ASYNC), 't.tree')
  ok(
    'async function and awaiting caller are kernel-verified',
    async.verified.includes('double-async') &&
      async.verified.includes('use-async'),
    JSON.stringify(async.verified),
  )
  ok(
    'async program has no kernel diagnostics',
    async.diagnostics.length === 0,
    async.diagnostics.map(d => d.message).join('; '),
  )

  console.log(`\nelaborate: ${pass} pass, ${fail} fail`)
}

main()
