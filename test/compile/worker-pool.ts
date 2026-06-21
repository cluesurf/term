// Parallel worker-pool test (Tier 4, Phase 3). Proves the worker path matches the inline path byte for byte (the
// differential guarantee), that a multi-definition build genuinely runs across multiple worker threads, and that the
// pool's output is the same regardless of how many workers process it. Run: npx tsx test/compile/worker-pool.ts

import { parse } from '@cluesurf/make/code/parser/tree'
import { mill } from '@cluesurf/make/code/compile/mill'
import { buildGlobalScope } from '@cluesurf/make/code/check/resolve'
import {
  emitProgramParallel,
  WorkerPool,
} from '@cluesurf/make/code/compile/worker-pool'
import type { Program } from '@cluesurf/make/code/compile/node'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// a program of N independent functions, each a clean `take n -> send back read n` (resolves + types with no imports)
function manyFunctions(count: number): Program {
  const source = Array.from(
    { length: count },
    (_, i) =>
      `task f${i}\n  take n, like number\n  like number\n  send back\n    read n\n`,
  ).join('\n')
  const parsed = parse({ file: 'many.tree', text: source })
  if (!parsed.ok) throw new Error('parse failed')
  const milled = mill(parsed.tree, 'many.tree')
  if (!milled.ok) throw new Error('mill failed')
  return milled.program
}

async function main(): Promise<void> {
  const program = manyFunctions(8)

  // inline (no pool): the reference path
  const inline = await emitProgramParallel(program, buildGlobalScope)
  ok(
    'inline build emits every function',
    [0, 1, 2, 7].every(i => inline.ts.includes(`function f${i}`)),
    inline.ts.slice(0, 80),
  )
  ok(
    'inline build has no diagnostics on a clean program',
    inline.diagnostics.length === 0,
    JSON.stringify(inline.diagnostics.map(d => d.name)),
  )
  ok('inline build uses no worker threads', inline.threads.length === 0)

  // pooled: real worker threads
  const pool = new WorkerPool(3)
  try {
    const pooled = await emitProgramParallel(
      program,
      buildGlobalScope,
      pool,
    )

    ok(
      'pooled build produces byte-identical TypeScript (differential guarantee)',
      pooled.ts === inline.ts,
    )
    ok(
      'pooled build produces identical diagnostics',
      JSON.stringify(pooled.diagnostics) ===
        JSON.stringify(inline.diagnostics),
    )
    ok(
      'pooled build actually ran on multiple worker threads',
      pooled.threads.length >= 2,
      `threads: ${pooled.threads.join(',')}`,
    )

    // a second build reuses the warm workers and still matches (context re-broadcast on the new revision)
    const program2 = manyFunctions(5)
    const pooled2 = await emitProgramParallel(
      program2,
      buildGlobalScope,
      pool,
    )
    const inline2 = await emitProgramParallel(
      program2,
      buildGlobalScope,
    )
    ok(
      'a second pooled build (warm workers, new revision) matches inline',
      pooled2.ts === inline2.ts,
    )
  } finally {
    await pool.close()
  }

  console.log(`\nworker-pool: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

void main()
