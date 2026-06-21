/**
 * Cross-backend differential demo. Run:
 *   npx tsx deck/test/code/demo-cross.ts
 *
 * Emits several programs - including synthesized ones - to all four
 * backends and checks every backend agrees the program is well-formed
 * (emits non-empty code). A backend that diverges is a bug.
 */

import { crossEmit } from './cross'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const programs: { name: string; source: string }[] = [
  {
    name: 'arithmetic',
    source: `task triple\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      mark 3\n`,
  },
  {
    name: 'nested-arithmetic',
    source: `task affine\n  take n, like number\n  like number\n  send back\n    call add\n      call multiply\n        read n\n        mark 3\n      mark 1\n`,
  },
  {
    name: 'control-flow',
    source: `task pick\n  take a, like number\n  take b, like number\n  like number\n  fork test\n    hook test\n      call is-above\n        read a\n        read b\n    hook hold\n      send back, read a\n    hook miss\n      send back, read b\n`,
  },
]

for (const { name, source } of programs) {
  const result = crossEmit(source)
  const backends = Object.entries(result.emits)
    .map(([b, e]) => `${b}${e.ok ? '' : ':FAIL'}`)
    .join(' ')
  ok(`${name}: all backends emit`, result.ok,
    result.compiled ? `[${backends}]` : '(did not compile)')
  if (!result.ok && result.compiled) {
    for (const [b, e] of Object.entries(result.emits)) {
      if (!e.ok) console.log(`      ${b}: ${e.error ?? 'empty'}`)
    }
  }
}

console.log(`\nseed-verify cross demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
