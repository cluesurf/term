// A hold on a device the whole machine sees (beat-term spec.md 4 D017, traps.md#t008). The simulator, the emulator and
// the Mac's pasteboard are each one shared thing: two jobs on one of them terminate each other's apps or overwrite each
// other's token. The hold is a folder, `<home>/<device>/`, made with `mkdirSync` (atomic: the process that makes it holds
// it) and holding `owner.json`. A holder whose process is gone holds nothing.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Device = 'simulator' | 'emulator' | 'pasteboard'

type Owner = { pid: number, who: string, since: string }

// a lock folder with no owner.json is a taker that died between `mkdir` and the write once it is this old
const ORPHAN_MS = 10_000

// never the OS temporary folder: a Claude session's TMPDIR differs from another's
function home(): string {
  return process.env.TERM_HOLD_HOME ?? join(homedir(), '.base', 'hold')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // EPERM: the process is alive and someone else's, which is a live holder
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function readOwner(dir: string): Owner | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as Partial<Owner>

    if (typeof owner.pid === 'number' && typeof owner.who === 'string' && typeof owner.since === 'string') {
      return { pid: owner.pid, who: owner.who, since: owner.since }
    }
  } catch {
    // no owner.json yet, or half written
  }

  return undefined
}

// who holds `device` now; a holder whose process is gone holds nothing
export function holderOf(device: Device): { pid: number, who: string, since: string } | undefined {
  const owner = readOwner(join(home(), device))

  return owner && alive(owner.pid) ? owner : undefined
}

// true when the folder is a lock nobody holds: its owner's process is gone, or it never got an owner.json and is old
function stale(dir: string): boolean {
  const owner = readOwner(dir)

  if (owner) {
    return !alive(owner.pid)
  }

  try {
    return Date.now() - statSync(dir).mtimeMs > ORPHAN_MS
  } catch {
    return false
  }
}

// a rename is atomic, so of two takers that find the same stale lock one wins. The loser's rename throws ENOENT
function clearStale(dir: string): void {
  const judged = readOwner(dir)
  const moved = `${dir}.stale-${judged?.pid ?? 0}-${Date.now()}`

  try {
    renameSync(dir, moved)
  } catch {
    return
  }

  // the lock was taken again between the judgment and the rename: what was moved is a live holder's, so put it back
  const now = readOwner(moved)

  if (now && now.pid !== judged?.pid && alive(now.pid)) {
    try {
      renameSync(moved, dir)
    } catch {
      // someone made a new lock already: the holder lost its folder, and its release finds none
    }

    return
  }

  rmSync(moved, { recursive: true, force: true })
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// The one lock routine both doors drive. It does every step they share (the TERM_HELD answer, the home folder, the
// `mkdirSync` attempt, stale and orphan clearing, the waiting line said once, `owner.json`, the release) and yields
// whenever it must pause one second before trying again. The door decides what a pause is (a timer awaited, or an
// `Atomics.wait`) and whether the release also hangs on SIGINT and SIGTERM (`signals`).
function* lock(device: Device, who: string, signals: boolean): Generator<void, () => void, void> {
  const inherited = (process.env.TERM_HELD ?? '').split(',').map(name => name.trim())

  if (inherited.includes(device)) {
    return () => {}
  }

  const base = home()
  const dir = join(base, device)
  let told = false

  mkdirSync(base, { recursive: true })

  for (;;) {
    try {
      mkdirSync(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      if (stale(dir)) {
        clearStale(dir)

        continue
      }

      if (!told) {
        const holder = holderOf(device)

        // writeSync, so the line shows at once even while the thread is blocked
        try {
          writeSync(2, `hold  ${device} is held by ${holder ? `${holder.who} (pid ${holder.pid}, since ${holder.since})` : 'another process'}, waiting\n`)
        } catch {
          // a full non-blocking pipe (EAGAIN): the line is only information, the wait goes on
        }

        told = true
      }

      yield

      continue
    }

    break
  }

  const owner: Owner = { pid: process.pid, who, since: new Date().toISOString() }
  const written = join(dir, `owner.json.${process.pid}`)

  // written whole, then renamed in: a reader never sees half of it
  writeFileSync(written, `${JSON.stringify(owner)}\n`)
  renameSync(written, join(dir, 'owner.json'))

  let released = false

  const onSignal = (signal: NodeJS.Signals): void => {
    release()
    // the exit code stays a signal's: with this listener gone, the signal takes its default action
    process.kill(process.pid, signal)
  }
  const onInt = (): void => onSignal('SIGINT')
  const onTerm = (): void => onSignal('SIGTERM')
  const onExit = (): void => release()

  // removes the folder only when its owner.json still names this process
  function release(): void {
    if (released) {
      return
    }

    released = true
    process.removeListener('exit', onExit)
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)

    if (readOwner(dir)?.pid === process.pid) {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  process.on('exit', onExit)

  if (signals) {
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
  }

  return release
}

// takes the machine-wide hold on `device` for this process, waiting while another live process holds it (it says
// once who holds it, then checks again every second), and answers the release. A device named in TERM_HELD (a
// comma-separated list) is held by an ancestor process: the answer is a release that does nothing, at once
export async function holdDevice(device: Device, who: string): Promise<() => void> {
  const steps = lock(device, who, true)

  for (;;) {
    const step = steps.next()

    if (step.done) {
      return step.value
    }

    await pause(1000)
  }
}

// the same hold as holdDevice, for a process whose work under the hold is synchronous (spawnSync, execFileSync,
// beat-term D024): it waits with Atomics.wait, and releases on exit only, never from a signal listener, so a SIGINT
// or SIGTERM ends the process at once and the next taker clears the folder its dead pid left
export function holdDeviceSync(device: Device, who: string): () => void {
  const steps = lock(device, who, false)

  for (;;) {
    const step = steps.next()

    if (step.done) {
      return step.value
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
}
