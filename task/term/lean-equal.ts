// Longhand and lean compile to the same program, held over every .tree that exists (self-hosting-0013, H2 in
// note/project/term/self-host/03-lean.md).
//
// WHY A CORPUS. Lean was proven on one data DSL (the v4 grammar) and one stdlib file (`pnpm term:lean-port`). A
// compiler port is the opposite shape: deep control flow, closures, method calls, mutation. Every lean defect so far
// was found by a real file held against another implementation ("a worked example only carries the shapes its
// author thought of", lean.md), so this takes every file somebody already wrote, converts it with
// `task/term/lean-convert.ts`, and requires the two spellings to emit the same bytes.
//
// WHAT IS COMPARED. The emitted TypeScript, and with `--rust` the emitted Rust too. Spans are not compared because
// the lean file has fewer lines, so `program-json` would differ on every node; the emitted code carries no spans.
// Only the ENTRY file is converted and compiled lean: its imports stay longhand, so a difference is about the entry.
//
// WHAT A RESULT MEANS.
//   equal      the two spellings emit the same bytes
//   differ     both compile and the output differs: a lean defect, or a converter rule that is wrong
//   lean-fail  the longhand compiles and the lean does not: the same, louder
//   skip       the longhand itself does not compile here (not evidence about lean), or the file is `mark draft`
//
//   pnpm term:lean-equal                       every corpus, TypeScript only
//   pnpm term:lean-equal --rust                 also the Rust
//   pnpm term:lean-equal --only deck/call       one corpus, or any path substring
//   pnpm term:lean-equal --show 5               print the first five differences in full
//
// Reports and writes nothing. Exits 1 on any differ or lean-fail.

import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { projectResolver } from '@term/call/code/make'
import { projectRoleOf } from '@term/call/code/role-of'
import { makeParseMemo } from '@term/make/code/compile/load'
import type { CompileCache } from '@term/make/code/compile/cache'
import { projectCache } from '@term/call/code/cache-store'

// ONE PARSE MEMO FOR THE WHOLE RUN. Every file compiles its import closure twice, and without a shared memo the
// stdlib closure was re-parsed for every file: ten files a minute over the stdlib's 872. Keyed by text, so the lean
// entry file and its longhand twin never share an entry.
const parsed = makeParseMemo()

// and the project's build cache, one per package, exactly what `term make` uses, so each imported module is milled
// once rather than twice per file. Its keys carry the text and the lean flag (`#lean`, compile/compile.ts), so a
// lean entry can never be served its longhand twin's answer.
const caches = new Map<string, CompileCache>()

function cacheOf(root: string): CompileCache {
  const known = caches.get(root)

  if (known) {
    return known
  }

  const made = projectCache(root)
  caches.set(root, made)

  return made
}
import { toLean } from './lean-convert'
import { TERM_ROOT, parentPaths } from './root'

// Names the compiler derives from a SOURCE POSITION, which a lean file moves by having fewer lines. They are
// deterministic and carry no meaning, so they are compared with the position taken out: `walk-head-94-2` (a walk's
// sequence held in a local, compile/mint-bridge.ts) emits as `walkHead942`.
function positionless(text: string): string {
  return text.replace(/\bwalkHead\d+\b/g, 'walkHead#').replace(/\bwalk_head_\d+_\d+\b/g, 'walk_head_#')
}

// run from the Term root, the way every other term task is
const TERM = TERM_ROOT
const HOME = TERM_ROOT

const CORPORA = [
  join(TERM, 'deck/call/code/work'),
  ...parentPaths('deck/zone/code'),
  join(TERM, 'deck/base/code'),
  join(TERM, 'deck/face/code'),
  join(TERM, 'deck/site/code'),
  join(TERM, 'deck/make/code/term'),
]

const argv = process.argv.slice(2)
const rust = argv.includes('--rust')
const onlyAt = argv.indexOf('--only')
const only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined
const showAt = argv.indexOf('--show')
const show = showAt >= 0 ? Number(argv[showAt + 1]) : 3

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build', 'test'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return
  }

  // a draft.tree shelves its directory and everything under it
  if (existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.endsWith('-cache')) {
      continue
    }

    const full = join(dir, name)
    const stat = lstatSync(full)

    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      trees(full, out)
    } else if (name.endsWith('.tree') && name !== 'draft.tree') {
      out.push(full)
    }
  }
}

// the package a file builds in: the nearest directory above it with a deck.tree
function rootOf(file: string): string {
  let dir = dirname(file)

  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'deck.tree'))) {
      return dir
    }

    dir = dirname(dir)
  }

  return dirname(file)
}

