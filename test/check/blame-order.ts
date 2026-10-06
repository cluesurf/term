// A MISMATCH IS BLAMED ON THE LATER USE IN THE FILE, whichever was checked first (decisions-2026-10.md, D10).
// A parameter with no `like` is decided by its first use, and checking order is not source order: a top-level `host`
// is typed before every task. So `label(1)` inside a task on line 7 was blamed for disagreeing with `label(<one>)` in a
// `host` on line 10, three lines below it. check/expect.tree `turn-around` places the report at the later use and marks
// the earlier one as the use that decided, which is what checking in source order reports. Held both ways: the same
// program with the two uses swapped blames the same line, the later one.
// Run: sh tmp/run-term-ts.sh test/check/blame-order.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const LABEL = `task label
  take value

  like text

  back <seen>
`

// the task's use first in the file, the host's below it (and typed first)
const taskFirst = `${LABEL}
task use
  like void

  save a, label(1)

host b, label(<one>)
`

// the host's use first in the file, the task's below it
const hostFirst = `${LABEL}
host b, label(<one>)

task use
  like void

  save a, label(1)
`

const mismatch = (text: string) => {
  const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), env: 'node' })
  const found = built.ok ? [] : built.diagnostics.filter(d => d.name === 'type-mismatch')

  return { found, said: built.ok ? 'it built' : built.diagnostics.map(d => `${d.span.start.line + 1}: ${d.message}`).join(' | ') }
}

const lineOf = (text: string, needle: string): number => text.split('\n').findIndex(line => line.includes(needle))

{
  const { found, said } = mismatch(taskFirst)
  const first = found[0]
  const later = lineOf(taskFirst, 'host b')
  const earlier = lineOf(taskFirst, 'save a')

  ok('one mismatch', found.length === 1, said)
  ok('the host checked first but written later is blamed', first?.span.start.line === later, said)
  ok('saying what the earlier use made it', first?.message === 'argument: expected number, found text', said)
  ok(
    'and marking the earlier use as the one that decided',
    first?.markers.some(m => m.span.start.line === earlier && m.label === 'first used as number here') === true,
    JSON.stringify(first?.markers.map(m => [m.span.start.line, m.label])),
  )
}

{
  const { found, said } = mismatch(hostFirst)
  const first = found[0]
  const later = lineOf(hostFirst, 'save a')
  const earlier = lineOf(hostFirst, 'host b')

  ok('swapped: the later use is still the one blamed', first?.span.start.line === later, said)
  ok('swapped: saying what the earlier use made it', first?.message === 'argument: expected text, found number', said)
  ok(
    'swapped: marking the earlier use',
    first?.markers.some(m => m.span.start.line === earlier && m.label === 'first used as text here') === true,
    JSON.stringify(first?.markers.map(m => [m.span.start.line, m.label])),
  )
}

console.log(`\nblame-order: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
