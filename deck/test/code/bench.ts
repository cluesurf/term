/**
 * A generic micro-benchmark harness, target-agnostic so it can time any
 * code path in any codebase (not just the Seed compiler). It runs a
 * function many times with a warmup, collects per-iteration timings, and
 * reports robust statistics (min / median / p95 / mean / ops-per-sec) so
 * a real change is distinguishable from noise. A companion to `hunt`: one
 * finds correctness bugs, this finds performance ones.
 *
 * The point is not a single number but ANALYSIS: compare variants
 * (`compare`), watch for super-linear growth across sizes (`scaling`),
 * and turn the numbers into insights you can act on.
 */

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

function stats(name: string, samples: number[], size?: number): BenchResult {
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))]!
  const sum = sorted.reduce((a, b) => a + b, 0)
  const median = at(0.5)
  return {
    name,
    iterations: n,
    min: sorted[0]!,
    median,
    mean: sum / n,
    p95: at(0.95),
    max: sorted[n - 1]!,
    opsPerSec: median > 0 ? 1000 / median : Infinity,
    size,
  }
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
  const pts = results.filter(r => r.size && r.size > 0 && r.median > 0)
  if (pts.length < 2) return { exponent: NaN, verdict: 'need >= 2 sized points' }
  // least-squares slope of log(time) vs log(size)
  const xs = pts.map(p => Math.log(p.size!))
  const ys = pts.map(p => Math.log(p.median))
  const xbar = xs.reduce((a, b) => a + b, 0) / xs.length
  const ybar = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - xbar) * (ys[i]! - ybar)
    den += (xs[i]! - xbar) ** 2
  }
  const k = den === 0 ? NaN : num / den
  const verdict =
    k < 1.3 ? 'linear (good)' : k < 1.7 ? 'super-linear (watch)' : k < 2.5 ? 'quadratic (fix)' : 'worse than quadratic (fix now)'
  return { exponent: k, verdict }
}

/** Render a table of results. */
export function renderBench(results: BenchResult[]): string {
  const rows = results.map(r => {
    const sz = r.size !== undefined ? `${r.size}`.padStart(8) : '       -'
    return `  ${r.name.padEnd(34)} ${r.median.toFixed(3).padStart(9)}ms  p95 ${r.p95.toFixed(3).padStart(9)}ms  ${Math.round(r.opsPerSec).toString().padStart(9)}/s  size ${sz}`
  })
  return ['  benchmark                          median        p95        ops/sec     size', ...rows].join('\n')
}
