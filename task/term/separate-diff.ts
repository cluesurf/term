// The separate build against the merged build, file by file (`pnpm term:separate-diff`).
//
// `term make` compiles one unit at a time (deck/make/code/compile/separate.ts), each module checked against the STUBS
// of what it loads, and `term make --merged` compiles each file with everything it loads. The two must agree on what
// every file builds and refuses: a stub that leaves out something a whole-program analysis reads of a body makes the
// separate build refuse, or allow, what the merged one does not, and nothing else notices. Every disagreement this
// found on 2026-10-05 was one of those (note/project/term/compiler/incremental-compilation.md, "What a stub carries").
//
// Compiles every file of each package both ways, each path with its own disk cache under tmp/, cold and then warm,
// and prints the time of each, the count that agree, and every file that does not with both answers. Exit 1 on any
// disagreement. A data file, stylesheet or mill definition goes through `compile` on both paths, as `term make` sends
// it.
//
//   pnpm term:separate-diff                   every package below
//   pnpm term:separate-diff deck/zone         the packages named, relative to the repository root
//
// Reads every file of a package and writes nothing outside tmp/.

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { compile, isLookStylesheet } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import type { UnitMemo } from '@term/make/code/compile/separate'
import { isDataFile } from '@term/make/code/compile/host'
import { makeParseMemo } from '@term/make/code/compile/load'
import { buildable, findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectCache } from '@term/call/code/cache-store'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { COMPILE_PACKAGES } from './gate/compile-packages'
import { TERM_ROOT } from './root'

// run from the Term root, where the `@term/*` paths resolve (the pnpm alias and the gate both start there)
const REPO = TERM_ROOT

// A leg of the gate (task/term/test.ts) is one package, or one shard of one: SEPARATE_DIFF_PACKAGE names the package,
// SEPARATE_DIFF_SHARD `k/n` keeps every n-th file from the k-th of its sorted list. One process over every package
// was killed at the gate's 3600s twice on 2026-10-20 and 21, @term/bind still running after 40 minutes of it
const named = process.argv.slice(2)
const packages = named.length ? named : process.env.SEPARATE_DIFF_PACKAGE ? [process.env.SEPARATE_DIFF_PACKAGE] : COMPILE_PACKAGES
const [shardAt, shardOf] = (process.env.SEPARATE_DIFF_SHARD ?? '0/1').split('/').map(Number) as [number, number]
const scratch = path.join(REPO, 'tmp', 'separate-diff')

mkdirSync(scratch, { recursive: true })

type Answer = {
  ok: boolean
  diagnostics?: { message: string; file?: string }[]
  warnings?: { message: string; file?: string; name?: string }[]
}

// a file's errors, or when it builds, the warnings `term make` prints for it: its own file's, as compileProject
// filters them. Warnings differed by 549 on @term/bind while every error agreed, which an error-only diff cannot see
const answerOf = (file: string, run: () => Answer): string[] => {
  try {
    const r = run()
    const said = r.ok
      ? (r.warnings ?? []).filter(w => w.file === file).map(w => `warning ${w.message.slice(0, 160)}`)
      : (r.diagnostics ?? []).map(d => `${path.basename(d.file ?? '')}: ${d.message.slice(0, 160)}`)

    return [...new Set(said)].sort()
  } catch (error) {
    return [`CRASH ${String((error as Error).stack ?? error).split('\n').slice(0, 3).join(' | ')}`]
  }
}

let disagreeing = 0
let agreeing = 0

for (const pkg of packages) {
  const root = path.resolve(REPO, pkg)
  const resolve = projectResolver(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)

  const whole = (file: string, text: string): boolean => {
    const role = roleOf(file)

    return role === 'mill' || role === 'host' || (!role && isDataFile({ file, text })) || isLookStylesheet({ file, text })
  }

  const sources = [...findTreeFiles(root, [], 'node')]
    .sort()
    .filter((_, i) => i % shardOf === shardAt)
    .flatMap(file => {
      const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

      return 'faults' in unit || roleOf(file) === 'mill' ? [] : [{ file, text: unit.text }]
    })

  // cold, then warm with the disk cache full and nothing in memory, as a second `term make` sees it
  const time = (make: () => () => Map<string, string[]>): { answers: Map<string, string[]>; cold: number; warm: number } => {
    let started = Date.now()
    const answers = make()()
    const cold = Date.now() - started
    started = Date.now()
    make()()

    return { answers, cold, warm: Date.now() - started }
  }

  const mergedDir = mkdtempSync(path.join(scratch, 'merged-'))
  const separateDir = mkdtempSync(path.join(scratch, 'separate-'))

  const merged = time(() => {
    const cache = projectCache(mergedDir)
    const parsed = makeParseMemo()

    return () => new Map(sources.map(s => [s.file, answerOf(s.file, () => compile(s, { resolve, cache, parsed, deckOf, roleOf, leanOf }))]))
  })

  const separate = time(() => {
    const cache = projectCache(separateDir)
    const parsed = makeParseMemo()
    const units: UnitMemo = new Map()

    return () =>
      new Map(
        sources.map(s => [
          s.file,
          answerOf(s.file, () =>
            whole(s.file, s.text)
              ? compile(s, { resolve, cache, parsed, deckOf, roleOf, leanOf })
              : compileSeparate(s, { resolve, cache, parsed, units, deckOf, modules: f => `./${path.basename(f)}`, roleOf, leanOf }),
          ),
        ]),
      )
  })

  const differ = sources.filter(({ file }) => JSON.stringify(merged.answers.get(file)) !== JSON.stringify(separate.answers.get(file)))

  console.log(`${pkg}${shardOf > 1 ? ` shard ${shardAt}/${shardOf}` : ''}`)
  console.log(`  merged    cold ${String(merged.cold).padStart(7)} ms   warm ${String(merged.warm).padStart(7)} ms`)
  console.log(`  separate  cold ${String(separate.cold).padStart(7)} ms   warm ${String(separate.warm).padStart(7)} ms`)
  console.log(`  ${sources.length - differ.length} of ${sources.length} agree`)

  for (const { file } of differ) {
    const a = merged.answers.get(file)!
    const b = separate.answers.get(file)!

    // only the lines one side says and the other does not: a file of @term/bind carries dozens of warnings both agree on
    const onlyMerged = a.filter(line => !b.includes(line))
    const onlySeparate = b.filter(line => !a.includes(line))

    console.log(`  ${path.relative(root, file)}`)
    console.log(`    merged only:   ${onlyMerged.length ? onlyMerged.join('\n                   ') : (a.length ? 'nothing' : 'ok')}`)
    console.log(`    separate only: ${onlySeparate.length ? onlySeparate.join('\n                   ') : (b.length ? 'nothing' : 'ok')}`)
  }

  disagreeing += differ.length
  agreeing += sources.length - differ.length
}

// the gate's summary line (task/term/test.ts): a file that agrees passes
console.log(`\nseparate-diff: ${agreeing} pass, ${disagreeing} fail`)
process.exit(disagreeing === 0 ? 0 : 1)
