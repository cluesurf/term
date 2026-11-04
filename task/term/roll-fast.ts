// The fast roll against the full one, file by file (`pnpm term:roll-fast`, note/project/term/incremental-best-in-class.md,
// step 5).
//
// `term make` writes host/roll.json from a roll of every entry, read off the entry's whole program. Compiled in full,
// that program goes through the kernel, the provers and every pass after them, none of which the roll reads, and on
// a cold @term/bind that was most of the build. `rollFast` (compile/compile.ts) builds the roll once the program is
// typed and its async tasks are resolved, and only for an entry the build already knows builds. That is safe exactly
// while no pass it skips changes anything the roll reads, which nothing but this comparison can show: for every file
// that builds, the two rolls must be the same JSON. Exit 1 on any difference, naming the file and the first line
// that differs.
//
//   pnpm term:roll-fast                    every package below
//   pnpm term:roll-fast deck/zone          the packages named, relative to the repository root
//
// Writes nothing.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { makeParseMemo } from '@term/make/code/compile/load'
import { CompileCache } from '@term/make/code/compile/cache'
import { buildable, findTreeFiles, isWholeFile, projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { COMPILE_PACKAGES } from './gate/compile-packages'
import { TERM_ROOT } from './root'

// run from the Term root, where the `@term/*` paths resolve (the pnpm alias and the gate both start there)
const REPO = TERM_ROOT

// A leg of the gate (task/term/test.ts) is one package, or one shard of one: ROLL_FAST_PACKAGE names the package,
// ROLL_FAST_SHARD `k/n` keeps every n-th file from the k-th of its sorted list. One process over every package was
// killed at the gate's 3600s twice on 2026-10-20 and 21
const named = process.argv.slice(2)
const packages = named.length ? named : process.env.ROLL_FAST_PACKAGE ? [process.env.ROLL_FAST_PACKAGE] : COMPILE_PACKAGES
const [shardAt, shardOf] = (process.env.ROLL_FAST_SHARD ?? '0/1').split('/').map(Number) as [number, number]

let same = 0
let differ = 0

for (const pkg of packages) {
  const root = path.resolve(REPO, pkg)
  const resolve = projectResolver(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  const parsed = makeParseMemo()
  // one memory cache for the package: its mills are shared by both compiles, its outputs keyed apart
  const cache = new CompileCache()
  let built = 0
  let agree = 0

  for (const file of [...findTreeFiles(root, [], 'node')].sort().filter((_, i) => i % shardOf === shardAt)) {
    const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

    if ('faults' in unit || isWholeFile(file, unit.text, roleOf(file))) {
      continue
    }

    const source = { file, text: unit.text }
    const options = { resolve, cache, parsed, deckOf, roleOf, leanOf, roll: true, rollOnly: true }
    const full = compile(source, options)

    // only an entry that builds is ever asked for its fast roll
    if (!full.ok) {
      continue
    }

    built++

    const fast = compile(source, { ...options, rollFast: true })
    const a = JSON.stringify(full.roll, null, 1)
    const b = fast.ok ? JSON.stringify(fast.roll, null, 1) : `failed: ${fast.diagnostics.map(d => d.message).join(' | ')}`

    if (a === b) {
      agree++
      continue
    }

    const lines = [a.split('\n'), b.split('\n')]
    const at = lines[0]!.findIndex((line, i) => line !== lines[1]![i])
    console.log(`  ${path.relative(root, file)}: line ${at + 1}`)
    console.log(`    full: ${lines[0]![at] ?? '(missing)'}`)
    console.log(`    fast: ${lines[1]![at] ?? '(missing)'}`)
  }

  console.log(`${pkg}${shardOf > 1 ? ` shard ${shardAt}/${shardOf}` : ''}: ${agree} of ${built} rolls the same`)
  same += agree
  differ += built - agree
}

// the gate's summary line (task/term/test.ts)
console.log(`\nroll-fast: ${same} pass, ${differ} fail`)
process.exit(differ === 0 ? 0 : 1)
