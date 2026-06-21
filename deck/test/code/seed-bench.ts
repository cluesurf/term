/**
 * The Seed compiler benchmark suite: time the real compiler paths
 * (tokenize, parse, compile, stream-split) across real stdlib files and
 * synthetic workloads that isolate one cost each (file length, line
 * length, nesting depth, import-closure size). It then ANALYZES the
 * numbers - scaling exponents and ratios - into insights, the way the
 * bug-hunt analyzes correctness.
 *
 * Reusable: `runCompilerBench` returns structured results + insights so
 * a script, a CI gate, or a skill can consume them. The resolver is
 * injected to avoid a call<->test cycle.
 */

import { readFileSync, existsSync } from 'node:fs'
import { tokenize } from '@cluesurf/make/code/parser/token'
import { parse } from '@cluesurf/make/code/parser/tree'
import { compile } from '@cluesurf/make/code/compile/compile'
import { CompileCache } from '@cluesurf/make/code/compile/cache'
import { collectModules } from '@cluesurf/make/code/compile/load'
import type { Resolver } from '@cluesurf/make/code/compile/load'
import { splitTopLevel } from '@cluesurf/make/code/compile/incremental-parse'
import { splitStreamingToArray } from '@cluesurf/make/code/compile/stream'
import { bench, scaling, type BenchResult } from './bench'

export type BenchSuite = {
  results: BenchResult[]
  insights: string[]
}

// synthetic source generators, each isolating one cost dimension
function manyDefs(n: number): string {
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(`task t${i}\n  send back, mark ${i}\n`)
  return parts.join('\n')
}
function longLine(n: number): string {
  return `task t\n  send back, text <${'a'.repeat(n)}>\n`
}
function deepNest(n: number): string {
  // nested fork/hook to stress the tree builder's indentation handling
  const lines = ['task t', '  take x, like number']
  for (let i = 0; i < n; i++) {
    lines.push('  '.repeat(i + 1) + 'fork test')
    lines.push('  '.repeat(i + 2) + 'hook test')
    lines.push('  '.repeat(i + 3) + 'call is-above')
    lines.push('  '.repeat(i + 4) + 'read x')
    lines.push('  '.repeat(i + 4) + 'mark ' + i)
    lines.push('  '.repeat(i + 2) + 'hook hold')
  }
  lines.push('  '.repeat(n + 2) + 'send back, read x')
  return lines.join('\n') + '\n'
}

/** Run the compiler benchmark suite. */
export function runCompilerBench(input: {
  root: string
  resolve: Resolver
  iterations?: number
}): BenchSuite {
  const iters = input.iterations ?? 30
  const results: BenchResult[] = []
  const insights: string[] = []

  // ---- tokenize scaling on file length (definition count) ----
  const lenTok: BenchResult[] = []
  for (const n of [100, 400, 1600, 6400]) {
    const src = manyDefs(n)
    const r = bench({ name: `tokenize ${n} defs`, run: () => void tokenize({ file: 't.tree', text: src }), iterations: iters, size: n })
    lenTok.push(r); results.push(r)
  }
  const tokScale = scaling(lenTok)
  insights.push(`tokenize vs file length: exponent ${tokScale.exponent.toFixed(2)} - ${tokScale.verdict}`)

  // ---- parse scaling on file length ----
  const lenParse: BenchResult[] = []
  for (const n of [100, 400, 1600, 6400]) {
    const src = manyDefs(n)
    const r = bench({ name: `parse ${n} defs`, run: () => void parse({ file: 't.tree', text: src }), iterations: iters, size: n })
    lenParse.push(r); results.push(r)
  }
  const parseScale = scaling(lenParse)
  insights.push(`parse vs file length: exponent ${parseScale.exponent.toFixed(2)} - ${parseScale.verdict}`)

  // ---- tokenize scaling on LINE length (the O(n^2)->O(n) fix guard) ----
  const lineTok: BenchResult[] = []
  for (const n of [1000, 4000, 16000, 64000]) {
    const src = longLine(n)
    const r = bench({ name: `tokenize ${n}-char line`, run: () => void tokenize({ file: 't.tree', text: src }), iterations: iters, size: n })
    lineTok.push(r); results.push(r)
  }
  const lineScale = scaling(lineTok)
  insights.push(`tokenize vs LINE length: exponent ${lineScale.exponent.toFixed(2)} - ${lineScale.verdict} (must stay linear after the cursor fix)`)

  // ---- parse scaling on nesting depth ----
  const nestParse: BenchResult[] = []
  for (const n of [10, 40, 160]) {
    const src = deepNest(n)
    const r = bench({ name: `parse depth ${n}`, run: () => void parse({ file: 't.tree', text: src }), iterations: iters, size: n })
    nestParse.push(r); results.push(r)
  }
  const nestScale = scaling(nestParse)
  insights.push(`parse vs nesting depth: exponent ${nestScale.exponent.toFixed(2)} - ${nestScale.verdict}`)

  // ---- streaming split vs whole-file split (should be comparable) ----
  const bigSrc = manyDefs(2000)
  const wholeSplit = bench({ name: 'splitTopLevel 2000 defs', run: () => void splitTopLevel(bigSrc), iterations: iters, size: 2000 })
  const streamSplit = bench({ name: 'splitStreaming 2000 defs', run: () => void splitStreamingToArray(bigSrc.split('\n')), iterations: iters, size: 2000 })
  results.push(wholeSplit, streamSplit)
  insights.push(`streaming split overhead vs whole-file: ${(streamSplit.median / wholeSplit.median).toFixed(2)}x`)

  // ---- compile: uncached vs cached (the O1 closure-recheck cost) ----
  const cache = new CompileCache()
  const small = manyDefs(50)
  const cold = bench({ name: 'compile (cold, no cache)', run: () => void compile({ file: 'c.tree', text: small }, { resolve: input.resolve }), iterations: Math.min(iters, 10), size: 50 })
  const warm = bench({ name: 'compile (warm, shared cache)', run: () => void compile({ file: 'c.tree', text: small }, { resolve: input.resolve, cache }), iterations: Math.min(iters, 10), size: 50 })
  results.push(cold, warm)
  insights.push(`compile cache speedup (self-contained file): ${(cold.median / Math.max(warm.median, 0.001)).toFixed(2)}x`)

  // ---- import-heavy: module discovery + compile of a real stdlib file that
  // pulls in the transitive closure (guards the collectModules scan + resolver
  // memo/read-cache wins). A fresh resolver per iteration shows cold cost. ----
  const heavyFile = 'deck/base/code/native/node/environment/directory.tree'
  if (existsSync(`${input.root}/${heavyFile}`)) {
    const text = readFileSync(`${input.root}/${heavyFile}`, 'utf8')
    const discover = bench({
      name: 'collectModules (stdlib closure)',
      run: () => void collectModules({ file: heavyFile, text }, input.resolve),
      iterations: Math.min(iters, 8),
    })
    const heavyCompile = bench({
      name: 'compile import-heavy stdlib file',
      run: () => void compile({ file: heavyFile, text }, { resolve: input.resolve }),
      iterations: Math.min(iters, 8),
    })
    results.push(discover, heavyCompile)
    insights.push(`module discovery for an import-heavy file: ${discover.median.toFixed(0)}ms (closure resolved once via the resolver memo)`)
    insights.push(`import-heavy compile: ${heavyCompile.median.toFixed(0)}ms (was ~775ms before the scan + resolver-cache wins; remainder is closure type-check, the tree-shaking target)`)
  }

  return { results, insights }
}
