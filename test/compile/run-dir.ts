// A test run's own directory in the system temp, removed when the run ends, failed or not. Every native harness made
// one per run and left it behind, and by 2026-10-03 they filled the disk (268 GB in the temp, the native harnesses'
// alone about 30 GB). `TERM_KEEP_RUNS=1` keeps them, to read a failed build's sources
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made: string[] = []

if (process.env.TERM_KEEP_RUNS !== '1') {
  process.on('exit', () => {
    for (const dir of made) {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

export function runDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)

  return dir
}
