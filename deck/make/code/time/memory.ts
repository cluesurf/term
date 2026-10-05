import type { Resolver } from '@term/make/code/compile/load'
// Memory profiling. Runs the compiled program once in a child `node --expose-gc` process, each `time-*` task once,
// forcing a collection before and after so the heap delta reflects what the program retained, not transient
// allocation. CPU profiling is time/cpu.ts.
//
// The result and the report are Term, time/profile.tree (self-hosting, 2026-10-04). This file is the process work.

import {
  prepareModuleDir,
  runNode,
  cleanupDir,
} from '@term/make/code/time/execute'
import { compileBenchmarks } from '@term/make/code/time/runner'
import { formatBytes, formatMemoryResult, makeMemoryResult } from '@term/make/code/time/profile'
import type { MemoryResult } from '@term/make/code/time/profile'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export { formatBytes, formatMemoryResult }
export type { MemoryResult }

// the module is loaded and each `time-*` task run once, between two collections, so the delta is what loading and
// running the program kept. It only loaded the module, the way `--cpu` only did (guides: commands/time)
function harness(entries: string[]): string {
  return `async function main() {
  if (typeof global.gc === 'function') global.gc()
  const before = process.memoryUsage()
  const M = await import('./module.mjs')
  for (const entry of ${JSON.stringify(entries)}) {
    if (typeof M[entry] === 'function') await M[entry]()
  }
  if (typeof global.gc === 'function') global.gc()
  const after = process.memoryUsage()
  process.stdout.write(JSON.stringify({ before, after }))
}
main().catch((e) => { console.error(e); process.exit(1) })
`
}

export async function runMemoryProfile(input: {
  text: string
  file: string
  // the project resolver, so an entry with imports compiles the way `term make` compiles it
  resolve?: Resolver
  root: string
  name: string
}): Promise<MemoryResult> {
  const { code, benchmarks } = compileBenchmarks({
    text: input.text,
    file: input.file,
    resolve: input.resolve,
  })

  const dir = await prepareModuleDir({
    root: input.root,
    code,
    tag: 'memory',
  })

  try {
    await fs.writeFile(path.join(dir, 'harness.mjs'), harness(benchmarks.map(one => one.entry)))

    const stdout = await runNode({
      file: path.join(dir, 'harness.mjs'),
      cwd: dir,
      gc: true,
    })

    const usage: {
      before: { heapUsed: number }
      after: { heapUsed: number; rss: number }
    } = JSON.parse(stdout)

    return makeMemoryResult(input.name, usage.before.heapUsed, usage.after.heapUsed, usage.after.rss)
  } finally {
    await cleanupDir(dir)
  }
}
