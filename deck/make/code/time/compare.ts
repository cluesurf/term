// Baseline comparison and CI gating. Matches current results against a saved baseline by name, flags a run slower
// than the threshold as a regression, and renders the verdict for the terminal and for a CI markdown comment.

import {
  type BenchmarkResult,
  formatDuration,
} from '@cluesurf/make/code/time/stats'
import { type Suite } from '@cluesurf/make/code/time/output'

// percent change beyond which a difference is reported as a regression / improvement rather than noise
const SIGNIFICANT_PCT = 5

export type Verdict = 'faster' | 'slower' | 'same' | 'new'

export type Comparison = {
  entries: {
    name: string
    baseline_ns: number
    current_ns: number
    pct: number
    status: Verdict
  }[]
  regressions: number
  improvements: number
}

export function compareResults(input: {
  current: BenchmarkResult[]
  baseline: { results: { name: string; mean_ns: number }[] }
}): Comparison {
  const baselineByName = new Map(
    input.baseline.results.map(r => [r.name, r.mean_ns]),
  )

  let regressions = 0
  let improvements = 0

  const entries = input.current.map(r => {
    const baseline_ns = baselineByName.get(r.name)

    if (baseline_ns === undefined) {
      return {
        name: r.name,
        baseline_ns: 0,
        current_ns: r.mean_ns,
        pct: 0,
        status: 'new' as const,
      }
    }

    const pct =
      baseline_ns > 0
        ? ((r.mean_ns - baseline_ns) / baseline_ns) * 100
        : 0

    let status: Verdict = 'same'

    if (pct > SIGNIFICANT_PCT) {
      status = 'slower'
      regressions++
    } else if (pct < -SIGNIFICANT_PCT) {
      status = 'faster'
      improvements++
    }

    return {
      name: r.name,
      baseline_ns,
      current_ns: r.mean_ns,
      pct,
      status,
    }
  })

  return { entries, regressions, improvements }
}

export function shouldFail(input: {
  result: Comparison
  maxRegressionPct: number
}): boolean {
  return input.result.entries.some(
    e => e.status === 'slower' && e.pct > input.maxRegressionPct,
  )
}

export function formatComparison(comparison: Comparison): string {
  const mark = { faster: '↓', slower: '↑', same: '=', new: '+' }
  const lines = comparison.entries.map(e => {
    const delta =
      e.status === 'new'
        ? 'new'
        : `${e.pct >= 0 ? '+' : ''}${e.pct.toFixed(1)}%`

    return `  ${mark[e.status]} ${e.name}: ${formatDuration(
      e.current_ns,
    )} (${delta})`
  })

  return [
    ...lines,
    '',
    `  ${comparison.improvements} improvement(s), ${comparison.regressions} regression(s)`,
  ].join('\n')
}

export function buildHistoryEntry(input: { suite: Suite }): {
  timestamp: string
  benchmarks: { name: string; mean_ns: number }[]
} {
  return {
    timestamp: input.suite.timestamp,
    benchmarks: input.suite.results.map(r => ({
      name: r.name,
      mean_ns: r.mean_ns,
    })),
  }
}

export function formatMarkdown(input: {
  result: Comparison
  suite: Suite
}): string {
  const rows = input.result.entries.map(e => {
    const delta =
      e.status === 'new'
        ? 'new'
        : `${e.pct >= 0 ? '+' : ''}${e.pct.toFixed(1)}%`

    return `| ${e.name} | ${formatDuration(
      e.current_ns,
    )} | ${delta} | ${e.status} |`
  })

  return [
    `### Benchmark results (${input.suite.platform})`,
    '',
    '| benchmark | mean | change | status |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `${input.result.improvements} improvement(s), ${input.result.regressions} regression(s)`,
  ].join('\n')
}
