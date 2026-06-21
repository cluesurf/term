// Reporting for benchmark results: a suite wrapper (with environment stamp), a JSON form for baselines, and a text
// table for the terminal. Pure except for reading the host platform/version when stamping a suite.

import {
  type BenchmarkResult,
  formatDuration,
} from '@cluesurf/make/code/time/stats'

export type Suite = {
  results: Array<BenchmarkResult>
  timestamp: string
  platform: string
}

export function buildSuite(results: Array<BenchmarkResult>): Suite {
  return {
    results,
    timestamp: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}-node-${process.versions.node}`,
  }
}

export function formatJson(suite: Suite): string {
  return JSON.stringify(suite, null, 2)
}

function pad(text: string, width: number): string {
  return text.length >= width
    ? text
    : text + ' '.repeat(width - text.length)
}

function padLeft(text: string, width: number): string {
  return text.length >= width
    ? text
    : ' '.repeat(width - text.length) + text
}

export function formatTable(results: Array<BenchmarkResult>): string {
  const rows = results.map(r => ({
    name: r.name,
    mean: formatDuration(r.mean_ns),
    median: formatDuration(r.median_ns),
    ops: Math.round(r.ops_per_sec).toLocaleString(),
    cv: `${(r.cv * 100).toFixed(1)}%`,
  }))
  const nameWidth = Math.max(9, ...rows.map(r => r.name.length))
  const header = `  ${pad('benchmark', nameWidth)}  ${padLeft(
    'mean',
    10,
  )}  ${padLeft('median', 10)}  ${padLeft('ops/sec', 14)}  ${padLeft(
    'cv',
    7,
  )}`
  const line = `  ${'-'.repeat(nameWidth)}  ${'-'.repeat(
    10,
  )}  ${'-'.repeat(10)}  ${'-'.repeat(14)}  ${'-'.repeat(7)}`
  const body = rows.map(
    r =>
      `  ${pad(r.name, nameWidth)}  ${padLeft(r.mean, 10)}  ${padLeft(
        r.median,
        10,
      )}  ${padLeft(r.ops, 14)}  ${padLeft(r.cv, 7)}`,
  )
  return [header, line, ...body].join('\n')
}
