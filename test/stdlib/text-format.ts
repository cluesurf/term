// Numbers and money by language (deck/base/code/text/format.tree, 2026-10-05), each platform's own formatter, held
// case by case to node's `Intl.NumberFormat`. The cases are the shapes that differ most between languages: grouping by
// threes and the Indian lakh, a comma for the decimal mark, a narrow space for grouping, a currency with no minor digits,
// Swiss grouping, and Arabic digits. A case where a platform's CLDR differs from node's is named, with both answers.
// Rust is refused at the load until its locale data is chosen (note/term/plan/decisions-2026-10.md, D7).
// Run: npx tsx test/stdlib/text-format.ts   (FORMAT_ONLY=typescript, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { runOn } from '../compile/shared/run-on'

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

type Case = { kind: 'number'; value: number; language: string; fewest: number; most: number } | { kind: 'currency'; value: number; currency: string; language: string }

const CASES: Case[] = [
  { kind: 'number', value: 1234567.891, language: 'en-US', fewest: 0, most: 2 },
  { kind: 'number', value: 1234567.891, language: 'de-DE', fewest: 0, most: 2 },
  { kind: 'number', value: 1234567.891, language: 'hi-IN', fewest: 2, most: 2 },
  { kind: 'number', value: 1234567.891, language: 'fr-FR', fewest: 1, most: 3 },
  { kind: 'number', value: 1234567.891, language: 'de-CH', fewest: 0, most: 1 },
  { kind: 'number', value: 0.125, language: 'en-US', fewest: 0, most: 2 },
  { kind: 'number', value: 1234.5, language: 'ar-EG', fewest: 0, most: 2 },
  { kind: 'currency', value: 1234.5, currency: 'USD', language: 'en-US' },
  { kind: 'currency', value: 1234.5, currency: 'EUR', language: 'de-DE' },
  { kind: 'currency', value: 1234.5, currency: 'EUR', language: 'fr-FR' },
  { kind: 'currency', value: 1234.5, currency: 'JPY', language: 'ja-JP' },
  { kind: 'currency', value: 1234.5, currency: 'INR', language: 'hi-IN' },
]

const decimal = (value: number): string => (Number.isInteger(value) ? `${value}.0` : String(value))

const PROGRAM = `load @term/base/text/format
  find format-number
  find format-currency

load @term/base/list
  find list
  find join

task run
  like text
  save out, make list
${CASES.map(one =>
  one.kind === 'number'
    ? `  push(out, format-number(${decimal(one.value)}, <${one.language}>, ${one.fewest}, ${one.most}))`
    : `  push(out, format-currency(${decimal(one.value)}, <${one.currency}>, <${one.language}>))`,
).join('\n')}
  back join(out, <|>)
`

const reference = CASES.map(one =>
  one.kind === 'number'
    ? new Intl.NumberFormat(one.language, { minimumFractionDigits: one.fewest, maximumFractionDigits: one.most, roundingMode: 'halfEven' } as Intl.NumberFormatOptions).format(one.value)
    : new Intl.NumberFormat(one.language, { style: 'currency', currency: one.currency, roundingMode: 'halfEven' } as Intl.NumberFormatOptions).format(one.value),
)

// Where a platform's formatter answers otherwise than node's, by case: each one known and named, never ignored in
// silence. A BASELINE: a new difference fails, and so does a known one that has gone, so the list cannot rot. These are
// what decision D7 is about (note/term/plan/decisions-2026-10.md): three copies of CLDR, three answers at the edges
const KNOWN: Record<string, Record<string, string>> = {
  swift: {
    'currency 1234.5 in ja-JP': "Apple's CLDR writes the yen sign U+00A5, node's the full-width U+FFE5",
  },
  kotlin: {
    'number 1234567.891 in hi-IN': "java.text.DecimalFormat groups by one size only, so it cannot write the Indian lakh (12,34,567); ICU4J can",
    'number 1234567.891 in de-CH': "the JDK's CLDR groups Swiss German with U+2019, node's with an apostrophe",
  },
}

const dir = mkdtempSync(join(tmpdir(), 'term-format-'))
const only = process.env.FORMAT_ONLY ?? ''

for (const backend of (['typescript', 'swift', 'kotlin'] as const).filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'format' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  const got = ran.form === 'ran' ? ran.output.split('|') : []
  const known = KNOWN[backend] ?? {}
  const label = (one: Case): string => `${one.kind} ${one.value} in ${one.language}`
  const differ = CASES.flatMap((one, at) =>
    got[at] === reference[at] || known[label(one)] ? [] : [`${label(one)}: got ${JSON.stringify(got[at])}, node ${JSON.stringify(reference[at])}`],
  )
  const gone = Object.keys(known).filter(name => {
    const at = CASES.findIndex(one => label(one) === name)

    return at >= 0 && got[at] === reference[at]
  })

  ok(`${backend}: numbers and money by language answer as node's Intl does, but for the differences known by case`, ran.form === 'ran' && differ.length === 0, ran.form === 'ran' ? differ.join(' | ') : `${ran.stage}: ${ran.reason}`)

  if (ran.form === 'ran') {
    ok(`${backend}: every known difference is still one`, gone.length === 0, `now answered as node does, so take it off KNOWN: ${gone.join(' | ')}`)
  }
}

// Rust: refused at the build, never formatted for the wrong locale
if (!only || only === 'rust') {
  const built = compile({ file: join(dir, 'rust.tree'), text: PROGRAM }, { resolve: projectResolver(process.cwd(), 'rust'), env: 'rust' })

  ok('rust: refused at the build, until its locale data is chosen', !built.ok, built.ok ? 'it compiled' : '')
}

console.log(`\ntext-format: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
