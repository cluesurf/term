// `case some` and `case none` test a maybe (term-self-host-001-0056, traps.md T038). A `sift` with them over a value
// that is never a maybe (a `need false` BOOLEAN, a number, a text, a list) was accepted until 2026-10-29 and took
// neither arm: TypeScript compared `false` with "some". Now it is refused at the sift, naming the type, and a sift over
// a real `need false` maybe still builds.
// Run: npx tsx test/check/maybe-case-refused.ts

import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

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

const messages = (text: string): string[] => {
  const built = compile({ file: '/gate/code/maybe-case.tree', text }, { resolve: projectResolver(process.cwd(), 'node'), env: 'node' })

  return built.ok ? [] : built.diagnostics.map(d => d.message)
}

const over = (field: string, read: string): string => `load @term/base/maybe
  find maybe

form opts
  link quiet
${field}

task loud
  take o, like opts
  like number
  sift ${read}
    case some
      back 1
    case none
      back 2
`

for (const [kind, field] of [
  ['boolean', '    like boolean\n    need false'],
  ['number', '    like number\n    need false'],
  ['string', '    like text'],
  ['list', '    like list, like text'],
] as const) {
  const said = messages(over(field, 'o/quiet'))

  ok(
    `a sift over a ${kind} with \`case some\` and \`case none\` is refused, naming the type`,
    said.some(m => m.includes('`case some` tests a maybe')) && said.some(m => m.includes('`case none` tests a maybe')),
    said.join(' | ') || 'it built',
  )
}

const maybe = messages(over('    like maybe, like boolean\n    need false', 'o/quiet'))

ok('a sift over a need-false maybe with the same arms still builds', maybe.length === 0, maybe.join(' | '))

console.log(`\nmaybe-case-refused: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
