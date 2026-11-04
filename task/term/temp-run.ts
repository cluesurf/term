// One owned scratch folder per run of a Term harness, so nothing a run makes is left in the machine's temporary folder.
//
// On 2026-10-23 the laptop's disk filled (1.8 TB, 0 free) with tens of thousands of folders the comparison harness and
// the tests had made with mkdtemp and never removed (need-version-* 17,680, small-home-* 2,442, seed-test-* 1,942,
// about 123 GB). A pair spec or a test takes `os.tmpdir()`, which reads TMPDIR on every call, so a harness that points
// TMPDIR at a folder of its own before the spec loads, or before a suite starts, owns everything the run makes there,
// in its own process and in every child it spawns, and removes it when the run ends. term-cli-in-term-0177.
//
// The scratch folder is `<system temp>/<tag><pid>-XXXXXX`, short because a Unix socket path is limited to 104 bytes on
// macOS. A run killed past its cleanup (SIGKILL) leaves one behind, and the next run of either harness removes every
// such folder whose process is gone. The machine-wide caches a run shares with every other run (the native build caches,
// tsx's transform cache, Node's compile cache) are linked into each scratch folder, so a redirected run reads the same
// warm caches and never fills a cold copy.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

// the real temporary folder: a harness running inside another's scratch folder still links the real caches
export const SYSTEM_TEMP = process.env.TERM_SYSTEM_TEMP ?? tmpdir()

// linked when present: tsx's transform cache and Node's compile cache
const PRESENT = [`tsx-${userInfo().uid}`, 'node-compile-cache']
// made when absent, then linked: the native build caches the suites share by a fixed name (cargo targets, the Swift and
// Kotlin builds), which a cold copy per suite would rebuild for minutes
const MADE = ['term-native', 'seed-rust-runtime', 'term-host-native-target', 'term-feed-native-target', 'term-raise-bench']
const SHARED = [...PRESENT, ...MADE]
const RUN_NAME = /^t[pt](\d+)-[A-Za-z0-9]{6}$/
// what mkdtemp names: a lowercase kebab prefix and six random characters (seed-test-Ab12Cd, need-versionXy34Zw)
const MADE_NAME = /^[a-z][a-z0-9-]*[A-Za-z0-9]{6}$/

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // a child still writing: the next run's sweep removes it
  }
}

// the scratch folders of runs whose process is gone (killed past their cleanup)
export function sweepStaleRuns(): string[] {
  const swept: string[] = []

  for (const name of readdirSync(SYSTEM_TEMP)) {
    const found = RUN_NAME.exec(name)

    if (found && Number(found[1]) !== process.pid && !alive(Number(found[1]))) {
      removeTree(join(SYSTEM_TEMP, name))
      swept.push(name)
    }
  }

  return swept
}

// this process's own scratch folders still on disk: one whose removal raced a child still writing into it (a grandchild a
// suite left running). Removed again, and what still cannot be removed is returned
export function removeOwnRuns(): string[] {
  const own = (): string[] =>
    readdirSync(SYSTEM_TEMP).filter(name => RUN_NAME.exec(name)?.[1] === String(process.pid))

  for (const name of own()) {
    removeTree(join(SYSTEM_TEMP, name))
  }

  return own()
}

// a new scratch folder, `tp` for a pair run and `tt` for a gate suite, with the shared caches linked in
export function makeScratch(tag: 'tp' | 'tt'): string {
  const dir = mkdtempSync(join(SYSTEM_TEMP, `${tag}${process.pid}-`))

  for (const name of SHARED) {
    const real = join(SYSTEM_TEMP, name)

    if (MADE.includes(name)) {
      mkdirSync(real, { recursive: true })
    }

    if (existsSync(real)) {
      try {
        symlinkSync(real, join(dir, name))
      } catch {
        // already linked
      }
    }
  }

  return dir
}

// the environment that sends a process's temporary files into `dir`
export function scratchEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TMP: dir, TEMP: dir, TERM_SYSTEM_TEMP: SYSTEM_TEMP }
}

// what a run left in its scratch folder, the linked caches aside
export function leftIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => !SHARED.includes(name))
  } catch {
    return []
  }
}

// the mkdtemp-shaped entries of the real temporary folder, the harnesses' own scratch folders and the shared caches aside
export function madeEntries(): Set<string> {
  return new Set(readdirSync(SYSTEM_TEMP).filter(name => MADE_NAME.test(name) && !RUN_NAME.test(name) && !SHARED.includes(name)))
}

// the mkdtemp-shaped entries made since `before` was taken
export function madeSince(before: Set<string>): string[] {
  return [...madeEntries()].filter(name => !before.has(name)).sort()
}
