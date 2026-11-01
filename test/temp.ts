// A test's temporary folders, removed when its process ends, however it ends: a pass, a failed check, a throw,
// process.exit, ctrl-c or SIGTERM. A test makes every temporary folder through `tempDir` (or hands one it made another
// way to `removeAtExit`), and never leaves one behind.
//
// Before 2026-10-23 the tests made theirs with mkdtemp and left them, and with the pair harness's they filled the
// laptop's disk (123 GB in the system temporary folder). The gate (task/term/test.ts) now runs each suite with TMPDIR
// pointed at a folder of its own and fails a suite that leaves anything in it (term-cli-in-term-0177).

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// the folders of `prefix` whose process is gone (killed past its exit hook, SIGKILL), removed by the next run (item 0539)
function sweepStale(prefix: string): void {
  const own = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)-[A-Za-z0-9]{6}$`)

  for (const name of readdirSync(tmpdir())) {
    const found = own.exec(name)

    if (found && Number(found[1]) !== process.pid && !alive(Number(found[1]))) {
      rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
}

// a new temporary folder `<tmpdir>/<prefix><pid>-XXXXXX`, removed when the process ends, and swept by the next run if
// this one is killed (the pid in the name says whose it was)
export function tempDir(prefix: string): string {
  try {
    sweepStale(prefix)
  } catch {
    // a sweep never fails a test
  }

  return removeAtExit(mkdtempSync(join(tmpdir(), `${prefix}${process.pid}-`)))
}
