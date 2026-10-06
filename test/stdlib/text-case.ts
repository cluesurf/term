// Casing by language (deck/base/code/text/case.tree, 2026-10-05) on every backend, held to node's own
// `toLocaleUpperCase` / `toLocaleLowerCase`, which follow Unicode's SpecialCasing: Turkish and Azerbaijani dotted and
// dotless i, Lithuanian's kept and dropped dot above, German's ß, a tag with a region, and a language with no rules.
// `to-upper-case` takes no language, so a Turkish `i` was upper-cased to `I` everywhere (guides: library/text).
// Run: npx tsx test/stdlib/text-case.ts   (CASE_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from '../compile/shared/run-on'

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

// [direction, text, language]. Written with escapes so the combining marks are visible here
const CASES: ['upper' | 'lower', string, string][] = [
  ['upper', 'istanbul', 'tr'],
  ['upper', 'istanbul', 'tr-TR'],
  ['upper', 'istanbul', 'en'],
  ['lower', 'IĞDIR', 'tr'],
  ['lower', 'İSTANBUL', 'tr'],
  ['lower', 'İ', 'tr'],
  ['lower', 'Ị̇', 'az'],
  ['lower', 'IĞDIR', 'en'],
  ['upper', 'i̇', 'lt'],
  ['upper', 'į̇', 'lt'],
  ['lower', 'Ì', 'lt'],
  ['lower', 'Ì', 'lt'],
  ['lower', 'Í', 'lt'],
  ['lower', 'Ĩ', 'lt'],
  ['lower', 'Į́', 'lt'],
  ['lower', 'J̃', 'lt'],
  ['upper', 'straße', 'de'],
  ['lower', 'ΟΔΟΣ', 'el'],
]

const literal = (text: string): string => [...text].map(c => (c === '<' || c === '>' || c === '{' || c === '}' || c === '\\' ? `\\${c}` : c)).join('')

const PROGRAM = `load @term/base/text/case
  find upper-case-in
  find lower-case-in

load @term/base/list
  find list
  find join

task run
  like text
  save out, make list
${CASES.map(([direction, text, language]) => `  push(out, ${direction}-case-in(<${literal(text)}>, <${language}>))`).join('\n')}
  back join(out, <|>)
`

const EXPECTED = CASES.map(([direction, text, language]) =>
  direction === 'upper' ? text.toLocaleUpperCase(language) : text.toLocaleLowerCase(language),
).join('|')

const dir = mkdtempSync(join(tmpdir(), 'term-case-'))
const only = process.env.CASE_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'case' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  const got = ran.form === 'ran' ? ran.output.split('|') : []
  const want = EXPECTED.split('|')
  const differ = CASES.flatMap((one, at) => (got[at] === want[at] ? [] : [`${one[0]} ${JSON.stringify(one[1])} in ${one[2]}: got ${JSON.stringify(got[at])}, node ${JSON.stringify(want[at])}`]))

  ok(
    `${backend}: casing by language answers as node does`,
    ran.form === 'ran' && differ.length === 0,
    ran.form === 'ran' ? differ.join(' | ') : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\ntext-case: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
