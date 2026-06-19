// Memory profiling. Runs the compiled program once in a child `node --expose-gc` process, forcing a collection
// before and after so the heap delta reflects what the program retained, not transient allocation. CPU profiling is
// intentionally not here yet (profiling the compiled artifact's hotspots is a separate, later piece).

import { compileToModule, prepareModuleDir, runNode, cleanupDir } from '@/code/time/execute'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type MemoryResult = {
  name: string
  heap_used_before_bytes: number
  heap_used_after_bytes: number
  heap_delta_bytes: number
  rss_after_bytes: number
}

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

export async function runMemoryProfile(input: { text: string; file: string; root: string; name: string }): Promise<MemoryResult> {
  const { code } = compileToModule({ text: input.text, file: input.file })
  const dir = await prepareModuleDir({ root: input.root, code, tag: 'memory' })
  try {
    await fs.writeFile(path.join(dir, 'harness.mjs'), HARNESS)
    const stdout = await runNode({ file: path.join(dir, 'harness.mjs'), cwd: dir, gc: true })
    const usage: { before: { heapUsed: number }; after: { heapUsed: number; rss: number } } = JSON.parse(stdout)
    return {
      name: input.name,
      heap_used_before_bytes: usage.before.heapUsed,
      heap_used_after_bytes: usage.after.heapUsed,
      heap_delta_bytes: usage.after.heapUsed - usage.before.heapUsed,
      rss_after_bytes: usage.after.rss,
    }
  } finally {
    await cleanupDir(dir)
  }
}

export function formatBytes(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 1024) return `${sign}${abs}B`
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KB`
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(2)}MB`
  return `${sign}${(abs / 1024 / 1024 / 1024).toFixed(2)}GB`
}

export function formatMemoryResult(result: MemoryResult): string {
  return [
    `  ${result.name}`,
    `    heap before: ${formatBytes(result.heap_used_before_bytes)}`,
    `    heap after:  ${formatBytes(result.heap_used_after_bytes)}`,
    `    retained:    ${formatBytes(result.heap_delta_bytes)}`,
    `    rss:         ${formatBytes(result.rss_after_bytes)}`,
  ].join('\n')
}