type Emit = { ok: true; ts: string; rs?: string } | { ok: false; why: string }

function emit(file: string, text: string, root: string, lean: boolean): Emit {
  const resolve = projectResolver(root)
  const leanOf = (unit: string) => lean && unit === file
  // the role a file is read in, exactly as `term make` passes it: without it the CONTENT rule decides, and a file
  // of `host` constants whose `text <...>` lean drops reads as a data file instead of the code its role says it is
  const roleOf = projectRoleOf(root)

  try {
    const node = compile({ file, text }, { resolve, leanOf, roleOf, parsed, cache: cacheOf(root) })

    if (!node.ok) {
      return { ok: false, why: node.diagnostics.slice(0, 2).map(d => `${d.name}: ${d.message}`).join(' | ') }
    }

    if (!rust) {
      return { ok: true, ts: positionless(node.typescript) }
    }

    const native = compile({ file, text }, { resolve: projectResolver(root, 'rust'), leanOf, roleOf, env: 'rust' })

    if (!native.ok) {
      return { ok: false, why: `rust: ${native.diagnostics.slice(0, 2).map(d => `${d.name}: ${d.message}`).join(' | ')}` }
    }

    return { ok: true, ts: positionless(node.typescript), rs: positionless(emitRust(native.program)) }
  } catch (cause) {
    return { ok: false, why: `threw ${String(cause).split('\n')[0]}` }
  }
}

// the first line where two texts part, with a little context
function firstDiff(a: string, b: string): string {
  const x = a.split('\n')
  const y = b.split('\n')

  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      return `line ${i + 1}\n      long: ${(x[i] ?? '<end>').slice(0, 150)}\n      lean: ${(y[i] ?? '<end>').slice(0, 150)}`
    }
  }

  return 'identical'
}

function main(): void {
  const files: string[] = []

  for (const corpus of CORPORA) {
    trees(corpus, files)
  }

  const chosen = only ? files.filter(file => file.includes(only)) : files
  const tally = { equal: 0, differ: 0, leanFail: 0, skip: 0, untouched: 0 }
  const bad: string[] = []

  console.log(`term lean-equal: ${chosen.length} files, TypeScript${rust ? ' and Rust' : ''}`)

  let at = 0

  for (const file of chosen) {
    at++
    const started = Date.now()
    const text = readFileSync(file, 'utf8')

    // progress on stderr, one line a file, so a long run shows where it is and a file that hangs names itself
    process.stderr.write(`  [${at}/${chosen.length}] ${relative(HOME, file)}\n`)

    const slow = (): void => {
      const took = Date.now() - started

      if (took > 30_000) {
        bad.push(`  SLOW ${relative(HOME, file)} took ${Math.round(took / 1000)}s`)
      }
    }

    if (/^(mark|note) draft\s*$/m.test(text.slice(0, 2000))) {
      tally.skip++
      continue
    }

    const converted = toLean({ file, text })

    if (!converted.ok) {
      tally.skip++
      continue
    }

    if (Object.values(converted.count).every(n => n === 0)) {
      tally.untouched++
      continue
    }

    const root = rootOf(file)
    const long = emit(file, text, root, false)

    if (!long.ok) {
      tally.skip++
      continue
    }

    const lean = emit(file, converted.text, root, true)
    const name = relative(HOME, file)

    slow()

    if (!lean.ok) {
      tally.leanFail++
      bad.push(`  LEAN-FAIL ${name}\n      ${lean.why.slice(0, 300)}`)
      continue
    }

    if (lean.ts !== long.ts) {
      tally.differ++
      bad.push(`  DIFFER ts ${name}\n      ${firstDiff(long.ts, lean.ts)}`)
      continue
    }

    if (rust && lean.rs !== long.rs) {
      tally.differ++
      bad.push(`  DIFFER rs ${name}\n      ${firstDiff(long.rs ?? '', lean.rs ?? '')}`)
      continue
    }

    tally.equal++
  }

  console.log('')

  for (const line of bad.slice(0, show)) {
    console.log(line)
  }

  if (bad.length > show) {
    console.log(`  ... and ${bad.length - show} more (--show <n>)`)
  }

  console.log('')
  console.log(
    `term lean-equal: ${tally.equal} equal, ${tally.differ} differ, ${tally.leanFail} lean-fail, ${tally.untouched} nothing to convert, ${tally.skip} skipped`,
  )

  if (tally.differ + tally.leanFail > 0) {
    process.exitCode = 1
  }
}

main()
