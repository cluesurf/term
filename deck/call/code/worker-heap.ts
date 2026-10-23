// THE HEAP ONE BUILD WORKER MAY HOLD (note/project/term/compiler/decision/005-prover-memory-bounded-by-problem.md).
//
// A `worker_threads` worker shares the process's address space but not its heap limit: without `resourceLimits` a
// worker that keeps growing takes the whole process down with it (V8's fatal "heap out of memory", exit 134), and
// every other unit of the build is lost. With a limit, V8 ends only that worker, the pool sees
// ERR_WORKER_OUT_OF_MEMORY, and the unit it held is reported as `out-of-memory` while the rest builds.
//
// `TERM_WORKER_HEAP_MB` sets the limit outright. Otherwise three quarters of the machine's memory is shared between
// the workers, never under 2048 MB, so a pool of eight on a 48 GB machine gives each 4.5 GB.

import { totalmem } from 'node:os'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'

const FLOOR_MB = 2048
const SHARE = 0.75

export function workerHeapMb(workers: number): number {
  const given = Number(process.env.TERM_WORKER_HEAP_MB)

  if (Number.isFinite(given) && given > 0) {
    return Math.floor(given)
  }

  return Math.max(FLOOR_MB, Math.floor((totalmem() * SHARE) / Math.max(1, workers) / (1024 * 1024)))
}

// a worker's death by its heap limit, told apart from any other crash
export function isOutOfMemory(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY'
  )
}

// the one diagnostic an out-of-memory unit is reported by, framed at the top of its file
export function outOfMemoryDiagnostic(file: string, limitMb: number): Diagnostic {
  const span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }

  return {
    code: 0,
    name: 'out-of-memory',
    message: `the build worker compiling this file ran out of memory at its ${limitMb} MB heap limit`,
    file,
    span,
    markers: [{ span }],
    hint: 'raise TERM_WORKER_HEAP_MB, or split the file\'s rules',
    severity: 'error',
  }
}
