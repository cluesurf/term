// Reporting for benchmark results: the suite (with its environment stamp) and the JSON a baseline and the history are
// saved in. The work is Term, time/output-records.tree (item term-self-host-change-001-finish-self-host-0010), whose
// header says what changed; the text table is time/table.tree. This face keeps the TypeScript names and shapes its
// callers know (call/code/work/tool/time-command.tree docks it, by these names).

import type { BenchmarkResult } from '@term/make/code/time/stats'
import type { Side } from '@term/make/code/time/compare'
import * as records from '@term/make/code/time/output-records'

export type Suite = {
  results: BenchmarkResult[]
  timestamp: string
  platform: string
}

// a result as the saved baseline and `term time --json` spell it: snake_case keys, an on-disk format
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

export function buildSuite(results: BenchmarkResult[]): Suite {
  return records.buildSuite(results as never) as Suite
}

export function toSaved(r: BenchmarkResult): SavedResult {
  return records.toSaved(r as never) as SavedResult
}

// one saved result read back as one side of a comparison: a baseline with the mean alone has the spread `none`
export function fromSaved(raw: {
  name: string
  mean_ns: number
  std_dev_ns?: number
  timings_ns?: number[]
  iterations?: number
}): Side {
  return records.fromSaved(raw) as Side
}

// a run as the history file keeps it, one mean per benchmark
export function buildHistoryEntry(input: { suite: Suite }): {
  timestamp: string
  benchmarks: { name: string; mean_ns: number }[]
} {
  return records.buildHistoryEntry(input.suite as never)
}

export function formatJson(suite: Suite): string {
  return records.formatJson(suite as never)
}
