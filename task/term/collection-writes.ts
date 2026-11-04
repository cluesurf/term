// `pnpm term:collection-writes`: every value-semantics warning (self-hosting-0026, D1, check/lost-writes.ts) in the
// stdlib and the toolchain's own .tree, each with its place, and the count. Read from `compile()` directly, because
// `term make` folds problems past its cap and its warning count undercounts. The three warnings refuse once this
// prints none.
//
// Run from the repository root: pnpm term:collection-writes

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf } from '@term/call/code/role-of'
import { declaresDraft } from '@term/call/code/draft'
import { TERM_ROOT } from './root'

const TERM = TERM_ROOT
const ROOTS: [string, string][] = [
  ['make', 'code'],
  ['deck', 'code'],
  ['flow', 'code'],
  ['scan', 'code'],
  ['test', 'code'],
  ['call', 'code'],
  ['base', 'code'],
]
const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)

    if (SKIP.has(name) || name.endsWith('-cache') || lstatSync(full).isSymbolicLink()) {
      continue
    }

    if (lstatSync(full).isDirectory()) {
      trees(full, out)
    } else if (name.endsWith('.tree') && name !== 'draft.tree') {
      out.push(full)
    }
  }
}

let files = 0
let refused = 0
const found: string[] = []

for (const [deck, sub] of ROOTS) {
  const root = join(TERM, 'deck', deck)
  const list: string[] = []
  trees(join(root, sub), list)
  const resolve = projectResolver(root)
  const leanOf = projectLeanOf(root)

  for (const file of list) {
    const text = readFileSync(file, 'utf8')

    if (declaresDraft(text)) {
      continue
    }

    files++
    const result = compile({ file, text }, { resolve, leanOf })

    if (!result.ok) {
      refused++
      continue
    }

    for (const d of result.warnings) {
      if (/under value semantics \(D1\)/.test(d.message)) {
        found.push(`${relative(TERM, d.file ?? file)}:${d.span.start.line}  ${d.message.split(':')[0]}`)
      }
    }
  }
}

for (const line of [...new Set(found)].sort()) {
  console.log(line)
}

console.log(`\n${files} files, ${refused} refused by the build, ${new Set(found).size} lost collection writes`)
