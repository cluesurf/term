// The benchmark runner. Discovers `time-*` functions in a compiled program, runs them in a child `node` process
// against the compiled artifact, and reduces the raw samples to statistics. Benchmarks are zero-argument top-level
// functions whose name starts with `time-` (e.g. `task time-sort`).

import { toCamel } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'
import {
  compileToModule,
  prepareModuleDir,
  runNode,
  cleanupDir,
} from '@term/make/code/time/execute'
import {
  computeStats,
  type BenchmarkResult,
} from '@term/make/code/time/stats'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type Benchmark = { name: string; entry: string }
export type CompiledBenchmarks = {
  code: string
  benchmarks: Benchmark[]
}

// find the benchmark functions in a program: zero-argument top-level functions named `time-*`.
export function discoverBenchmarks(
  program: Program,
  filter?: string,
): Benchmark[] {
  return program
    .filter(
      (s): s is Extract<Program[number], { form: 'function' }> =>
        s.form === 'function' &&
        s.params.length === 0 &&
        s.name.startsWith('time-'),
    )
    .filter(s => !filter || s.name.includes(filter))
    .map(s => ({ name: s.name, entry: toCamel(s.name) }))
}

export function compileBenchmarks(input: {
  text: string
  file: string
  filter?: string
}): CompiledBenchmarks {
  const { code, program } = compileToModule({
    text: input.text,
    file: input.file,
  })

  return { code, benchmarks: discoverBenchmarks(program, input.filter) }
}

function buildHarness(input: {
  benchmarks: Benchmark[]
  warmup: number
  iterations: number
}): string {
  return `import * as M from './module.mjs'
const specs = ${JSON.stringify(input.benchmarks)}
const warmup = ${input.warmup}, iterations = ${input.iterations}
async function main() {
  const out = []
  for (const s of specs) {
    const fn = M[s.entry]
    if (typeof fn !== 'function') continue
    for (let i = 0; i < warmup; i++) await fn()
    const timings = []
    for (let i = 0; i < iterations; i++) {
      const a = process.hrtime.bigint()
      await fn()
      const b = process.hrtime.bigint()
      timings.push(Number(b - a))
    }
    out.push({ name: s.name, timings })
  }
  process.stdout.write(JSON.stringify(out))
}
main().catch((e) => { console.error(e); process.exit(1) })
`
}

export async function runBenchmarks(input: {
  module: CompiledBenchmarks
  root: string
  warmup?: number
  iterations?: number
}): Promise<BenchmarkResult[]> {
  if (input.module.benchmarks.length === 0) {
    return []
  }

  const dir = await prepareModuleDir({
    root: input.root,
    code: input.module.code,
    tag: 'time',
  })

  try {
    const harness = buildHarness({
      benchmarks: input.module.benchmarks,
      warmup: input.warmup ?? 10,
      iterations: input.iterations ?? 100,
    })

    await fs.writeFile(path.join(dir, 'harness.mjs'), harness)

    const stdout = await runNode({
      file: path.join(dir, 'harness.mjs'),
      cwd: dir,
    })

    const samples: { name: string; timings: number[] }[] =
      JSON.parse(stdout)

    return samples.map(s => computeStats(s.name, s.timings))
  } finally {
    await cleanupDir(dir)
  }
}
