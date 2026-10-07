// COVERAGE PROBES (term/decisions-2026-10/coverage, D11, item 0001). `compile` with `cover: true` writes a `probe` before
// every executable statement of the entry file, keyed `<path relative to its folder>:<line>`. The emitted TypeScript adds
// each key to one process-wide set when its statement starts, so running the program and reading the set back gives
// exactly the lines that ran. The fixture has a fork (one arm never taken) and a loop.
//
// Held here: the key list is every executable statement's line and no declaration's, the hit keys are exactly the lines
// that ran (the untaken arm is the one missed), and a build without `cover` is byte-identical to a second one without it.
// Run: npx tsx test/compile/cover.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'

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

// `pick(1)` never reaches `back <big>`; `count(3)` runs the loop three times
const PROGRAM = `task pick
  take n, like number

  like text

  fork test, is-above(n, 3)
    hold
      back <big>
    miss
      back <small>

task count
  take limit, like number

  like number

  save total, 0
  save at, 0
  walk test
    hook test, is-below(at, limit)
    hook hold
      save total, add(total, at)
      save at, add(at, 1)
  back total

task run
  like text

  back <{pick(1)} {count(3)}>
`

// the statements that run a line each, found by their text so the test never counts lines by hand
const EXECUTABLE = [
  'fork test, is-above(n, 3)',
  'back <big>',
  'back <small>',
  'save total, 0',
  'save at, 0',
  'walk test',
  'save total, add(total, at)',
  'save at, add(at, 1)',
  'back total',
  'back <{pick(1)} {count(3)}>',
]

const dir = mkdtempSync(join(tmpdir(), 'term-cover-'))
const file = join(dir, 'cover-fixture.tree')
writeFileSync(file, PROGRAM)
const resolve = projectResolver(process.cwd(), 'node')

const lineOf = (text: string): number => PROGRAM.split('\n').findIndex(line => line.trim() === text) + 1
const keyOf = (text: string): string => `cover-fixture.tree:${lineOf(text)}`

for (const text of EXECUTABLE) {
  ok(`the fixture holds "${text}" once`, lineOf(text) > 0 && PROGRAM.split('\n').filter(line => line.trim() === text).length === 1)
}

const plain = compile({ file, text: PROGRAM }, { resolve, env: 'node' })
const covered = compile({ file, text: PROGRAM }, { resolve, env: 'node', cover: true })

if (!plain.ok || !covered.ok) {
  const bad = (plain.ok ? covered : plain) as { diagnostics?: { message: string }[] }
  console.log(`FAIL  compile  ${(bad.diagnostics ?? []).map(d => d.message).join(' | ')}`)
  process.exit(1)
}

ok('a build without cover carries no probe', !plain.typescript.includes('__termCoverHit') && plain.cover === undefined)
ok('a build with cover carries the probes and the set', covered.typescript.includes('__termCoverHit(') && covered.typescript.includes('__termCover'))

const again = compile({ file, text: PROGRAM }, { resolve, env: 'node' })
ok('a build without cover is byte-identical to the same build again', again.ok && again.typescript === plain.typescript)

const keys = [...(covered.cover ?? [])].sort()
const expected = EXECUTABLE.map(keyOf).sort()
ok('the key list is every executable statement and nothing else', JSON.stringify(keys) === JSON.stringify(expected), `${JSON.stringify(keys)} vs ${JSON.stringify(expected)}`)

// run the emitted TypeScript and read the set back
const prelude = nativePrelude(covered.program, 'node', () => undefined, covered.typescript)
const runner = join(dir, 'cover-fixture-run.ts')
writeFileSync(
  runner,
  `${prelude}\n${covered.typescript}\nPromise.resolve(run()).then(text => process.stdout.write(JSON.stringify({ text, hit: [...((globalThis as any).__termCover ?? [])] })))\n`,
)
const run = spawnSync(process.execPath, ['--import', 'tsx', runner], { encoding: 'utf8' })

if (run.status !== 0) {
  console.log(`FAIL  run  ${String(run.stderr).slice(0, 800)}`)
  process.exit(1)
}

const answer = JSON.parse(String(run.stdout)) as { text: string; hit: string[] }
const hit = [...answer.hit].sort()
const wanted = EXECUTABLE.filter(text => text !== 'back <big>').map(keyOf).sort()

ok('the program still answers what it answered', answer.text === 'small 3', answer.text)
ok('the hit keys are exactly the lines that ran', JSON.stringify(hit) === JSON.stringify(wanted), `${JSON.stringify(hit)} vs ${JSON.stringify(wanted)}`)
ok('the untaken arm is the one missed', keys.filter(key => !hit.includes(key)).join() === keyOf('back <big>'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
