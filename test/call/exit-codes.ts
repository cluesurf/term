// Phase 2 of note/term/gaps/plan.md, "Exit codes that tell the truth": a command that failed at what it was asked
// exits non-zero, and a command that wrote nothing does not say it wrote something. Each case is the run a term.surf
// guide made, against the built CLI.
//
// Run: npx tsx test/call/exit-codes.ts (after `pnpm run make:line`)

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const LINE = join(HERE, '../../host/line.js')

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function term(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const run = spawnSync('node', [LINE, ...args], { cwd, encoding: 'utf8', timeout: 240_000, env: { ...process.env, NO_COLOR: '1' } })

  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

// a project with one benchmark and one test file, which is what `term time` walks
const project = mkdtempSync(join(tmpdir(), 'term-exit-codes-'))
mkdirSync(join(project, 'code'))
mkdirSync(join(project, 'test'))
writeFileSync(join(project, 'deck.tree'), 'deck @probe/exit\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
writeFileSync(
  join(project, 'code/base.tree'),
  `task time-sum
  like number
  send back
    call add
      code 1
      code 2
`,
)
writeFileSync(
  join(project, 'test/sum.tree'),
  `test sum-adds
  want hold
    call is-equal
      call add
        code 1
        code 2
      code 3
`,
)

// ---- commands/show: outside a project ----
{
  const empty = mkdtempSync(join(tmpdir(), 'term-exit-empty-'))
  const run = term(empty, 'show', 'mark')

  ok('`term show mark` outside a project exits non-zero', run.status !== 0, run.out)
}

// ---- commands/time, tests/benchmarks: a baseline that does not exist ----
{
  const run = term(project, 'time', '--compare', 'nope', '--fail-on-regression', '5')

  ok('`term time --compare` with no such baseline exits 1', run.status === 1, run.out)
  // a ✗ item naming the baseline, with the path it looked for in a `looked` field
  ok('naming the file it looked for', /There is no baseline named nope[\s\S]*?looked\s+\S*nope\.json/.test(run.out), run.out)
  ok('before any benchmark ran', !/time-sum/.test(run.out), run.out)
}

// ---- commands/time: the walk is the build's, and a test file is rewritten ----
{
  const run = term(project, 'time')

  ok('`term time` runs the benchmark', run.status === 0 && /time-sum/.test(run.out), run.out)
  ok('and compiles neither the manifest nor a raw test file as code', !/unknown-name|deck\.tree: /.test(run.out), run.out)
}

// ---- commands/form: `--list` writes nothing and says so ----
{
  const file = join(project, 'code/loose.tree')
  const written = 'task two\n  like number\n  send back\n    call add\n      code 1\n      code 2\n\n\n\n'

  writeFileSync(file, written)

  const run = term(project, 'form', '--list', 'code/loose.tree')

  ok('`term form --list` leaves the file as it was', readFileSync(file, 'utf8') === written)
  ok('and does not say it formatted anything', !/Formatted \d+ file/.test(run.out), run.out)
  ok('it says it printed the file and wrote nothing', /Printed .*nothing (was )?written/i.test(run.out), run.out)
}

console.log(`\nexit-codes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
