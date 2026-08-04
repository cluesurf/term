// Effect checking: the async / await discipline. Run: npx tsx test/check/effects.ts

import { compile } from '@term/make/code/compile/compile'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { effectRows } from '@term/make/code/check/effects'

let pass = 0
let fail = 0

function expectOk(name: string, source: string): void {
  const result = compile({ file: 'e.tree', text: source })

  if (result.ok) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (${result.diagnostics
        .map(d => d.name)
        .join(',')})`,
    )
  }
}

function expectEffectError(name: string, source: string): void {
  const result = compile({ file: 'e.tree', text: source })

  if (
    !result.ok &&
    result.diagnostics.some(d => d.name === 'effect-error')
  ) {
    pass++
    console.log(
      `ok    ${name}  (${
        result.diagnostics.find(d => d.name === 'effect-error')!.message
      })`,
    )
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, codes=${
        result.ok ? '' : result.diagnostics.map(d => d.name).join(',')
      })`,
    )
  }
}

const FETCH = `task fetch
  wait true
  send back, code 42
`

function main(): void {
  // correct: an async task awaits another async task
  expectOk(
    'async task awaited from an async task',
    `${FETCH}
task run
  wait true
  send back
    call fetch
      wait true
`,
  )

  // a task that awaits is INFERRED async (no task-level marker needed) -- async resolution makes it async
  expectOk(
    'a task that awaits is inferred async',
    `${FETCH}
task run
  send back
    call fetch
      wait true
`,
  )

  // awaiting a synchronous task
  expectEffectError(
    'awaiting a non-async task is rejected',
    `task plain
  send back, code 42

task run
  wait true
  send back
    call plain
      wait true
`,
  )

  // an async call with no `wait true` is AUTO-AWAITED by inference (the caller becomes async), so it is not an error
  expectOk(
    'an unawaited async call is auto-awaited (inference)',
    `${FETCH}
task run
  send back
    call fetch
`,
  )

  // fire-and-forget: an async call marked `wait false` is intentionally not awaited and the caller stays synchronous
  expectOk(
    'a `wait false` async call is allowed (fire-and-forget)',
    `${FETCH}
task run
  send back
    code 0

task kick
  call fetch
    wait false
  send back
    code 0
`,
  )

  // effect annotations on callbacks: an async callback parameter must be awaited (effect-row polymorphism --
  // the caller inherits the callback's async effect)
  const ASYNC_CB = (
    callerAsync: boolean,
    await_: boolean,
  ): string => `task run-cb
  take f
    like task
      wait true
      take x, like number
      like number
  take n, like number
  like number${callerAsync ? '\n  wait true' : ''}
  send back
    call f
      loan n${await_ ? '\n      wait true' : ''}
`

  expectOk(
    'async callback awaited inside an async task',
    ASYNC_CB(true, true),
  )
  expectEffectError(
    'async callback not awaited is rejected',
    ASYNC_CB(false, false),
  )
  expectEffectError(
    'awaiting a sync callback is rejected',
    `task run-cb
  take f
    like task
      take x, like number
      like number
  take n, like number
  like number
  wait true
  send back
    call f
      loan n
      wait true
`,
  )

  // effect-row inference: throw propagates transitively through the call graph
  const THROW = `task boom
  take n
  bust n

task relay
  take n
  send back
    call boom
      loan n

task quiet
  take n
  send back
    call add
      loan n
      code 1
`

  const parsed = parse({ file: 'e.tree', text: THROW })
  const built = parsed.ok
    ? mill(parsed.tree, 'e.tree')
    : { ok: false as const, diagnostics: [] }

  if (built.ok) {
    const rows = effectRows(built.program)

    const ok2 = (name: string, cond: boolean): void => {
      if (cond) {
        pass++
        console.log(`ok    ${name}`)
      } else {
        fail++
        console.log(`FAIL  ${name}`)
      }
    }

    ok2(
      'a function that busts has the throw effect',
      rows.get('boom')?.has('throw') === true,
    )
    ok2(
      'throw propagates to a caller (transitive row)',
      rows.get('relay')?.has('throw') === true,
    )
    ok2(
      'a non-throwing function has no throw effect',
      rows.get('quiet')?.has('throw') !== true,
    )
  } else {
    fail++
    console.log('FAIL  effect-row program did not build')
  }

  // effect-row polymorphism: a function calling a throwing callback inherits the throw effect
  {
    const src = `task apply-it
  take f
    like task
      bust
      take x, like number
      like number
  take n, like number
  like number
  send back
    call f
      loan n
`

    const parsed2 = parse({ file: 'e.tree', text: src })
    const built2 = parsed2.ok
      ? mill(parsed2.tree, 'e.tree')
      : { ok: false as const, diagnostics: [] }

    if (built2.ok) {
      const rows = effectRows(built2.program)

      const ok2 = (name: string, cond: boolean): void => {
        if (cond) {
          pass++
          console.log(`ok    ${name}`)
        } else {
          fail++
          console.log(`FAIL  ${name}`)
        }
      }

      ok2(
        'a function calling a throwing callback inherits throw',
        rows.get('apply-it')?.has('throw') === true,
      )
    } else {
      fail++
      console.log('FAIL  callback-effect program did not build')
    }
  }

  console.log(`\neffects: ${pass} pass, ${fail} fail`)
}

main()
