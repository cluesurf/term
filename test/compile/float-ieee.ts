// FLOAT ARITHMETIC IS IEEE 754 BINARY64, ROUND TO NEAREST, TIES TO EVEN, ON EVERY BACKEND (decisions-2026-10.md, D3,
// guides: language/operators). Written down there and held here: each case compares a computed value with the
// correctly rounded binary64 answer by exact equality, so a backend that rounded differently, carried extra precision
// (x87's 80 bits) or read a literal differently answers `false` in that place. Two cases are exact ties, where only
// round-half-to-even gives the expected answer: 1 + 2^-53 is 1, and 1 + 3 * 2^-53 is 1 + 2^-51. `square-root` is
// correctly rounded by IEEE as `+` is; the other functions of @term/base/float are each platform's libm, which is
// decisions-2026-10.md, D6, and not held here.
// Run: sh tmp/run-term-ts.sh test/compile/float-ieee.ts   (FLOAT_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

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

const CASES: [string, string][] = [
  ['0.1 + 0.2', 'is-equal(add(0.1, 0.2), 0.30000000000000004)'],
  ['0.3 - 0.1', 'is-equal(subtract(0.3, 0.1), 0.19999999999999998)'],
  ['0.1 * 3', 'is-equal(multiply(0.1, 3.0), 0.30000000000000004)'],
  ['1 / 3', 'is-equal(divide(1.0, 3.0), 0.3333333333333333)'],
  ['the square root of 2', 'is-equal(square-root(2.0), 1.4142135623730951)'],
  ['1 + 2^-53, a tie, to even', 'is-equal(add(1.0, power(2.0, -53.0)), 1.0)'],
  ['1 + 3 * 2^-53, a tie, to even', 'is-equal(add(1.0, multiply(3.0, power(2.0, -53.0))), 1.0000000000000004)'],
]

const PROGRAM = `load @term/base/float
  find square-root
  find power

task run
  like text

${CASES.map(([, test], at) => `  save c${at}, ${test}`).join('\n')}
  back <${CASES.map((_, at) => `{c${at}}`).join(' ')}>
`

const EXPECTED = CASES.map(() => 'true').join(' ')

const dir = mkdtempSync(join(tmpdir(), 'term-float-ieee-'))
const only = process.env.FLOAT_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'ieee' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  const answers = ran.form === 'ran' ? ran.output.trim().split(' ') : []
  const wrong = CASES.filter((_, at) => answers[at] !== 'true').map(([name]) => name)

  ok(
    `${backend}: every case is the correctly rounded binary64 answer`,
    ran.form === 'ran' && ran.output.trim() === EXPECTED,
    ran.form === 'ran' ? `not: ${wrong.join(', ')}` : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nfloat-ieee: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
