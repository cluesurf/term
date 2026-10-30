// The benchmark runner: discovers `time-*` tasks in a compiled program, runs them in a child `node` against the
// compiled module, and reduces the samples to statistics. The work is Term, time/runner-harness.tree (item
// term-self-host-change-001-finish-self-host-0010), whose header says what changed. This face keeps the names, the
// object inputs and the defaults its callers know, and throws `CompileFailure` for a file that does not compile.

import type { Resolver } from '@term/make/code/compile/load'
import type { Program } from '@term/make/code/compile/node'
import type { BenchmarkResult } from '@term/make/code/time/stats'
import { compiledOrThrown } from '@term/make/code/time/execute'
import * as harness from '@term/make/code/time/runner-harness'

export type Benchmark = { name: string; entry: string }
export type CompiledBenchmarks = {
  code: string
  benchmarks: Benchmark[]
}

// the benchmark tasks of a program: zero-argument top-level tasks named `time-*`
export function discoverBenchmarks(
  program: Program,
  filter?: string,
): Benchmark[] {
  return harness.discoverBenchmarks(program as never, filter ?? '')
}

export function compileBenchmarks(input: {
  text: string
  file: string
  // the project resolver, so an entry with imports compiles the way `term make` compiles it
  resolve?: Resolver
  filter?: string
}): CompiledBenchmarks {
  const built = harness.compileBenchmarks(
    input.text,
    input.file,
    input.resolve,
    input.filter ?? '',
  )

  const { code } = compiledOrThrown({ ...built, program: undefined })

  return { code, benchmarks: built.benchmarks }
}

export function runBenchmarks(input: {
  module: CompiledBenchmarks
  root: string
  warmup?: number
  iterations?: number
}): Promise<BenchmarkResult[]> {
  return harness.runBenchmarks(
    input.module.code,
    input.module.benchmarks,
    input.root,
    input.warmup ?? 10,
    input.iterations ?? 100,
  ) as Promise<BenchmarkResult[]>
}
