// A write to a list or hash PARAMETER that its caller never sees under value semantics (self-hosting-0026, D1). Every
// backend shares the caller's collection today, so each of these works now and silently stops working the day a list
// is a value. check/lost-writes.ts `warnLostCollectionWrites` names them, as a warning until the corpus is clean.
// Run: npx tsx test/check/collection-writes.ts

import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

const resolve = projectResolver(process.cwd(), 'node')

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

// the lost-write warnings a program raises, by the task each names
function warned(text: string): string[] | string {
  const result = compile({ file: '/gate/code/writes.tree', text }, { resolve, leanOf: () => true })

  if (!result.ok) {
    return result.diagnostics.map(d => d.message).join(' | ')
  }

  return result.warnings
    .filter(d => /sends nothing back: under value semantics/.test(d.message))
    .map(d => /a collection `([^`]+)`/.exec(d.message)?.[1] ?? '?')
    .sort()
}

const LIST = 'load @term/base/list\n  find push\n\n'

const cases: [string, string, string[]][] = [
  ['a native push onto a list parameter', 'task fill\n  take xs, like list, like number\n  xs/push(1)\n', ['fill']],
  ['the stdlib push, a task that writes its first argument', `${LIST}task fill\n  take xs, like list, like number\n  push(xs, 1)\n`, ['fill']],
  ['a hash parameter set', 'task note\n  take seen, like hash, like text, like number\n  seen/set(<a>, 1)\n', ['note']],
  ['a write two calls down: both tasks are named', 'task inner\n  take xs, like list, like number\n  xs/push(1)\n\ntask outer\n  take ys, like list, like number\n  inner(ys)\n', ['inner', 'outer']],
  ['a task that sends the list back is left alone', 'task fill\n  take xs, like list, like number\n  like list, like number\n  xs/push(1)\n  back xs\n', []],
  ['a copy read after the write is in use, and left alone', 'load @term/base/console\n  find log\n\ntask fill\n  take xs, like list, like number\n  xs/push(1)\n  log(<{xs/length}>)\n', []],
  ['a local list is its own, and left alone', 'task fill\n  take n, like number\n  save xs, make list\n  xs/push(n)\n', []],
  ['a list parameter only read is left alone', 'load @term/base/console\n  find log\n\ntask show\n  take xs, like list, like number\n  log(<{xs/length}>)\n', []],
]

for (const [label, text, want] of cases) {
  const got = warned(text)
  ok(label, Array.isArray(got) && JSON.stringify(got) === JSON.stringify(want), typeof got === 'string' ? got : JSON.stringify(got))
}

console.log(`\ncollection-writes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
