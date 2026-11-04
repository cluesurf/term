// lean-0011: port ONE REAL FILE to lean and measure it. The file is @term/base/code/range.tree, taken from
// the stdlib unchanged, and the lean version below is the same program with the `call` heads dropped and the
// arguments left where they were. Both are compiled through the same entry, with the flag off and on, and
// the emitted TypeScript is compared BYTE FOR BYTE.
//
// THE FILE IS NOT A FIXTURE. It is read off disk every run, so if somebody edits the stdlib module the
// long side changes with it and the comparison still means something. A difference is a failure.
//
//   pnpm term:lean-port

import { readFileSync } from 'node:fs'
import { compile } from '@term/make/code/compile/compile'
import { TERM_ROOT } from './root'

const AT =
  `${TERM_ROOT}/deck/base/code/range.tree`

const LONG = readFileSync(AT, 'utf8')

const LEAN = `# Numeric range: from start (inclusive) to end (exclusive) by step.

form range
  link start, like number
  link end, like number
  link step, like number

  task length
    take self
    like number
    back divide(subtract(read(self/end), read(self/start)), read(self/step))

  task contains
    take self
    take value, like number
    like boolean
    back and(is-minimum(read(value), read(self/start)), is-below(read(value), read(self/end)))

  task to-list
    take self
    like list
    save out, make list
    save at, read self/start
    walk test
      hook test, is-below(read(at), read(self/end))
      hook step
        out/push
          read at
        save at, add(read(at), read(self/step))
    back read out
`

function emit(text: string, lean: boolean): string {
  const out = compile(
    { file: '/gate/code/range.tree', text },
    { leanOf: () => lean },
  )

  return out.ok
    ? out.typescript
    : `DIAGNOSTICS: ${out.diagnostics.map(d => d.message).join(' | ')}`
}

const before = emit(LONG, false)
const after = emit(LEAN, true)

const lines = text => text.trimEnd().split('\n').length
const code = (text: string): number =>
  text
    .split('\n')
    .filter(one => one.trim() !== '' && !one.trim().startsWith('#')).length

console.log(`file        ${AT}`)
console.log(`long        ${lines(LONG)} lines, ${code(LONG)} of them code`)
console.log(`lean        ${lines(LEAN)} lines, ${code(LEAN)} of them code`)
console.log(
  `saved       ${code(LONG) - code(LEAN)} lines of code, ${(
    (100 * (code(LONG) - code(LEAN))) /
    code(LONG)
  ).toFixed(1)}%`,
)
console.log(`identical   ${before === after}`)

if (before !== after) {
  console.log('\n--- long ---')
  console.log(before)
  console.log('\n--- lean ---')
  console.log(after)
  process.exit(1)
}
