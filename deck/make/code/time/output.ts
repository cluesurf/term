// Reporting for benchmark results: a suite wrapper (with environment stamp) and the JSON form a baseline and the
// history are saved in. The host half of reporting: the text table is Term, time/table.tree (2026-10-04).

import type { BenchmarkResult } from '@term/make/code/time/stats'
import type { Side } from '@term/make/code/time/compare'

export type Suite = {
  results: BenchmarkResult[]
  timestamp: string
  platform: string
}

export function buildSuite(results: BenchmarkResult[]): Suite {
  return {
    results,
    timestamp: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}-node-${process.versions.node}`,
  }
}

// A result as the saved baseline and `term time --json` spell it: snake_case keys, an on-disk format older than the
// port of time/stats (2026-10-04), whose fields are camelCase in memory as every Term field is on TypeScript
export type SavedResult = {
  name: string
  iterations: number
  mean_ns: number
  median_ns: number
  std_dev_ns: number
  min_ns: number
  max_ns: number
  ops_per_sec: number
  cv: number
  timings_ns: number[]
}

export function toSaved(r: BenchmarkResult): SavedResult {
  return {
    name: r.name,
    iterations: r.iterations,
    mean_ns: r.meanNs,
    median_ns: r.medianNs,
    std_dev_ns: r.stdDevNs,
    min_ns: r.minNs,
    max_ns: r.maxNs,
    ops_per_sec: r.opsPerSec,
    cv: r.cv,
    timings_ns: r.timingsNs,
  }
}

// one saved result read back as one side of a comparison (time/compare's `side`). A baseline written before
// 2026-10-04, or a history entry, has the mean alone: its spread is `none`, and it is compared by the 5% rule alone
export function fromSaved(raw: { name: string; mean_ns: number; std_dev_ns?: number; timings_ns?: number[]; iterations?: number }): Side {
  return {
    name: raw.name,
    meanNs: raw.mean_ns,
    stdDevNs: raw.std_dev_ns !== undefined ? { form: 'some', value: raw.std_dev_ns } : { form: 'none' },
    samples: raw.timings_ns?.length || raw.iterations || 0,
  }
}

// a run as the history file keeps it, one mean per benchmark, snake_case like the baseline. It was time/compare's,
// and stayed TypeScript when that was ported: it is an on-disk shape
export function buildHistoryEntry(input: { suite: Suite }): {
  timestamp: string
  benchmarks: { name: string; mean_ns: number }[]
} {
  return {
    timestamp: input.suite.timestamp,
    benchmarks: input.suite.results.map(r => ({
      name: r.name,
      mean_ns: r.meanNs,
    })),
  }
}

export function formatJson(suite: Suite): string {
  return JSON.stringify({ ...suite, results: suite.results.map(toSaved) }, null, 2)
}
