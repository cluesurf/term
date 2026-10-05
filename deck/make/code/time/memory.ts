import type { Resolver } from '@term/make/code/compile/load'
// Memory profiling. Runs the compiled program once in a child `node --expose-gc` process, forcing a collection
// before and after so the heap delta reflects what the program retained, not transient allocation. CPU profiling is
// intentionally not here yet (profiling the compiled artifact's hotspots is a separate, later piece).
//
// The result and the report are Term, time/profile.tree (self-hosting, 2026-10-04). This file is the process work.

import {
  compileToModule,
  prepareModuleDir,
  runNode,
  cleanupDir,
} from '@term/make/code/time/execute'
import { formatBytes, formatMemoryResult, makeMemoryResult } from '@term/make/code/time/profile'
import type { MemoryResult } from '@term/make/code/time/profile'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export { formatBytes, formatMemoryResult }
export type { MemoryResult }

const HARNESS = `async function main() {
  if (typeof global.gc === 'function') global.gc()
  const before = process.memoryUsage()
  await import('./module.mjs')
  if (typeof global.gc === 'function') global.gc()
  const after = process.memoryUsage()
  process.stdout.write(JSON.stringify({ before, after }))
}
main().catch((e) => { console.error(e); process.exit(1) })
`

export async function runMemoryProfile(input: {
  text: string
  file: string
  // the project resolver, so an entry with imports compiles the way `term make` compiles it
  resolve?: Resolver
  root: string
  name: string
}): Promise<MemoryResult> {
  const { code } = compileToModule({
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
    await fs.writeFile(path.join(dir, 'harness.mjs'), HARNESS)

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
