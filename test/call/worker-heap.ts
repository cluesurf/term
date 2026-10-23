// A build worker that runs out of memory fails only its own unit (note/project/term/compiler/decision/005-prover-
// memory-bounded-by-problem.md, part 2). A 16-file project, the size at which `term make` builds its units across the
// worker pool, with one file far bigger than the rest, built with each worker's heap held to TERM_WORKER_HEAP_MB:
// that file is reported `out-of-memory`, the other 15 build, and the process ends on its own with a non-zero exit
// (never 134, V8's fatal heap death, which is what the main thread compiling the unit again gave).
//
// Run: npx tsx test/call/worker-heap.ts (after `pnpm run make:line`)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
// TERM_LINE points at another bundle, so a change can be tried without replacing the CLI a running gate uses
const LINE = process.env.TERM_LINE ?? join(HERE, '../../host/line.js')
// small enough that the big file's compile cannot fit, big enough for a small file's
const HEAP_MB = process.env.WORKER_HEAP_TEST_MB ?? '256'
// tasks in the big file: its parse and check grow with it, far past HEAP_MB
const BIG_TASKS = Number(process.env.WORKER_HEAP_TEST_TASKS ?? '40000')

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail.slice(0, 4000)}` : ''}`)
  }
}

function task(name: string, value: number): string {
  return `task ${name}\n  like number\n  send back\n    call add\n      code ${value}\n      code 1\n\n`
}

const project = mkdtempSync(join(tmpdir(), 'term-worker-heap-'))
mkdirSync(join(project, 'code'))
writeFileSync(join(project, 'deck.tree'), 'deck @probe/heap\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')

for (let i = 0; i < 15; i++) {
  writeFileSync(join(project, 'code', `small-${i}.tree`), task(`small-${i}`, i))
}

const big: string[] = []

for (let i = 0; i < BIG_TASKS; i++) {
  big.push(task(`big-${i}`, i))
}

writeFileSync(join(project, 'code', 'big.tree'), big.join(''))

const run = spawnSync('node', [LINE, 'make'], {
  cwd: project,
  encoding: 'utf8',
  timeout: 900_000,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, NO_COLOR: '1', TERM_WORKER_HEAP_MB: HEAP_MB },
})
const out = `${run.stdout}${run.stderr}`

ok('the build ends on its own (no signal, no timeout)', run.signal === null && run.status !== null, `signal ${run.signal}`)
ok('the build exits non-zero', run.status !== 0 && run.status !== null, `status ${run.status}`)
ok('the build never dies of a fatal heap (exit 134)', run.status !== 134, out)
ok('the units were built across the worker pool', /units in parallel/.test(out), out)

const reported = out.match(/out-of-memory/g) ?? []
const named = out.split('\n').filter(line => /out-of-memory/.test(line) || /ran out of memory/.test(line))

ok('the big file is reported out of memory', /big\.tree/.test(named.join('\n')) || /big\.tree[\s\S]{0,400}ran out of memory/.test(out), out)
ok('the limit and the remedy are named', out.includes(`${HEAP_MB} MB heap limit`) && out.includes('TERM_WORKER_HEAP_MB'), out)
ok('no small file is reported out of memory', !/small-\d+\.tree[^\n]*(out-of-memory|ran out of memory)/.test(out), out)
ok('the report names one unit out of memory', reported.length >= 1, out)

let built = 0

for (let i = 0; i < 15; i++) {
  if (existsSync(join(project, 'host', 'code', `small-${i}.ts`))) {
    built++
  }
}

ok('the other 15 files are built', built === 15, `${built} of 15 built\n${out}`)
ok('the big file is not built', !existsSync(join(project, 'host', 'code', 'big.ts')), out)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
