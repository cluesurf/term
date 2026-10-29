// The counted walk shares nothing (item term-self-host-001-0195, D011 rule 8, traps T049).
//
// compile/mint-bridge.ts lowers `walk size` to a `while`, and it once built the counter, the bound, the step and zero
// as one node each and stood that node at every place it wrote (the condition, the step's target, the step's value),
// and copied the step before each `continue` with structuredClone, which keeps the copy's own counter shared. On
// TypeScript that is one object at two places, natively two values, so an analysis keyed by node identity saw a
// different program per backend. Each program below is checked (`optimize: false`, the stage before the simplifier,
// which shares on purpose) and its places counted by `census` from task/term/shared-nodes.ts: none may stand twice.
//
//   npx tsx test/compile/walk-unshared.ts      (from deck/term/deck/term)

import { compile } from '@term/make/code/compile/compile'
import * as sharedNodes from '../../../../../../task/term/shared-nodes'

const census = ((sharedNodes as any).census ??
  (sharedNodes as any).default.census) as typeof sharedNodes.census

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

const SOURCES: Record<string, string> = {
  'a literal step': `task evens
  take n, like number
  like number
  save total, code 0
  walk size
    take i
    bind base, code 0
    bind head, read n
    bind step, code 2
    hook next
      save total
        call add
          read total
          read i
  send back, read total
`,
  'a negative literal step': `task down
  take n, like number
  like number
  save total, code 0
  walk size
    take i
    bind base, read n
    bind head, code 0
    bind step, code -1
    hook next
      save total
        call add
          read total
          read i
  send back, read total
`,
  'a variable step': `task by
  take n, like number
  take s, like number
  like number
  save count, code 0
  walk size
    bind base, code 0
    bind head, read n
    bind step, read s
    hook next
      save count
        call add
          read count
          code 1
  send back, read count
`,
  'a computed head and step': `task by-sum
  take n, like number
  take s, like number
  like number
  save count, code 0
  walk size
    bind base, code 0
    bind head
      call add
        read n
        code 1
    bind step
      call add
        read s
        code 0
    hook next
      save count
        call add
          read count
          code 1
  send back, read count
`,
  'turn next in a nested fork': `task skip-odd
  take n, like number
  like number
  save total, code 0
  walk size
    take i
    bind base, code 0
    bind head, read n
    hook next
      fork test
        hook test
          call is-equal
            call modulo
              read i
              code 2
            code 1
        hook hold
          turn next
      fork test
        hook test
          call is-equal
            read i
            code 4
        hook hold
          turn next
      save total
        call add
          read total
          read i
  send back, read total
`,
}

for (const [name, text] of Object.entries(SOURCES)) {
  const out = compile({ file: '/gate/code/walk.tree', text }, {
    optimize: false,
  } as never) as {
    ok: boolean
    program?: Record<string, any>[]
    diagnostics?: { message: string }[]
  }
  if (!out.ok || !out.program) {
    ok(
      `${name}: builds`,
      false,
      out.diagnostics?.map(d => d.message).join(' | ') ?? 'no program',
    )
    continue
  }
  const counted = census(out.program, false)
  // a census that counted nothing would pass vacuously: the walk's `while` must be among its places
  ok(
    `${name}: ${counted.places} places, ${counted.shared.size} shared`,
    counted.places > 10 && counted.shared.size === 0,
    `first at ${counted.firstShared?.root}`,
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
