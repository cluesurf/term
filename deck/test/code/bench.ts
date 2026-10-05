/**
 * A generic micro-benchmark harness, target-agnostic so it can time any
 * code path in any codebase (not just the Seed compiler). It runs a
 * function many times with a warmup, collects per-iteration timings, and
 * reports robust statistics (min / median / p95 / mean / ops-per-sec) so
 * a real change is distinguishable from noise. A companion to `hunt`: one
 * finds correctness bugs, this finds performance ones.
 *
 * The statistics, the scaling fit and the table are Term since 2026-10-04,
 * deck/test/code/bench-report.tree. This keeps the timing (a caller's
 * closure under the clock, warmed up, sync or awaited) and the optional
 * `size` its callers read.
 */

import { renderBench as renderReport, scaling as fitScaling, statsOf } from '@term/test/code/bench-report'
import type { BenchResult as Report } from '@term/test/code/bench-report'

const DEFAULT_ITERATIONS = 50
const DEFAULT_WARMUP = 5

export type BenchResult = {
  name: string
  iterations: number
  min: number
  median: number
  mean: number
  p95: number
  max: number
  opsPerSec: number
  // an optional caller-supplied size, for scaling analysis
  size?: number
}

function now(): number {
  return performance.now()
}

function toReport(r: BenchResult): Report {
  return { ...r, hasSize: r.size !== undefined, size: r.size ?? 0 }
}

function stats(name: string, samples: number[], size?: number): BenchResult {
  const { hasSize, ...report } = statsOf(name, samples, size !== undefined, size ?? 0)

  return { ...report, size: hasSize ? report.size : undefined }
}

/** Time `run` over `iterations` (after `warmup` untimed runs). */
export function bench(input: {
  name: string
  run: () => void
  iterations?: number
  warmup?: number
  size?: number
}): BenchResult {
  const iterations = input.iterations ?? DEFAULT_ITERATIONS
  const warmup = input.warmup ?? DEFAULT_WARMUP

  for (let i = 0; i < warmup; i++) input.run()

  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = now()
    input.run()
    samples.push(now() - t0)
  }
  return stats(input.name, samples, input.size)
}

/** Async variant for promise-returning work. */
export async function benchAsync(input: {
  name: string
  run: () => Promise<void>
  iterations?: number
  warmup?: number
  size?: number
}): Promise<BenchResult> {
  const iterations = input.iterations ?? DEFAULT_ITERATIONS
  const warmup = input.warmup ?? DEFAULT_WARMUP

  for (let i = 0; i < warmup; i++) await input.run()

  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = now()
    await input.run()
    samples.push(now() - t0)
  }
  return stats(input.name, samples, input.size)
}

/**
 * Estimate the growth exponent of a benchmark across sizes: fit
 * median-time ~ size^k in log-log space. k ~ 1 is linear, ~ 2 is
 * quadratic. This is how you catch a super-linear pass before it bites.
 */
export function scaling(results: BenchResult[]): { exponent: number; verdict: string } {
  return fitScaling(results.map(toReport))
}

/** Render a table of results. */
export function renderBench(results: BenchResult[]): string {
  return renderReport(results.map(toReport))
}

// the statistics alone, for a pairing against the original
export { stats as statsOfSamples }
