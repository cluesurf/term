// The end-to-end benchmark driver. Compiles a source file, runs every `time-*` function in it, reduces the samples to
// a suite, and -- when a baseline is supplied -- compares against it and reports whether any benchmark regressed past
// the threshold. This is the single entry a `seed time` command calls: the CLI binary lives in the entrypoint package
// and only forwards parsed options here, so the whole flow (compile, run, stat, compare, gate) is tested in one place.

import {
  compileBenchmarks,
  runBenchmarks,
} from '@term/make/code/time/runner'
import { buildSuite } from '@term/make/code/time/output'
import type { Suite } from '@term/make/code/time/output'
import {
  compareResults,
  shouldFail,
} from '@term/make/code/time/compare'
import type { Comparison } from '@term/make/code/time/compare'

// a saved baseline is the JSON `results` array of a prior suite, narrowed to the fields the comparison reads
export type Baseline = { results: { name: string; mean_ns: number }[] }

export type BenchmarkRun = {
  suite: Suite
  comparison?: Comparison
  // true only when a baseline was given AND a benchmark regressed past `maxRegressionPct` -- the CI gate signal
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
  const module = compileBenchmarks({
    text: input.text,
    file: input.file,
    filter: input.filter,
  })

  const results = await runBenchmarks({
    module,
    root: input.root,
    warmup: input.warmup,
    iterations: input.iterations,
  })

  const suite = buildSuite(results)

  if (!input.baseline) {
    return { suite, regressed: false }
  }

  const comparison = compareResults({
    current: results,
    baseline: input.baseline,
  })

  const regressed = shouldFail({
    result: comparison,
    maxRegressionPct: input.maxRegressionPct ?? 10,
  })

  return { suite, comparison, regressed }
}
