// A test's temporary folders, removed when its process ends, however it ends: a pass, a failed check, a throw,
// process.exit, ctrl-c or SIGTERM. A test makes every temporary folder through `tempDir` (or hands one it made another
// way to `removeAtExit`), and never leaves one behind.
//
// Before 2026-10-23 the tests made theirs with mkdtemp and left them, and with the pair harness's they filled the
// laptop's disk (123 GB in the system temporary folder). The gate (task/term/test.ts) now runs each suite with TMPDIR
// pointed at a folder of its own and fails a suite that leaves anything in it (term-cli-in-term-0177).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made = new Set<string>()
let hooked = false

function removeAll(): void {
  for (const dir of made) {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
    } catch {
      // a child still writing into it; the gate's own folder removal takes the rest
    }
  }

  made.clear()
}

function hook(): void {
  if (hooked) {
    return
  }

  hooked = true
  process.on('exit', removeAll)

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      removeAll()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

// a folder already made (by a library, a child process, a fixed path), removed when the process ends
export function removeAtExit(dir: string): string {
  hook()
  made.add(dir)

  return dir
}

// a new temporary folder `<tmpdir>/<prefix>XXXXXX`, removed when the process ends
export function tempDir(prefix: string): string {
  return removeAtExit(mkdtempSync(join(tmpdir(), prefix)))
}
