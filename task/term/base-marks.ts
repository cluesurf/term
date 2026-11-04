// Does every live public module of @term/base say whether v1 promises it? Each one carries `mark stable` or
// `mark unstable` near its top (`note stable` / `note unstable`, the old spelling, still count) (note/project/term/stdlib/v1-release.md, "The cut"). Live means under deck/base/code, not under
// native/ (internal), hold/ or proof/, not empty, and not shelved by `mark draft` or a `draft.tree`. Prints each module
// without a mark and the two counts; exits 1 when any module is unmarked. Reads only. `pnpm term:base-marks`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT } from './root'

const here = dirname(fileURLToPath(import.meta.url))
const code = join(TERM_ROOT, 'deck/base/code')
const skipped = new Set(['native', 'hold', 'proof', '.build', 'node_modules'])

function shelvedDirectory(dir: string): boolean {
  for (let at = dir; at.startsWith(code); at = dirname(at)) {
    if (existsSync(join(at, 'draft.tree'))) {
      return true
    }
  }

  return false
}

function walk(dir: string, into: string[] = []): string[] {
  if (shelvedDirectory(dir)) {
    return into
  }

  for (const name of readdirSync(dir)) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      if (!skipped.has(name)) {
        walk(path, into)
      }
    } else if (name.endsWith('.tree') && name !== 'draft.tree') {
      into.push(path)
    }
  }

  return into
}

let stable = 0
let unstable = 0
const unmarked: string[] = []

for (const file of walk(code).sort()) {
  const text = readFileSync(file, 'utf8')

  if (!text.trim() || /^(mark|note) draft\s*$/m.test(text)) {
    continue
  }

  const head = text.split('\n').slice(0, 60)

  // `mark stable` is the spelling, `note stable` the old one, and both count
  if (head.includes('mark stable') || head.includes('note stable')) {
    stable++
  } else if (head.includes('mark unstable') || head.includes('note unstable')) {
    unstable++
  } else {
    unmarked.push(relative(code, file))
  }
}

for (const file of unmarked) {
  console.log(`unmarked  ${file}`)
}

console.log(`base-marks: ${stable} stable, ${unstable} unstable, ${unmarked.length} unmarked`)
process.exit(unmarked.length > 0 ? 1 : 0)
