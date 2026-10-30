// The end-to-end benchmark driver: compile a source file, run every `time-*` task in it, reduce the samples to a suite,
// and when a baseline is given compare against it and say whether any benchmark regressed past the threshold. The
// work is Term, time/benchmark-driving.tree (item term-self-host-change-001-finish-self-host-0011), whose header says
// what changed. This face keeps the names, the object input and the defaults its callers know, and throws
// `CompileFailure` for a file that does not compile.
import type { Suite } from '@term/make/code/time/output'
import type { Comparison, Side } from '@term/make/code/time/compare'
import { CompileFailure } from '@term/make/code/time/execute'
import * as driving from '@term/make/code/time/benchmark-driving'

// a saved baseline is the JSON `results` array of a prior suite, each read back as one side of a comparison
// (time/output.ts `fromSaved`)
export type Baseline = { results: Side[] }

export type BenchmarkRun = {
  suite: Suite
  comparison?: Comparison
  // true only when a baseline was given AND a benchmark regressed past `maxRegressionPct`: the CI gate signal
  regressed: boolean
}

export async function benchmark(input: {
  text: string
  file: string
  // a writable directory the runner copies the compiled artifact into before spawning node
  root: string
  filter?: string
  warmup?: number
  iterations?: number
  baseline?: Baseline
  maxRegressionPct?: number
}): Promise<BenchmarkRun> {
  const made = await driving.driveBenchmarks(
    input.text,
    input.file,
    undefined,
    input.root,
    input.filter ?? '',
    input.warmup ?? 10,
    input.iterations ?? 100,
    Boolean(input.baseline),
    (input.baseline?.results ?? []) as never,
    input.maxRegressionPct ?? 10,
  )

  if (!made.ok) {
    throw new CompileFailure(made.diagnostics as never)
  }

  const suite = (made.suite as { value: Suite }).value

  if (made.comparison.form !== 'some') {
    return { suite, regressed: made.regressed }
  }

  return {
    suite,
    comparison: made.comparison.value as Comparison,
    regressed: made.regressed,
  }
}
