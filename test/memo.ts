// A per-item memo for the suites that check thousands of independent items (every .tree file in the tree), so a
// change to one file rechecks one file. The gate's result cache (task/term/gate/cache.ts) skips a WHOLE suite whose
// inputs did not change, and a sweep over every file has every file as an input, so one edited file anywhere reran
// all 14,394 of them: format-sweep alone was 398 seconds on 2026-10-02.
//
// An item is remembered only as a PASS, under the sha1 of the item's own input AND of every source file of the code
// that judges it (`code`, a list of directories hashed whole). A change to the item, or to any file of that code,
// is a different key, so it is checked again. A failure is never remembered. `TERM_MEMO=off` (or the gate's
// `--fresh`, which sets it) checks everything.
//
// Stored under .base/@cluesurf/term/memo/<suite>.json, rebuildable by running.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TERM = join(import.meta.dirname, '..')

function sha1(text: string | Buffer): string {
  return createHash('sha1').update(text).digest('hex')
}

// every file under the directories, path and bytes, in a stable order
function codeHash(dirs: string[]): string {
  const hash = createHash('sha1')

  const walk = (dir: string): void => {
    let entries: string[]

    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'host' || entry === '.base' || entry === 'tmp' || entry.startsWith('.')) {
        continue
      }

      const path = join(dir, entry)

      if (statSync(path).isDirectory()) {
        walk(path)
      } else {
        hash.update(path.slice(TERM.length))
        hash.update('\0')
        hash.update(readFileSync(path))
        hash.update('\0')
      }
    }
  }

  for (const dir of dirs) {
    walk(join(TERM, dir))
  }

  return hash.digest('hex')
}

export type Memo = {
  // was this item, with this input, already passed by this code?
  passed: (item: string, input: string | Buffer) => boolean
  // remember a pass
  pass: (item: string, input: string | Buffer) => void
  // write what was remembered, and say how many were answered from it
  save: () => { reused: number }
}

export function makeMemo(suite: string, code: string[]): Memo {
  const off = process.env.TERM_MEMO === 'off'
  const dir = join(TERM, '.base/@cluesurf/term/memo')
  const file = join(dir, `${suite}.json`)
  const salt = codeHash(code)
  const keyOf = (item: string, input: string | Buffer): string => sha1(`${salt}\0${item}\0${sha1(input)}`)

  let known = new Set<string>()

  if (!off && existsSync(file)) {
    try {
      known = new Set(JSON.parse(readFileSync(file, 'utf8')) as string[])
    } catch {
      known = new Set()
    }
  }

  // only the keys of THIS run are kept, so the file never grows past the items that exist
  const kept = new Set<string>()
  let reused = 0

  return {
    passed: (item, input) => {
      if (off) {
        return false
      }

      const key = keyOf(item, input)

      if (known.has(key)) {
        kept.add(key)
        reused++

        return true
      }

      return false
    },
    pass: (item, input) => {
      kept.add(keyOf(item, input))
    },
    save: () => {
      if (!off) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, JSON.stringify([...kept]))
      }

      return { reused }
    },
  }
}
