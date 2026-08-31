// CLI-level tests for `seed time` (the `callTime` handler). Run: npx tsx test/time/call.ts
// These exercise the command's own logic -- discovery + run against a real project, baseline persistence under
// `.base/@cluesurf/term/time/<name>.json`, and the save -> compare round-trip with regression gating -- without measuring anything.
// A trivial `time-noop` task keeps each run sub-millisecond, so the default iteration count is harmless: the point is
// that the plumbing (collect files -> compile -> run -> table/json -> save -> compare -> gate) works end to end.

import { callTime } from '@term/call/code/time'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

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

// callTime calls process.exit(1) on failure; trap it so a bad path is a test failure, not a killed process.
function trapExit(): { restore: () => void; calls: number[] } {
  const original = process.exit
  const calls: number[] = []
  process.exit = ((code?: number): never => {
    calls.push(code ?? 0)
    throw new Error(`process.exit(${code ?? 0})`)
  }) as typeof process.exit

  return { restore: () => (process.exit = original), calls }
}

async function makeProject(source: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-time-'))
  await fs.writeFile(path.join(root, 'bench.tree'), source)

  return root
}

async function readBaseline(
  root: string,
  name: string,
): Promise<{ results: { name: string; mean_ns: number }[] }> {
  const file = path.join(root, '.base/@cluesurf/term', 'time', `${name}.json`)

  return JSON.parse(await fs.readFile(file, 'utf-8'))
}

async function main(): Promise<void> {
  const source = `task time-noop\n  send back, code 1\n`

  // discovery + run: callTime finds the `time-*` task in the project, runs it, and saves a baseline JSON the
  // comparison layer can later read back.
  {
    const root = await makeProject(source)
    const trap = trapExit()

    try {
      await callTime({ root, save: 'base', json: true })
    } catch (err) {
      ok('run + save did not exit', false, String(err))
    } finally {
      trap.restore()
    }

    if (trap.calls.length === 0) {
      const baseline = await readBaseline(root, 'base')
      ok(
        'save wrote a baseline with the discovered benchmark',
        baseline.results.length === 1 &&
          baseline.results[0]!.name === 'time-noop',
        JSON.stringify(baseline.results.map(r => r.name)),
      )
      ok(
        'baseline records a numeric mean',
        typeof baseline.results[0]!.mean_ns === 'number' &&
          baseline.results[0]!.mean_ns >= 0,
      )

      const history = path.join(root, '.base/@cluesurf/term', 'time', 'history')
      const entries = await fs.readdir(history).catch(() => [])
      ok(
        'save also appended a history entry',
        entries.length === 1 && entries[0]!.endsWith('.json'),
        JSON.stringify(entries),
      )
    }

    await fs.rm(root, { recursive: true, force: true })
  }

  // save -> compare round-trip: comparing a fresh run against the just-saved baseline reads it back and runs without
  // failing (no regression, since the gate is generous).
  {
    const root = await makeProject(source)
    const trap = trapExit()

    try {
      await callTime({ root, save: 'base' })
      await callTime({
        root,
        compare: 'base',
        failOnRegression: 1000,
      })
      ok('save then compare round-trips cleanly', true)
    } catch (err) {
      ok('save then compare round-trips cleanly', false, String(err))
    } finally {
      trap.restore()
    }

    await fs.rm(root, { recursive: true, force: true })
  }

  // gating: a planted baseline that is absurdly fast forces the current run to read as a large regression, so a tight
  // --fail-on-regression must trip the CI gate (process.exit(1)).
  {
    const root = await makeProject(source)
    const dir = path.join(root, '.base/@cluesurf/term', 'time')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'tight.json'),
      JSON.stringify({
        results: [{ name: 'time-noop', mean_ns: 1 }],
      }),
    )

    const trap = trapExit()

    try {
      await callTime({
        root,
        compare: 'tight',
        failOnRegression: 5,
      })
    } catch {
      // callTime may catch the trapped exit internally; the gate signal is the recorded exit code, checked below.
    } finally {
      trap.restore()
    }

    ok(
      'gate exits non-zero on a regression past the threshold',
      trap.calls.includes(1),
      JSON.stringify(trap.calls),
    )

    await fs.rm(root, { recursive: true, force: true })
  }

  // no benchmarks: a project with no `time-*` task fails clearly rather than reporting an empty success.
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-time-'))
    await fs.writeFile(
      path.join(root, 'plain.tree'),
      `task helper\n  take n, like number\n  send back, read n\n`,
    )

    const trap = trapExit()

    try {
      await callTime({ root })
      ok('empty project fails', false, 'no exit')
    } catch {
      // expected
    } finally {
      trap.restore()
    }

    ok(
      'empty project exits non-zero',
      trap.calls.includes(1),
      JSON.stringify(trap.calls),
    )

    await fs.rm(root, { recursive: true, force: true })
  }

  console.log(`\ntime cli: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

void main()
