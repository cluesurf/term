// The pure lowering (proof-by-default-0009): an imperative body whose names are saved again, or saved in the arms of a
// fork that falls through, is ONE kernel term (every save a new binder, every join a local task over the names the
// arms saved), and a body that cannot be lowered is checked statement by statement WITH ITS REASON, never in silence.
// The values these terms compute are held in test/check/soundness.ts (`lowering`). Run: npx tsx test/check/lowering.ts

import { parse } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { resolve } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { elaborateReport } from '@term/make/code/check/elaborate'
import type { ElaborationReport } from '@term/make/code/check/elaborate'

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

// the kernel's own verdict, the surface checker's diagnostics set aside
function report(text: string): ElaborationReport {
  const parsed = parse({ file: 't.tree', text })

  if (!parsed.ok) {
    throw new Error(parsed.diagnostics.map(d => d.message).join('; '))
  }

  const built = mill(expandTemplates(parsed.tree), 't.tree')

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join('; '))
  }

  resolve(built.program, 't.tree')
  check(built.program, 't.tree')

  return elaborateReport(built.program, 't.tree')
}

function proven(name: string, text: string, task: string): void {
  const r = report(text)

  ok(
    name,
    r.proven.includes(task) && r.diagnostics.length === 0,
    JSON.stringify({ proven: r.proven, statementwise: r.statementwise, diagnostics: r.diagnostics.map(d => d.message) }),
  )
}

function statementwise(name: string, text: string, task: string, reason: string): void {
  const r = report(text)
  const found = r.statementwise.find(one => one.name === task)

  ok(
    name,
    !r.proven.includes(task) && r.verified.includes(task) && found?.reason === reason,
    JSON.stringify({ proven: r.proven, statementwise: r.statementwise, declined: r.declined }),
  )
}

const CLAMP = `task clamp
  take n, like number
  like number
  save m, read n
  fork test
    hook test
      call is-above
        read m
        code 3
    hook hold
      save m, code 3
  send back m
`

const NESTED = `task bucket
  take n, like number
  like number
  save b, code 0
  fork test
    hook test
      call is-above
        read n
        code 10
    hook hold
      save b, code 1
      fork test
        hook test
          call is-above
            read n
            code 100
        hook hold
          save b, code 2
    hook miss
      save b
        call add
          read b
          read n
  save b
    call add
      read b
      code 1
  send back b
`

// one arm returns, the other falls through to the join
const EARLY = `task early
  take n, like number
  like number
  save m, read n
  fork test
    hook test
      call is-below
        read n
        code 0
    hook hold
      send back, code 0
    hook miss
      save m, code 1
  send back m
`

const SAVED_TWICE = `task twice
  take n, like number
  like number
  save x, read n
  save x
    call add
      read x
      code 1
  save x
    call multiply
      read x
      read x
  send back x
`

// an ill-typed save is the kernel's to refuse, as the command checker refused it
const BAD_SAVE = `task wrong
  take n, like number
  like number
  save total, code 0
  save total, true
  send back total
`

const BAD_SAVE_IN_ARM = `task wrong-arm
  take n, like number
  like number
  save total, code 0
  fork test
    hook test
      call is-above
        read n
        code 0
    hook hold
      save total, true
  send back total
`

const CLOSURE = `task late
  take n, like number
  like number
  save x, read n
  host f
    task g
      like number
      send back, read x
  save x
    call add
      read n
      code 1
  send back
    call f
`

const LOOP = `task sum-below
  take n, like number
  like number
  save total, code 0
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      save total
        call add
          read total
          read i
      save i
        call add
          read i
          code 1
  send back total
`

const FALLS_OFF = `task falls
  take n, like number
  like number
  save m, read n
  fork test
    hook test
      call is-above
        read m
        code 3
    hook hold
      send back m
`

function main(): void {
  proven('a fork test whose arm saves is one term', CLAMP, 'clamp')
  proven('a fork inside an arm, a miss arm, and a save after the join', NESTED, 'bucket')
  proven('an arm that returns beside an arm that falls through', EARLY, 'early')
  proven('a name saved three times is three binders', SAVED_TWICE, 'twice')

  const bad = report(BAD_SAVE)
  ok(
    'the kernel refuses a save of the wrong type',
    bad.diagnostics.some(d => d.message.startsWith('kernel:')) && !bad.proven.includes('wrong'),
    JSON.stringify(bad.diagnostics.map(d => d.message)),
  )

  const badArm = report(BAD_SAVE_IN_ARM)
  ok(
    'and one inside an arm',
    badArm.diagnostics.some(d => d.message.startsWith('kernel:')) && !badArm.proven.includes('wrong-arm'),
    JSON.stringify(badArm.diagnostics.map(d => d.message)),
  )

  statementwise('a save to a name a closure reads is not lowered, and says so', CLOSURE, 'late', 'a save to a name a closure reads')
  statementwise('a walk is checked statement by statement, and says so', LOOP, 'sum-below', 'a walk test')
  statementwise('a path that ends without a return is named', FALLS_OFF, 'falls', 'a path that ends without a return')

  console.log(`\nlowering: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main()
