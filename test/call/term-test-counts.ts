// The gate reads a package's `term test` run off its closing line (task/term/gate/term-test-counts.ts, item
// term-self-host-001-1635): the counts of the line holding the verdict, and a run that closes on no count line or ran
// no test is a failure. The lines below are what the printer draws (deck/call/code/test-plan.tree `totals-counts`), and
// four runs of this checkout's own CLI over test/call/test-skip-fixture and an empty project hold the reader to the
// printer as it is now. Run: npx tsx test/call/term-test-counts.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { termTestCounts, termTestResult } from '../../task/term/gate/term-test-counts'
import { TERM_ROOT } from '../../task/term/root'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info: unknown = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${typeof info === 'string' ? info : JSON.stringify(info)}`)
  }
}

// ---- the lines the printer draws ----

// off a terminal the facts stand on the line under the verdict, on one the same line
const closing = '✓ test Tests passed\n  09:11:02.305 · 10.3s · 270 tests · 270 passed'
const passed = termTestResult(0, `● test ~/deck/test\n  term 2.10.2 · 12 files\n${closing}\n`)
ok('a passed run reads its count', passed.ok && passed.pass === 270 && passed.fail === 0, passed)

const sameLine = termTestResult(0, '✓ test Tests passed · 10.3s · 270 tests · 270 passed\n')
ok('a closing item on one line reads', sameLine.ok && sameLine.pass === 270, sameLine)

const perFile = '✓ test test/a.tree\n  0.4s · 9 tests · 9 passed'
const twoLines = termTestCounts(`${perFile}\n${closing}\n${perFile}\n`)
ok('only the closing item is read, never a file item', twoLines?.tests === 270 && twoLines.passed === 270, twoLines)
ok('a file item alone is no closing item', termTestCounts(`${perFile}\n`) === undefined)

const failedRun = termTestResult(1, '✗ test x.tree\n  1s · 5 tests · 3 passed · 2 failed\n✗ test Test run failed\n  3.1s · 5 tests · 3 passed · 2 failed\n')
ok('a failed run fails with its count', !failedRun.ok && failedRun.pass === 3 && failedRun.fail === 2, failedRun)

const zeroExitFailed = termTestResult(0, '✗ test Test run failed · 3.1s · 5 tests · 4 passed · 1 failed\n')
ok('a failed count fails even on exit 0', !zeroExitFailed.ok && zeroExitFailed.fail === 1, zeroExitFailed)

const broken = termTestResult(1, '✗ test Test run failed · 1.0s · 0 tests · 0 passed · 1 file did not build\n')
ok('a file that did not build (singular) fails', !broken.ok && broken.fail === 1, broken)
ok('the singular counts read', termTestCounts('✗ test Test run failed · 1s · 1 test · 0 passed · 1 failed · 2 files did not build')?.broken === 2)

const one = termTestResult(0, '✓ test Tests passed · 0.2s · 1 test · 1 passed\n')
ok('one test (singular) passes', one.ok && one.pass === 1, one)

const zero = termTestResult(0, '✓ test Tests passed · 0.1s · 0 tests · 0 passed\n')
ok('a run of zero tests fails', !zero.ok && zero.pass === 0, zero)

const none = termTestResult(0, '● test 0 files\n✓ test No tests to run\n  No file under code/ or test/ holds a test, a hold or a rule.\n')
ok('a run with no closing count line fails', !none.ok, none)
ok('an empty output fails', !termTestResult(0, '').ok)

const old = termTestResult(0, '270 tests passed\n')
ok('the old wording alone is no closing line', !old.ok, old)

const coloured = termTestResult(0, '\x1b[32m✓\x1b[39m test \x1b[1mTests passed\x1b[22m · 10.3s · \x1b[1m270\x1b[22m tests · 270 passed\n')
ok('a coloured closing line reads', coloured.ok && coloured.pass === 270, coloured)

const skips = termTestCounts('✓ test Every test was skipped · 0.2s · 3 tests · 0 passed · 3 skipped')
ok('an all-skipped run reads its skips', skips?.tests === 3 && skips.skipped === 3 && skips.passed === 0, skips)

ok('a killed run fails', !termTestResult(null, closing).ok)
ok('a passed run under exit 1 fails', !termTestResult(1, closing).ok)

// ---- this checkout's CLI ----

const line = process.env.TERM_LINE ?? join(TERM_ROOT, 'host/line.js')

function termTest(cwd: string, args: string[]): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [line, 'test', ...args, '--env', 'node', '--color', 'never', '--no-motion'], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
  })

  return { status: run.status, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}` }
}

const fixture = join(TERM_ROOT, 'test/call/test-skip-fixture')

const mixed = termTest(fixture, ['one-of-each'])
const mixedCounts = termTestCounts(mixed.output)
ok(
  'the CLI: a pass, a skip and a failure read 3 tests, 1 passed, 1 failed, 1 skipped, and fail',
  mixed.status === 1 && mixedCounts?.tests === 3 && mixedCounts.passed === 1 && mixedCounts.failed === 1 && mixedCounts.skipped === 1 && !termTestResult(mixed.status, mixed.output).ok,
  { status: mixed.status, counts: mixedCounts, tail: mixed.output.slice(-300) },
)

const clean = termTest(fixture, ['no-failure'])
const cleanResult = termTestResult(clean.status, clean.output)
ok('the CLI: a pass and a skip pass, 1 pass', clean.status === 0 && cleanResult.ok && cleanResult.pass === 1, { status: clean.status, result: cleanResult, tail: clean.output.slice(-300) })

const skipped = termTest(fixture, ['skips-alone'])
const skippedCounts = termTestCounts(skipped.output)
ok('the CLI: every test skipped reads 3 tests, 0 passed', skipped.status === 0 && skippedCounts?.tests === 3 && skippedCounts.passed === 0, { status: skipped.status, counts: skippedCounts })

// a project holding no test at all: the CLI exits 0, and the gate must not call it a pass
const empty = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'term-test-counts-'))

try {
  writeFileSync(join(empty, 'deck.tree'), 'deck @probe/no-tests\n  mark <0.0.1>\n')
  const nothing = termTest(empty, [])
  const nothingResult = termTestResult(nothing.status, nothing.output)
  ok('the CLI: a project with no test exits 0, and the gate fails it', nothing.status === 0 && !nothingResult.ok && nothingResult.pass === 0, { status: nothing.status, result: nothingResult, tail: nothing.output.slice(-300) })
} finally {
  rmSync(empty, { recursive: true, force: true })
}

console.log(`\ncall/term-test-counts: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
