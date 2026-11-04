// What `generalize` costs inside inference (`pnpm term:generalize-bench`).
//
// `generalize` (deck/make/code/check/scheme.tree) quantifies the variables free in a binding's type and not free in the
// environment, and finds the second set by walking EVERY scheme in the environment, at every generalized `save` or
// `host`. OCaml avoids the walk with levels (Remy): each variable carries the `let` depth it was made at, and a variable
// deeper than the current one is generalizable without looking at the environment at all. The inference guide named
// the walk as unmeasured (guides/architecture/types/inference, "What is missing"), and decisions-2026-10.md, D10, asks
// for the measurement before any levels are written.
//
// Compiles every file of each package the way `term make --merged` does, with inference profiled
// (check/infer.ts `setInferProfile`), and prints per package: the time inside `check`, the generalizes, their time and
// share of `check`, and the environment entries the average one walked.
//
//   pnpm term:generalize-bench                    the packages below
//   pnpm term:generalize-bench deck/zone          the packages named, relative to the repository root
//
// Writes nothing.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { makeParseMemo } from '@term/make/code/compile/load'
import { setInferProfile } from '@term/make/code/check/infer'
import type { InferProfile } from '@term/make/code/check/infer'
import { buildable, findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { TERM_ROOT, parentPaths } from './root'

// run from the Term root, where the `@term/*` paths resolve
const REPO = TERM_ROOT
const TERM = 'deck'

const PACKAGES = [`${TERM}/base`, `${TERM}/make`, `${TERM}/call`, `${TERM}/site`, ...parentPaths('deck/zone')]

const named = process.argv.slice(2)
const packages = named.length ? named : PACKAGES

const rows: string[][] = [['package', 'files', 'check ms', 'generalizes', 'generalize ms', 'share', 'walked each']]
const total: InferProfile = { checks: 0, checkMs: 0, generalizes: 0, generalizeMs: 0, walked: 0 }

for (const pkg of packages) {
  const root = path.resolve(REPO, pkg)
  const resolve = projectResolver(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  const parsed = makeParseMemo()

  const sources = findTreeFiles(root, [], 'node').flatMap(file => {
    const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

    return 'faults' in unit || roleOf(file) === 'mill' ? [] : [{ file, text: unit.text }]
  })

  const profile: InferProfile = { checks: 0, checkMs: 0, generalizes: 0, generalizeMs: 0, walked: 0 }
  setInferProfile(profile)

  for (const source of sources) {
    try {
      compile(source, { resolve, parsed, deckOf, roleOf, leanOf })
    } catch {
      // a file that crashes the compiler is the gate's to report, not this measurement's
    }
  }

  setInferProfile(undefined)

  for (const key of Object.keys(total) as (keyof InferProfile)[]) {
    total[key] += profile[key]
  }

  rows.push(row(pkg.replace(`${TERM}/`, ''), sources.length, profile))
}

rows.push(row('all', rows.slice(1).reduce((sum, r) => sum + Number(r[1]), 0), total))

function row(name: string, files: number, p: InferProfile): string[] {
  return [
    name,
    String(files),
    p.checkMs.toFixed(0),
    String(p.generalizes),
    p.generalizeMs.toFixed(1),
    p.checkMs > 0 ? `${((p.generalizeMs / p.checkMs) * 100).toFixed(2)}%` : '0%',
    p.generalizes > 0 ? (p.walked / p.generalizes).toFixed(0) : '0',
  ]
}

const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))

for (const r of rows) {
  console.log(r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  '))
}
