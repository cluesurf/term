// Timing statistics for a benchmark: reduce a list of per-iteration nanosecond samples to the summary the reporter
// shows. Pure. The runner gathers raw samples by executing the compiled artifact; this turns them into numbers.

export type BenchmarkResult = {
  name: string
  iterations: number
  mean_ns: number
  median_ns: number
  std_dev_ns: number
  min_ns: number
  max_ns: number
  ops_per_sec: number
  cv: number // coefficient of variation: std_dev / mean, a unitless noise measure
  timings_ns: Array<number>
}

export function computeStats(
  name: string,
  timings: Array<number>,
): BenchmarkResult {
  const sorted = [...timings].sort((a, b) => a - b)
  const count = sorted.length || 1
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / count
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) /
        2
  const variance =
    sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / count
  const stdDev = Math.sqrt(variance)
  return {
    name,
    iterations: timings.length,
    mean_ns: mean,
    median_ns: median,
    std_dev_ns: stdDev,
    min_ns: sorted[0] ?? 0,
    max_ns: sorted[sorted.length - 1] ?? 0,
    ops_per_sec: mean > 0 ? 1e9 / mean : 0,
    cv: mean > 0 ? stdDev / mean : 0,
    timings_ns: timings,
  }
}

// human-readable duration from nanoseconds
export function formatDuration(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(1)}ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)}us`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`
  return `${(ns / 1_000_000_000).toFixed(2)}s`
}
