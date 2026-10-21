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
import { judgeState } from '@term/make/code/check/judge'

// the kernel's transparent definitions after the last report
const definitions = (): Map<string, unknown> => (judgeState() as unknown as { definition: Map<string, unknown> }).definition

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

// a counted walk over a list, its index read
const LIST_SUM = `task sum-at
  take xs, like list, like number
  like number
  save total, code 0
  walk list, read xs
    hook next
      take x
      take i
      save total
        call add
          read total
          call multiply
            read x
            read i
  send back total
`

// `turn next`, `halt` and a `send back` inside the walk, each in a case of its own
const LIST_EXITS = `task first-big
  take xs, like list, like number
  like number
  save seen, code 0
  walk list, read xs
    hook next
      take x
      fork test
        hook test
          call is-below
            read x
            code 0
        hook hold
          turn next
      fork test
        hook test
          call is-above
            read x
            code 100
        hook hold
          send back x
      fork test
        hook test
          call is-above
            read seen
            code 9
        hook hold
          halt
      save seen
        call add
          read seen
          code 1
  send back seen
`

// a walk last in an arm: its end joins the fork's
const LIST_IN_ARM = `task count-if
  take xs, like list, like number
  take on, like boolean
  like number
  save n, code 0
  fork test
    hook test
      read on
    hook hold
      walk list, read xs
        hook next
          take x
          save n
            call add
              read n
              code 1
  send back n
`

const SIZE = `task triangle
  take n, like number
  like number
  save total, code 0
  walk size
    bind base, code 0
    bind head, read n
    hook next
      take k
      save total
        call add
          read total
          read k
  send back total
`

const DOWN = `task halve
  take n, like number
  like number
  save m, read n
  walk test
    down m
    hook test
      call is-above
        read m
        code 0
    hook hold
      save m
        call subtract
          read m
          code 1
  send back m
`

// nested walks, the inner one leaving the outer turn by name
const NESTED_WALKS = `task pairs
  take xs, like list, like number
  like number
  save c, code 0
  walk list
    read xs
    name outer
    hook next
      take x
      walk list, read xs
        hook next
          take y
          fork test
            hook test
              call is-equal
                read x
                read y
            hook hold
              turn next, name outer
          save c
            call add
              read c
              code 1
  send back c
`

const OVER_HASH = `task keys
  take h, like text
  like number
  save n, code 0
  walk list, read h
    hook next
      take v
      save n
        call add
          read n
          code 1
  send back n
`

// proof-by-default-0011: a guarded fork whose handler takes the raise
const GUARDED = `task cap
  take n, like number
  like number
  save m, read n
  fork
    mark unsafe
    fork test
      hook test
        call is-above
          read n
          code 10
      hook hold
        halt <Too big>
    save m
      call add
        read n
        code 1
  halt take
    take problem
    save m, code 10
  send back m
`

// a raise inside a walk inside the guarded fork reaches the handler too
const GUARDED_WALK = `task first-negative
  take xs, like list, like number
  like number
  save at, code 0
  fork
    mark unsafe
    walk list, read xs
      hook next
        take x
        fork test
          hook test
            call is-below
              read x
              code 0
          hook hold
            halt <Found>
        save at
          call add
            read at
            code 1
    save at, code -1
  halt take
    take problem
    send back at
  send back at
`

const READS_RAISE = `task why
  take n, like number
  like text
  fork
    mark unsafe
    halt <No>
  halt take
    take problem
    send back problem/note
  send back <yes>
`

const RAISING_CALL = `task risky
  take n, like number
  like number
  fork test
    hook test
      call is-above
        read n
        code 10
    hook hold
      halt <Too big>
  send back n

task safe
  take n, like number
  like number
  save m, read n
  fork
    mark unsafe
    save m
      call risky
        read n
  halt take
    take problem
    save m, code 0
  send back m
`

const ESCAPES = `task loud
  take n, like number
  like number
  fork test
    hook test
      call is-above
        read n
        code 10
    hook hold
      halt <Too big>
  send back n
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
  // proof-by-default-0010: every walk is one term
  proven('a walk test is one term, lifted to a task of its own', LOOP, 'sum-below')
  proven('a counted walk over a list, its index read, is one term', LIST_SUM, 'sum-at')
  proven('turn next, halt and send back inside a walk, each a case of its own', LIST_EXITS, 'first-big')
  proven('a walk last in an arm joins the arm', LIST_IN_ARM, 'count-if')
  proven('walk size is one term', SIZE, 'triangle')
  proven('a walk test with a down is one term', DOWN, 'halve')
  proven('turn next out of a nested walk, by name', NESTED_WALKS, 'pairs')
  // a turn's body is the kernel's to check, in a fold and in a lifted walk test alike
  for (const [what, walk] of [
    ['a walk over a list', 'walk list, read xs\n    hook next\n      take x'],
    ['a walk test', 'walk test\n    hook test\n      call is-below\n        read total\n        code 3\n    hook hold'],
  ] as const) {
    const bad = report(`task wrong-turn
  take xs, like list, like number
  like number
  save total, code 0
  ${walk}
      save total, true
  send back total
`)
    ok(
      `the kernel refuses a save of the wrong type inside ${what}`,
      !bad.proven.includes('wrong-turn') && bad.diagnostics.some(d => d.message.startsWith('kernel:')),
      JSON.stringify({ proven: bad.proven, statementwise: bad.statementwise, diagnostics: bad.diagnostics.map(d => d.message) }),
    )
  }

  const overText = report(OVER_HASH)
  ok('a walk over a text is no fold, and is not proven', !overText.proven.includes('keys'), JSON.stringify(overText.declined))

  // a lifted walk test is a definition the kernel unfolds only with a `down`, and opaque without one
  report(DOWN)
  ok('a walk test with a down is a definition', definitions().has('halve__walk0'), [...definitions().keys()].join(', '))
  report(LOOP)
  ok(
    'one without is an opaque constant: nothing is computed through a loop not shown to end',
    !definitions().has('sum-below__walk0') && definitions().has('sum-below'),
    [...definitions().keys()].join(', '),
  )
  // proof-by-default-0011: a guarded fork is one term, its raise a call of the handler
  proven('a guarded fork and its handler are one term', GUARDED, 'cap')
  proven('a raise inside a walk inside the guarded fork', GUARDED_WALK, 'first-negative')
  const reads = report(READS_RAISE)
  // neither is one term: the statement-by-statement checker then declines the guarded fork with its own reason
  const notOneTerm = (name: string, r: ElaborationReport, task: string): void =>
    ok(
      name,
      !r.proven.includes(task) && [...r.statementwise, ...r.declined].some(one => one.name === task),
      JSON.stringify({ statementwise: r.statementwise, declined: r.declined }),
    )
  notOneTerm('a handler that reads what was raised is not one term', reads, 'why')
  notOneTerm('a call that may raise inside a guarded fork is not one term', report(RAISING_CALL), 'safe')
  statementwise('a raise that leaves the task is not lowered, and says so', ESCAPES, 'loud', 'a raise')
  statementwise('a path that ends without a return is named', FALLS_OFF, 'falls', 'a path that ends without a return')

  console.log(`\nlowering: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main()
