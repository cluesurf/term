// CPU profiling. Runs the compiled program once in a child node process under V8's `--cpu-prof`, then reads the emitted
// `.cpuprofile`, attributes each sample's time delta to its call frame, and aggregates self-time per function. Reports
// the hottest functions. This profiles the compiled artifact's own hotspots (not the compiler).
//
// The attribution and the report are Term, time/profile.tree (self-hosting, 2026-10-04). This file is the process work.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Resolver } from '@term/make/code/compile/load'
import { cleanupDir, prepareModuleDir } from '@term/make/code/time/execute'
import { compileBenchmarks } from '@term/make/code/time/runner'
import type { Benchmark } from '@term/make/code/time/runner'
import { formatCpuResult, summarize } from '@term/make/code/time/profile'
import type { CpuFrame, CpuResult, V8Profile } from '@term/make/code/time/profile'

export { formatCpuResult }
export type { CpuFrame, CpuResult }

// the program's `time-*` tasks, the same ones `term time` times, each called over and over for `ms` milliseconds, so
// the profile is of the work and not of node loading a module. It imported the module and called nothing, and the
// hottest frames were node's own loader (guides: commands/time, 2026-10-04). A count of calls was not enough: a
// small task's hundred calls take less than one sample
function harness(benchmarks: Benchmark[], ms: number): string {
  return `import * as M from './module.mjs'
const entries = ${JSON.stringify(benchmarks.map(one => one.entry))}
for (const entry of entries) {
  const fn = M[entry]
  if (typeof fn !== 'function') continue
  const until = performance.now() + ${ms}
  // the clock is read once a thousand calls, and only a promise is awaited, so the loop's own cost stays out of the
  // profile
  while (performance.now() < until) {
    for (let i = 0; i < 1000; i++) {
      const out = fn()
      if (out instanceof Promise) await out
    }
  }
}
`
}

export async function runCpuProfile(input: {
  text: string
  file: string
  // the project resolver, so an entry with imports compiles the way `term make` compiles it
  resolve?: Resolver
  root: string
  name: string
  top?: number
  // how long, in milliseconds, each `time-*` task is called over and over under the profiler
  spend?: number
}): Promise<CpuResult> {
  const { code, benchmarks } = compileBenchmarks({
    text: input.text,
    file: input.file,
    resolve: input.resolve,
  })

  if (benchmarks.length === 0) {
    throw new Error('There is no `time-*` task to profile: the profile runs each one, as `term time` times them')
  }

  const dir = await prepareModuleDir({
    root: input.root,
    code,
    tag: 'cpu',
  })

  try {
    return await profileIn(dir, harness(benchmarks, input.spend ?? 500), input)
  } finally {
    // the folder is scratch, as the timing run's is: it was left under `.base/@cluesurf/term/tmp/` every run
    await cleanupDir(dir)
  }
}

async function profileIn(dir: string, script: string, input: { name: string; top?: number }): Promise<CpuResult> {
  await fs.writeFile(path.join(dir, 'harness.mjs'), script)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--cpu-prof',
        '--cpu-prof-dir',
        dir,
        '--cpu-prof-name',
        'run.cpuprofile',
        'harness.mjs',
      ],
      { cwd: dir },
    )

    let err = ''
    child.stderr.on('data', d => (err += String(d)))
    child.on('error', reject)
    child.on('close', code =>
      code === 0
        ? resolve()
        : reject(
            new Error(err.trim() || `node exited with code ${code}`),
          ),
    )
  })

  const raw = await fs.readFile(
    path.join(dir, 'run.cpuprofile'),
    'utf-8',
  )
  const profile = JSON.parse(raw) as V8Profile

  return summarize(profile, input.name, input.top ?? 15)
}
