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

  // the run's closing item sets process.exitCode before it exits (code/output.ts closeRun): the trapped exit records
  // the code in `calls`, so restoring puts the process's own code back too, or a passing suite exits 1
  const exitCode = process.exitCode

  return {
    restore: () => {
      process.exit = original
      process.exitCode = exitCode
    },
    calls,
  }
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

  // `--cpu` profiles the `time-*` tasks themselves, not node loading the module, and leaves no scratch folder
  {
    const { runCpuProfile } = await import('@term/make/code/time/cpu')
    const root = await makeProject('')
    const spin = `task spin-sum\n  take n, like number\n  like number\n  save total, code 0\n  walk size\n    bind base, code 0\n    bind head, read n\n    hook next\n      take site, name i\n      save total, add(total, i)\n  send back, read total\n\ntask time-spin\n  like number\n  send back, spin-sum(5000)\n`
    const result = await runCpuProfile({ text: spin, file: 'bench.tree', root, name: 'bench', top: 5, spend: 300 })
    const names = result.frames.map(frame => frame.name)
    // the simplifier may inline `spin-sum` into `time-spin`, so the hottest frame is one or the other, never a loader's
    ok('`--cpu` runs the `time-*` tasks, so their work is the hottest frame', ['spinSum', 'timeSpin'].includes(names[0] ?? ''), names.join(', '))
    const left = await fs.readdir(path.join(root, '.base/@cluesurf/term/tmp')).catch(() => [] as string[])
    ok('and leaves no scratch folder behind', left.length === 0, left.join(', '))

    let refused = ''

    try {
      await runCpuProfile({ text: `task noop\n  send back, code 1\n`, file: 'bench.tree', root, name: 'bench' })
    } catch (error) {
      refused = (error as Error).message
    }

    ok('a file with no `time-*` task is refused, not profiled empty', /no `time-\*` task to profile/.test(refused), refused || 'not refused')

    // `--memory` runs them too: a task that fills a module-level list keeps what it put there
    const { runMemoryProfile } = await import('@term/make/code/time/memory')
    const { projectResolver } = await import('@term/call/code/make')
    const keep = `load @term/base/list\n  find list\n  find push\n\nhost kept, make list\n  like list, like text\n\ntask time-fill\n  like number\n  walk size\n    bind base, code 0\n    bind head, code 200000\n    hook next\n      take site, name i\n      push kept, <row {i}>\n  send back, code 0\n`
    const memory = await runMemoryProfile({ text: keep, file: 'bench.tree', root, name: 'bench', resolve: projectResolver(root, 'node', root) })
    ok('`--memory` runs the `time-*` tasks, so what they keep is counted', memory.heapUsedAfterBytes - memory.heapUsedBeforeBytes > 4_000_000, `${memory.heapUsedBeforeBytes} -> ${memory.heapUsedAfterBytes}`)
  }

  console.log(`\ntime cli: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

void main()
