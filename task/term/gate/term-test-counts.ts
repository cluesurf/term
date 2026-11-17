// What a `term test` run says it did, read off the item it closes on (deck/call/code/test-plan.tree `totals-counts`,
// `round-verdict`): `✓ test Tests passed` with its facts `10.3s · 270 tests · 270 passed`, and in its other forms
// `✗ test Test run failed` with `3.1s · 5 tests · 3 passed · 2 failed · 1 file did not build`, and
// `Every test was skipped` with `4 tests · 0 passed · 4 skipped`. A count of one is singular (`1 test`,
// `1 file did not build`, T-1582c). Each file's item carries `N tests · M passed` too, so only the closing item, the
// one holding the verdict, is read.
//
// The gate's package suites (task/term/test.ts `packageTests`) read `/(\d+) tests? passed/`, the wording before the
// closing line had a verdict, which no run prints now: every package suite read `0 pass` after 270 tests had passed,
// and a run that ran no test at all read ok the same way (audit 0145, item term-self-host-001-1635).

export type TermTestCounts = { tests: number; passed: number; failed: number; skipped: number; broken: number }

export type TermTestResult = { ok: boolean; pass: number; fail: number; note: string }

const VERDICT = /(?:Tests passed|Test run failed|Every test was skipped)\b/
const TOTAL = /(\d+) tests? · (\d+) passed/

// the colours a terminal run draws, which a run under the gate can still carry (FORCE_COLOR)
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

// the closing item's counts, or undefined when the output holds no closing item with counts. The item is the verdict's
// line and the indented lines under it: a run that is not on a terminal draws its facts on the next line
// (`✓ test Tests passed` / `  09:11:02.305 · 1.04s · 3 tests · 1 passed`), a terminal on the same one
export function termTestCounts(output: string): TermTestCounts | undefined {
  const lines = plain(output).split('\n')

  for (let at = lines.length - 1; at >= 0; at--) {
    if (!VERDICT.test(lines[at])) {
      continue
    }

    const block = [lines[at]]

    for (let next = at + 1; next < lines.length && /^\s+\S/.test(lines[next]); next++) {
      block.push(lines[next])
    }

    const line = block.join(' ')
    const total = TOTAL.exec(line)

    if (!total) {
      continue
    }

    const count = (pattern: RegExp): number => Number(pattern.exec(line)?.[1] ?? 0)

    return {
      tests: Number(total[1]),
      passed: Number(total[2]),
      failed: count(/(\d+) failed/),
      skipped: count(/(\d+) skipped/),
      broken: count(/(\d+) files? did not build/),
    }
  }

  return undefined
}

// a package's `term test` run as a gate suite: ok only when it exited 0, closed with its counts, ran at least one test,
// and none failed or failed to build. A run with no closing line, or one that ran no test, fails: it proves nothing
export function termTestResult(status: number | null, output: string): TermTestResult {
  const counts = termTestCounts(output)
  const crosses = plain(output).split('\n').filter(line => /✗/.test(line)).slice(0, 3).join(' | ')

  if (!counts) {
    const tail = plain(output).split('\n').filter(line => line.trim() !== '').slice(-2).join(' | ').slice(0, 200)

    return { ok: false, pass: 0, fail: 1, note: `no closing count line from term test (exit ${status}): ${crosses || tail}` }
  }

  const fail = counts.failed + counts.broken

  if (counts.tests === 0) {
    return { ok: false, pass: 0, fail: Math.max(fail, 1), note: `term test ran no test (exit ${status})${crosses ? `: ${crosses}` : ''}` }
  }

  const ok = status === 0 && fail === 0

  return {
    ok,
    pass: counts.passed,
    fail: ok ? 0 : Math.max(fail, 1),
    note: ok ? '' : crosses || `term test exited ${status}`,
  }
}
