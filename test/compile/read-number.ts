// The stdlib's text-to-number read (native-dom-0040): `read-number` from @term/base/code/text/number, run as compiled
// TypeScript, its answers judged against the grammar it states. A number, or none for text that is not one.
// Run: npx tsx test/compile/read-number.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
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

// text -> what read-number must answer: a number, or null for none
const CASES: [string, number | null][] = [
  ['42', 42],
  ['0', 0],
  ['-7', -7],
  ['3.25', 3.25],
  ['-0.5', -0.5],
  ['.5', 0.5],
  ['5.', 5],
  ['1000000', 1000000],
  ['', null],
  ['-', null],
  ['.', null],
  ['abc', null],
  ['4a', null],
  [' 4', null],
  ['1.2.3', null],
  ['4-', null],
  ['--4', null],
]

const PROGRAM = `load @term/base/code/text/number
  find read-number

load @term/base/code/maybe
  find maybe

task shown
  take value, like text
  like text
  save read, call read-number(read value)
  fork case, read read
    case some
      link number
      send back, text <{{number}}>
    case none
      send back, text <none>
`

const ROOT = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-read-number-'))
const entry = join(dir, 'read.tree')
writeFileSync(entry, PROGRAM)
const result = compile({ file: entry, text: PROGRAM }, { resolve: projectResolver(ROOT, 'node'), env: 'node' })
ok('read-number compiles', result.ok, result.ok ? '' : result.diagnostics.slice(0, 3).map(d => `${d.file}:${(d.span?.start.line ?? 0) + 1} ${d.message}`).join(' | '))

if (result.ok) {
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const prelude = nativePrelude(result.program, 'node', readRuntime, result.typescript)
  const file = join(dir, 'read.ts')
  const harness = `\nfor (const text of ${JSON.stringify(CASES.map(([text]) => text))}) console.log(JSON.stringify(shown(text)))\n`
  writeFileSync(file, `${prelude}\n${result.typescript}\n${harness}`)
  const run = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  const lines = run.stdout.trim().split('\n').map(line => JSON.parse(line) as string)
  ok('it runs', run.status === 0, run.stderr.slice(0, 400))

  CASES.forEach(([text, want], i) => {
    const got = lines[i]
    const expected = want === null ? 'none' : String(want)
    ok(`${JSON.stringify(text)} reads ${expected}`, got === expected, String(got))
  })
}

console.log(`\nread-number: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
