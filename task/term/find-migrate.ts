// Every reference the scope census counts as unimported gets the `find` that names what it already binds to
// (`pnpm term:find-migrate`, term-module-scope-0004, decision 001 of note/project/term/module-scope), so the census can
// reach zero before the checker refuses an unimported name (module-scope-0006).
//
//   load ../compile/node                load ../compile/node
//     find type                           find type
//                                         find statement
//
// THE REFERENCES are the census's own (check/census.tree through task/term/scope-census.ts `packageCensus`), never a
// second walk. THE DEFINER is the one the compiler's fallback binds today, asked of the compiler, never guessed from
// names: for each definer the census lists, the file is given a `find` of the name from that definer and compiled; the
// definer kept is the one, and only one, under which the file's TypeScript and Rust are what they were. A definition
// split by file emits under its own name (`name__in<g>_<k>`), so an identical emit is an identical binding. A
// reference that no definer, or more than one, keeps identical (the checker's choice by type among several, or a
// definer the file's own build does not reach) is not written: it is listed for a person.
//
// THE FIND goes under the file's own `load` of the definer's module when it has one, else under a new `load` after its
// last one: the module's path relative to the file inside one package, the short package path across packages, each
// proven to resolve to the definer before it is written.
//
// THE PROOF, per file, before anything is written: the whole rewrite builds to the same TypeScript AND Rust as the
// file did (a file that does not build for Rust compares its failure, on both sides), byte for byte apart from the
// names the compiler derives from a source line (`walkHead<n>`), which the added lines move.
//
// A HOST DESCRIPTION (@term/bind, decision 002 of note/project/term/module-scope) is proven differently, because there
// the build binds an unimported type to NOTHING (an unknown type is a warning and is erased), so a right find MUST change
// the emitted type. Whether a package is one is asked of the compiler (`describesHost`: a probe file with an unknown
// type builds with a warning only under that deck), never copied from compile.ts. Each file is compiled as `term make`
// compiles it (one unit, compileSeparate, with `deckOf`), and a find is accepted when (rule 1): the file builds after;
// its own diagnostics after are its diagnostics before minus exactly the `unknown-name` warnings naming the found names,
// with nothing new; and its OWN module's TypeScript (what host/.unit/ holds, not the merged emit, which also carries
// every module a new load reaches) with the types stripped (typescript `transpileModule`) is identical through
// `positionless`. The definer
// of a name with several is the one in the file's own platform tree (the first folder under bind/code/), else
// bind/code/shared/, else outside bind (rule 2); still several, listed for a hand.
//
//   pnpm term:find-migrate                          report every package
//   pnpm term:find-migrate --only base,site         some packages (folder names under deck)
//   pnpm term:find-migrate --commit                 write each file whose proof holds
//   pnpm term:find-migrate --only bind --repair-bear
//        first the stale `bear` lines (rule 3): each path that resolves to nothing, rewritten to the one existing
//        module its tail names, proven on the bear file and every file that loads it. Without --commit the find pass
//        then runs over the repaired texts, held in memory. With --commit it writes the repairs and stops, so the
//        census of the next run reads the repaired chains. A dry run journals each bear verdict in
//        tmp/scope/bear-journal-<package>.jsonl and a later dry run resumes from it (a --commit run proves all again)
//   pnpm term:find-migrate --prove <file>           a host-description file written by hand, held by rule 1 against
//                                                   the copy saved before the first write (tmp/scope/bind-before/)
//
// Before a host-description file is written, its text is saved to tmp/scope/bind-before/<package>/<path>, never over a
// different saved copy.
//
// Run from the Term root, where the `@term/*` paths resolve.

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { compileSeparate } from '@term/make/code/compile/separate'
import type { UnitMemo } from '@term/make/code/compile/separate'
import { makeParseMemo } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import type { Resolver } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import type { Unimported } from '@term/make/code/check/scope-census'
import { DECKS, REPO, TERM, packageCensus } from './scope-census'
import { PARENT_ROOT, parentRoot } from './root'

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const repairBear = argv.includes('--repair-bear')
const onlyAt = argv.indexOf('--only')
const only = onlyAt >= 0 ? argv[onlyAt + 1]!.split(',') : undefined
const proveAt = argv.indexOf('--prove')
const proveFile = proveAt >= 0 ? argv[proveAt + 1] : undefined

// the saved text of each host-description file before its first write, read back by --prove
const BEFORE = path.join(TERM, 'tmp/scope/bind-before')

// ---- locks ----

// read on the first ask, never at import, so importing this module needs no parent. A --commit run needs the parent's
// lock table (it must not write a file another session owns) and exits 2 without it. A report run without the parent
// reads no locks
let locked: string[] | undefined

function lockedPaths(): string[] {
  if (locked === undefined) {
    const parent = commit ? parentRoot() : PARENT_ROOT
    const table = parent === undefined ? undefined : path.join(parent, 'note/project/workflow/locks.json')
    const locks = table !== undefined && existsSync(table)
      ? ((JSON.parse(readFileSync(table, 'utf8')) as { lock?: { path: string; mode?: string }[] }).lock ?? [])
      : []

    locked = locks.filter(lock => lock.mode === 'owned').map(lock => lock.path)
  }

  return locked
}

const isLocked = (where: string): boolean => lockedPaths().some(prefix => where === prefix || where.startsWith(prefix))

// ---- compiling ----

// above the default cap: bind's closures reach thousands of modules, and a memo that evicts re-parses them every compile
const parsed = makeParseMemo(50_000)
const deckOf = projectDeckOf()
// the unit answers of the run, the oldest dropped past a cap: a whole bind run's answers do not fit in memory
class BoundedMemo<K, V> extends Map<K, V> {
  constructor(private readonly cap: number) {
    super()
  }

  override set(key: K, value: V): this {
    super.delete(key)
    super.set(key, value)

    while (this.size > this.cap) {
      super.delete(this.keys().next().value as K)
    }

    return this
  }
}

const units: UnitMemo = new BoundedMemo(3_000)
// the copy of typescript the toolchain builds with (node_modules)
const typescript = createRequire(path.join(TERM, 'package.json'))('typescript') as typeof import('typescript')

function real(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

// the package a file builds in: the nearest directory above it with a deck.tree that is a MANIFEST (`deck <name>`):
// base/code/deck.tree is a module of that name
function rootOf(file: string): string {
  let dir = path.dirname(file)

  while (dir !== path.dirname(dir)) {
    if (deckName(dir) !== undefined) {
      return dir
    }

    dir = path.dirname(dir)
  }

  return path.dirname(file)
}

// whether a deck DESCRIBES a host (compile.ts HOST_DESCRIPTIONS), asked of the compiler: a probe naming a type nothing
// defines is refused in every other deck and builds with an `unknown-name` warning in one of those
const hostMemo = new Map<string, boolean>()

export function describesHost(deck: string): boolean {
  if (!hostMemo.has(deck)) {
    const probe = compile(
      { file: path.join(TERM, 'find-migrate-probe.tree'), text: 'task probe\n  take x, like no-such-type-anywhere\n' },
      { resolve: () => undefined, deckOf: () => ({ name: deck, root: TERM }) },
    )

    hostMemo.set(deck, probe.ok && probe.warnings.some(d => d.name === 'unknown-name'))
  }

  return hostMemo.get(deck)!
}

// `ts`/`rs`: the emit. `notes`: the ENTRY file's own diagnostics (warnings on a build), each `<code>|<message>` without
// positions, which the added lines move. Another file's are proven when that file is compiled as itself
export type Emit = { ok: true; ts: string; rs: string; notes: string[] } | { ok: false; why: string }

export type EmitContext = {
  // module texts that stand in for what is on disk (a repaired `bear` file), by real path
  overlay?: Map<string, string>
  // a host description: built for TypeScript only, as `term make` builds it
  host?: boolean
  // the compile's options, for a test's in-memory files
  options?: Parameters<typeof compile>[1]
}

type Diagnostic = Extract<ReturnType<typeof compile>, { ok: false }>['diagnostics'][number]

function noteOf(d: Diagnostic): string {
  return positionless(`${d.name}|${d.message}`)
}

export function emit(file: string, text: string, context: EmitContext = {}): Emit {
  const root = rootOf(file)
  const overlaid = (base: Resolver): Resolver =>
    context.overlay === undefined
      ? base
      : (importPath, from, how) => {
          const found = base(importPath, from, how)
          const text = found && context.overlay!.get(real(found.file))

          return found && text !== undefined ? { file: found.file, text } : found
        }
  const options = context.options ?? {
    resolve: overlaid(projectResolver(root)),
    roleOf: projectRoleOf(root),
    leanOf: projectLeanOf(root),
    deckOf,
    parsed,
  }

  const ownNotes = (warnings: Diagnostic[]): string[] => warnings.filter(d => (d.file ?? d.span?.file ?? file) === file).map(noteOf).sort()

  try {
    // a host description is compiled as `term make` compiles it, one unit, and its OWN module is compared (what
    // host/.unit/ holds): a merged emit also carries every module the file loads, so a find of a module the file did
    // not load before adds that module's stubs to it, which is no change to the file
    if (context.host) {
      const unit = compileSeparate(
        { file, text },
        {
          resolve: options?.resolve ?? overlaid(projectResolver(root)),
          modules: one => `./${path.relative(root, one).replace(/\.tree$/, '')}`,
          roleOf: options?.roleOf,
          leanOf: options?.leanOf,
          deckOf: options?.deckOf,
          parsed: options?.parsed,
          // keyed by each unit's text and its dependencies' surfaces, so one memo serves every compile of the run
          units,
        },
      )

      if (!unit.ok) {
        return { ok: false, why: `${unit.diagnostics[0]?.name ?? '?'}: ${(unit.diagnostics[0]?.message ?? '').slice(0, 160)}` }
      }

      const own = unit.modules.get(file) ?? [...unit.modules].find(([one]) => real(one) === real(file))?.[1]

      // a module of `bear` and `load` lines alone emits no module of its own: its unit is empty on both sides. Any other
      // file must have one, or the comparison would hold of nothing
      const definesNothing = text.split('\n').every(line => /^(\s|$|#|bear\s|load\s)/.test(line))

      if (own === undefined && !definesNothing) {
        return { ok: false, why: 'the unit build emitted no module for the file' }
      }

      return { ok: true, ts: own?.code ?? '', rs: '', notes: ownNotes(unit.warnings) }
    }

    const node = compile({ file, text }, options)

    if (!node.ok) {
      return { ok: false, why: `${node.diagnostics[0]?.name ?? '?'}: ${(node.diagnostics[0]?.message ?? '').slice(0, 160)}` }
    }

    const notes = ownNotes(node.warnings)

    const native = compile({ file, text }, { ...options, resolve: overlaid(projectResolver(root, 'rust')), env: 'rust' })

    return { ok: true, ts: node.typescript, rs: native.ok ? emitRust(native.program) : 'rust: does not build', notes }
  } catch (cause) {
    return { ok: false, why: `threw: ${String(cause).split('\n')[0]!.slice(0, 160)}` }
  }
}

// names the compiler derives from a source position, which an added line moves (as task/term/await-migrate.ts reads them)
function positionless(text: string): string {
  // and a raise site's `<task> <file>.tree:<line>` frame (term/hive decision 001)
  return text
    .replace(/\bwalkHead\d+\b/g, 'walkHead#')
    .replace(/\bwalk_head_\d+_\d+\b/g, 'walk_head_#')
    .replace(/\.tree:\d+/g, '.tree:#')
}

// `FIND_MIGRATE_DUMP=<dir>`: each refused attempt's two emits, to read why they differ
function dump(file: string, name: string, before: Emit, after: Emit): void {
  const dir = process.env.FIND_MIGRATE_DUMP

  if (!dir || !before.ok || !after.ok) {
    return
  }

  const stem = path.join(dir, `${path.basename(file, '.tree')}-${name}`)
  writeFileSync(`${stem}.before.ts`, before.ts)
  writeFileSync(`${stem}.after.ts`, after.ts)
  writeFileSync(`${stem}.before.rs`, before.rs)
  writeFileSync(`${stem}.after.rs`, after.rs)
}

function same(a: Emit, b: Emit): boolean {
  return a.ok && b.ok && positionless(a.ts) === positionless(b.ts) && positionless(a.rs) === positionless(b.rs)
}

// the TypeScript with every type erased: what runs
export function stripTypes(ts: string): string {
  const out = typescript.transpileModule(ts, {
    compilerOptions: { target: typescript.ScriptTarget.ESNext, module: typescript.ModuleKind.ESNext },
  }).outputText

  return positionless(out)
}

// an `unknown-name` warning a find of one of `found` answers: the type not defined, or the find of it through a module
// that does not define it. `found` of `*` (a repaired bear chain) answers every one
function answeredBy(note: string, found: string[] | '*'): boolean {
  if (!note.startsWith('unknown-name|')) {
    return false
  }

  return found === '*' || found.some(name => note.includes(`"${name}"`))
}

// decision 002 rule 1: undefined when `after` is a type-only change of `before` that answers exactly the warnings of
// `found`, else why not
export function typeOnly(before: Emit, after: Emit, found: string[] | '*'): string | undefined {
  if (!before.ok) {
    return `does not build before (${before.why})`
  }

  if (!after.ok) {
    return `does not build after (${after.why})`
  }

  const left = new Map<string, number>()

  for (const note of before.notes) {
    left.set(note, (left.get(note) ?? 0) + 1)
  }

  for (const note of after.notes) {
    const count = left.get(note) ?? 0

    if (count === 0) {
      return `a new diagnostic: ${note.slice(0, 160)}`
    }

    left.set(note, count - 1)
  }

  const gone = [...left].flatMap(([note, count]) => Array<string>(count).fill(note))
  const unexplained = gone.find(note => !answeredBy(note, found))

  if (unexplained !== undefined) {
    return `a diagnostic went that no find answers: ${unexplained.slice(0, 160)}`
  }

  if (found !== '*') {
    const owed = before.notes.filter(note => answeredBy(note, found)).length

    if (gone.length !== owed) {
      return `${owed - gone.length} unknown-name warnings of the found names stay`
    }
  }

  if (stripTypes(before.ts) !== stripTypes(after.ts)) {
    return 'the TypeScript with types stripped differs'
  }

  return undefined
}

// ---- writing a find ----

const indentOf = (line: string): number => line.length - line.trimStart().length

// the package name a directory with a deck.tree declares (`deck @term/base`)
function deckName(root: string): string | undefined {
  const manifest = path.join(root, 'deck.tree')

  if (!existsSync(manifest)) {
    return undefined
  }

  return /^deck\s+(\S+)/m.exec(readFileSync(manifest, 'utf8'))?.[1]
}

// the spellings a `load` of `definer` from `file` could take, the plainest first
function loadPaths(file: string, definer: string): string[] {
  const own = rootOf(file)
  const theirs = rootOf(definer)
  const bare = definer.replace(/\.tree$/, '')
  const dirForm = /\/(base|note)$/.test(bare) ? [bare.replace(/\/(base|note)$/, '')] : []
  const out: string[] = []
  // a per-platform host is loaded through its `{platform}` slot (stdlib-parity-0002), never by one platform's path
  const slotted = [...dirForm, bare].map(target => target.replace(/\/native\/[a-z]+\//, '/native/{platform}/')).filter(target => target.includes('{platform}'))

  // inside @term/base a find takes the package path, as every stdlib module loads: a stdlib-only resolver
  // (compile/stdlib.ts stdlibResolver) answers @term/base paths alone, never a relative one (term-module-scope-0013)
  const stdlib = own === theirs && deckName(own) === '@term/base'

  for (const target of [...slotted, ...dirForm, bare]) {
    if (own === theirs && !stdlib) {
      let rel = path.relative(path.dirname(file), target)
      rel = rel.startsWith('.') ? rel : `./${rel}`
      out.push(rel)
    } else {
      const name = deckName(theirs)
      const code = path.join(theirs, 'code')

      if (name && target.startsWith(`${code}/`)) {
        out.push(`${name}/${path.relative(code, target)}`)
      }

      if (name) {
        out.push(`${name}/${path.relative(theirs, target)}`)
      }
    }
  }

  return out
}

type Block = { line: number; end: number; path: string }

// the file's top-level `load <path>` blocks (not `dock` loads, not `<native>` ones): the load line and its last child
function loadBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []

  for (let at = 0; at < lines.length; at++) {
    const match = /^load\s+([^\s<,]+)\s*$/.exec(lines[at]!)

    if (!match) {
      continue
    }

    let end = at

    for (let next = at + 1; next < lines.length; next++) {
      const line = lines[next]!

      if (line.trim().length === 0 || indentOf(line) === 0) {
        break
      }

      end = next
    }

    blocks.push({ line: at, end, path: match[1]! })
  }

  return blocks
}

// the text with `find <name>` from `definer`, or why it cannot be written
const ENVS = ['node', 'browser', 'macos', 'android', 'rust'] as const

// whether a load path, from a file, reaches the definer under any env (a `{platform}` slot filled per env)
function reaches(importPath: string, file: string, target: string): boolean {
  const root = rootOf(file)
  const resolvers: Resolver[] = importPath.includes('{platform}')
    ? ENVS.map(env => withNativeEnv(env, projectResolver(root, env)))
    : [projectResolver(root)]

  return resolvers.some(resolve => {
    const found = resolve(importPath, file)

    return found !== undefined && real(found.file) === target
  })
}

function withFind(file: string, text: string, name: string, definer: string): { text: string } | { why: string } {
  const lines = text.split('\n')
  const blocks = loadBlocks(lines)
  const target = real(definer)

  for (const block of blocks) {
    if (reaches(block.path, file, target)) {
      // a `base <dir>` under the load reads the package root: leave such a block alone
      if (lines.slice(block.line + 1, block.end + 1).some(line => /^\s+base\s/.test(line))) {
        continue
      }

      const indent = block.end > block.line ? ' '.repeat(indentOf(lines[block.end]!)) : '  '
      lines.splice(block.end + 1, 0, `${indent}find ${name}`)

      return { text: lines.join('\n') }
    }
  }

  const spelled = loadPaths(file, definer).find(candidate => reaches(candidate, file, target))

  if (!spelled) {
    return { why: `no load path from this file resolves to ${path.relative(REPO, definer)}` }
  }

  const last = blocks.at(-1)

  if (last) {
    lines.splice(last.end + 1, 0, '', `load ${spelled}`, `  find ${name}`)
  } else {
    // after the leading comments, blank lines and file-level marks
    let at = 0

    while (at < lines.length && (lines[at]!.trim() === '' || lines[at]!.startsWith('#') || /^mark\s/.test(lines[at]!))) {
      at++
    }

    lines.splice(at, 0, `load ${spelled}`, `  find ${name}`, '')
  }

  return { text: lines.join('\n') }
}

// ---- one file ----

type Outcome =
  | { kind: 'written'; text: string; original: string; finds: string[]; byHand: string[] }
  | { kind: 'refused'; why: string; byHand: string[] }

function migrate(file: string, refs: Unimported[]): Outcome {
  const original = readFileSync(file, 'utf8')
  const before = emit(file, original)
  const names = [...new Set(refs.map(ref => ref.name))].sort()

  if (!before.ok) {
    return { kind: 'refused', why: `does not build before (${before.why})`, byHand: names }
  }

  // a file whose build emits no code (a mill grammar, checked as itself) gives an identical emit for ANY find, so its
  // output proves no binding: a grammar's `term base` or `site fill` is a word of the grammar, not a reference
  if (before.ts.trim() === '') {
    return { kind: 'refused', why: 'emits no TypeScript, so no emit can prove what a reference binds', byHand: names }
  }

  const definersOf = (name: string): string[] => [...new Set(refs.filter(ref => ref.name === name).flatMap(ref => ref.definers))].sort()
  let text = original
  const finds: string[] = []
  const byHand: string[] = []

  // every name with one definer, at once: the common case, one build
  const single = names.filter(name => definersOf(name).length === 1)
  let together = text

  for (const name of single) {
    const next = withFind(file, together, name, definersOf(name)[0]!)
    together = 'text' in next ? next.text : together
  }

  const singleDone = together !== text && same(before, emit(file, together))

  for (const name of names) {
    const definers = definersOf(name)

    if (singleDone && definers.length === 1) {
      const next = withFind(file, text, name, definers[0]!)

      if ('text' in next) {
        text = next.text
        finds.push(`${name} <- ${path.relative(REPO, definers[0]!)}`)
        continue
      }
    }

    // one at a time: the definer, and only one, under which the build is what it was
    const keeps: { definer: string; text: string }[] = []
    const why: string[] = []

    for (const definer of definers) {
      const next = withFind(file, text, name, definer)

      if (!('text' in next)) {
        why.push(next.why)
        continue
      }

      const after = emit(file, next.text)

      if (same(before, after)) {
        keeps.push({ definer, text: next.text })
      } else {
        dump(file, name, before, after)
        why.push(after.ok ? `from ${path.relative(REPO, definer)} the output differs` : `from ${path.relative(REPO, definer)}: ${after.why}`)
      }
    }

    if (keeps.length === 1) {
      text = keeps[0]!.text
      finds.push(`${name} <- ${path.relative(REPO, keeps[0]!.definer)}`)
    } else {
      byHand.push(`${name} (${keeps.length > 1 ? `${keeps.length} definers keep the output, the binding cannot be told` : why.join('; ')})`)
    }
  }

  if (finds.length === 0) {
    return { kind: 'refused', why: 'no find keeps the output', byHand }
  }

  // the whole rewrite, once more, as it will be written
  if (!same(before, emit(file, text))) {
    return { kind: 'refused', why: 'the finds together change the output', byHand: names }
  }

  return { kind: 'written', text, original, finds, byHand }
}

// ---- a host description (decision 002) ----

// the platform tree a file of a package is in: the first folder under its code root (`browser`, `node`, `rust`,
// `shared`), a top-level `node.tree` counted in `node`; undefined outside the package
function treeOf(codeRoot: string, file: string): string | undefined {
  const rel = path.relative(real(codeRoot), real(file))

  return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split('/')[0]!.replace(/\.tree$/, '')
}

// rule 2: one definer, that one; several, the one in the file's own tree, else in shared/, else outside the package
export function chooseDefiner(codeRoot: string, file: string, definers: string[]): { definer: string } | { why: string } {
  if (definers.length === 1) {
    return { definer: definers[0]! }
  }

  const own = treeOf(codeRoot, file)
  const tiers: [string, (definer: string) => boolean][] = [
    [`own tree ${own}`, definer => treeOf(codeRoot, definer) === own],
    ['shared', definer => treeOf(codeRoot, definer) === 'shared'],
    ['outside the package', definer => treeOf(codeRoot, definer) === undefined],
  ]

  for (const [tier, holds] of tiers) {
    const matched = definers.filter(holds)

    if (matched.length === 1) {
      return { definer: matched[0]! }
    }

    if (matched.length > 1) {
      return { why: `${matched.length} definers in ${tier}: ${matched.map(d => path.relative(REPO, d)).join(', ')}` }
    }
  }

  return { why: `${definers.length} definers, none in its own tree (${own}), shared/ or outside the package: ${definers.map(d => path.relative(REPO, d)).join(', ')}` }
}

function migrateHost(file: string, refs: Unimported[], codeRoot: string, overlay: Map<string, string> | undefined): Outcome {
  const original = overlay?.get(real(file)) ?? readFileSync(file, 'utf8')
  const context: EmitContext = { overlay, host: true }
  const before = emit(file, original, context)
  const names = [...new Set(refs.map(ref => ref.name))].sort()

  if (!before.ok) {
    return { kind: 'refused', why: `does not build before (${before.why})`, byHand: names }
  }

  const byHand: string[] = []
  const chosen: [string, string][] = []

  for (const name of names) {
    const choice = chooseDefiner(codeRoot, file, [...new Set(refs.filter(ref => ref.name === name).flatMap(ref => ref.definers))].sort())

    if ('definer' in choice) {
      chosen.push([name, choice.definer])
    } else {
      byHand.push(`${name} (${choice.why})`)
    }
  }

  const place = (text: string, name: string, definer: string): { text: string } | { why: string } => withFind(file, text, name, definer)

  // every chosen find at once: the common case, one build
  let together = original
  const placed: string[] = []

  for (const [name, definer] of chosen) {
    const next = place(together, name, definer)

    if ('text' in next) {
      together = next.text
      placed.push(`${name} <- ${path.relative(REPO, definer)}`)
    }
  }

  if (placed.length === chosen.length && placed.length > 0 && typeOnly(before, emit(file, together, context), chosen.map(([name]) => name)) === undefined) {
    return { kind: 'written', text: together, original, finds: placed, byHand }
  }

  // one at a time, each against the text before any find
  let text = original
  const finds: string[] = []
  const found: string[] = []

  for (const [name, definer] of chosen) {
    const next = place(text, name, definer)

    if (!('text' in next)) {
      byHand.push(`${name} (${next.why})`)
      continue
    }

    const after = emit(file, next.text, context)
    const why = typeOnly(before, after, [...found, name])

    if (why === undefined) {
      text = next.text
      found.push(name)
      finds.push(`${name} <- ${path.relative(REPO, definer)}`)
    } else {
      dump(file, name, before, after)
      byHand.push(`${name} (from ${path.relative(REPO, definer)}: ${why})`)
    }
  }

  if (finds.length === 0) {
    return { kind: 'refused', why: 'no find is a type-only change', byHand }
  }

  const whole = typeOnly(before, emit(file, text, context), found)

  if (whole !== undefined) {
    return { kind: 'refused', why: `the finds together: ${whole}`, byHand: names }
  }

  return { kind: 'written', text, original, finds, byHand }
}

// the saved text of a host-description file before its first write; false when a different text is saved there
function saveBefore(packageRoot: string, file: string, text: string): boolean {
  const saved = path.join(BEFORE, path.basename(packageRoot), path.relative(packageRoot, file))

  if (existsSync(saved)) {
    return readFileSync(saved, 'utf8') === text
  }

  mkdirSync(path.dirname(saved), { recursive: true })
  writeFileSync(saved, text)

  return true
}

// ---- stale `bear` chains (decision 002 rule 3) ----

type BearRepair = { file: string; text: string; lines: string[] }

// every module path of a package's code root (`node/dgram`, and `node` for `node/base.tree`) with its file
function moduleIndex(codeRoot: string, files: string[]): Map<string, string> {
  const index = new Map<string, string>()

  for (const file of files) {
    const rel = path.relative(codeRoot, file).replace(/\.tree$/, '')

    if (rel.startsWith('..')) {
      continue
    }

    index.set(rel, file)

    if (/(^|\/)(base|note)$/.test(rel)) {
      index.set(rel.replace(/\/?(base|note)$/, ''), file)
    }
  }

  return index
}

// the one module whose path ends in the longest tail of a stale path's segments
function existingFor(stale: string, deck: string, index: Map<string, string>): { module: string; file: string } | { why: string } {
  if (!stale.startsWith(`${deck}/`)) {
    return { why: 'not a path of this package' }
  }

  const segments = stale.slice(deck.length + 1).replace(/^code\//, '').split('/')

  for (let take = segments.length; take >= 1; take--) {
    const tail = segments.slice(-take).join('/')
    const matches = [...index].filter(([module]) => module === tail || module.endsWith(`/${tail}`))
    const files = new Set(matches.map(([, file]) => real(file)))

    if (files.size === 1) {
      return { module: matches[0]![0], file: matches[0]![1] }
    }

    if (files.size > 1) {
      return { why: `${files.size} modules end in ${tail}` }
    }
  }

  return { why: 'no module ends in its last segment' }
}

function repairBears(name: string, files: string[]): { overlay: Map<string, string>; repairs: BearRepair[]; lines: number; refused: string[] } {
  const top = path.join(DECKS, name)
  const deck = deckName(top)!
  const codeRoot = path.join(top, 'code')
  const index = moduleIndex(codeRoot, files)
  const resolve = projectResolver(top)
  const refused: string[] = []
  const candidates: BearRepair[] = []
  let lines = 0

  for (const file of files) {
    const text = readFileSync(file, 'utf8')

    if (!/^bear\s/m.test(text)) {
      continue
    }

    const out = text.split('\n')
    const changed: string[] = []

    for (let at = 0; at < out.length; at++) {
      const match = /^bear\s+(\S+)\s*$/.exec(out[at]!)

      if (!match || resolve(match[1]!, file) !== undefined) {
        continue
      }

      lines++
      const where = `${path.relative(REPO, file)}:${at + 1} ${match[1]}`
      const existing = existingFor(match[1]!, deck, index)

      if ('why' in existing) {
        refused.push(`${where}: ${existing.why}`)
        continue
      }

      const spelled = `${deck}/${existing.module}`
      const found = resolve(spelled, file)

      if (!found || real(found.file) !== real(existing.file)) {
        refused.push(`${where}: ${spelled} does not resolve to ${path.relative(REPO, existing.file)}`)
        continue
      }

      out[at] = `bear ${spelled}`
      changed.push(`${match[1]} -> ${spelled}`)
    }

    if (changed.length > 0) {
      candidates.push({ file, text: out.join('\n'), lines: changed })
    }
  }

  // who loads or bears each file
  const importers = new Map<string, string[]>()

  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^(?:load|bear)\s+([^\s<,]+)\s*$/gm)) {
      const found = resolve(match[1]!, file)

      if (found) {
        const target = real(found.file)
        importers.set(target, [...new Set([...(importers.get(target) ?? []), file])])
      }
    }
  }

  const overlay = new Map<string, string>()
  const repairs: BearRepair[] = []
  const context: EmitContext = { host: true }

  // the fewest loaders first, so the long proofs (javascript.tree, loaded by about 600 files) come last
  const loadersOf = (file: string): number => (importers.get(real(file)) ?? []).length
  candidates.sort((a, b) => loadersOf(a.file) - loadersOf(b.file))

  // each verdict as it is reached, so a dry run that stops part way resumes where it was (never read on --commit).
  // Keyed by the bear file's text before and after: a changed file is proven again. A loader's text is not in the key,
  // so a dry run reading it back says so
  const journalAt = path.join(TERM, `tmp/scope/bear-journal-${name}.jsonl`)
  const keyOf = (repair: BearRepair): string =>
    createHash('sha256').update(readFileSync(repair.file, 'utf8')).update('\0').update(repair.text).digest('hex')
  const journal = new Map<string, string | null>()

  if (!commit && existsSync(journalAt)) {
    for (const line of readFileSync(journalAt, 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as { key: string; why: string | null }
      journal.set(entry.key, entry.why)
    }

    console.log(`  ${journal.size} bear verdicts read back from ${path.relative(REPO, journalAt)}`)
  }

  mkdirSync(path.dirname(journalAt), { recursive: true })

  for (const repair of candidates) {
    const key = keyOf(repair)

    if (journal.has(key)) {
      const why = journal.get(key) ?? undefined
      console.log(`  ${why === undefined ? 'repairs' : 'refused'} ${path.relative(REPO, repair.file)} (${repair.lines.length} lines, from the journal)${why ? `: ${why}` : ''}`)

      if (why === undefined) {
        overlay.set(real(repair.file), repair.text)
        repairs.push(repair)
      } else {
        refused.push(`${path.relative(REPO, repair.file)} (${repair.lines.length} lines): ${why}`)
      }

      continue
    }

    const one = new Map([[real(repair.file), repair.text]])
    const own = typeOnly(emit(repair.file, readFileSync(repair.file, 'utf8'), context), emit(repair.file, repair.text, { ...context, overlay: one }), '*')
    let why = own === undefined ? undefined : `itself: ${own}`
    const loaders = importers.get(real(repair.file)) ?? []

    for (const loader of why === undefined ? loaders : []) {
      const text = readFileSync(loader, 'utf8')
      const theirs = typeOnly(emit(loader, text, context), emit(loader, text, { ...context, overlay: one }), '*')

      if (theirs !== undefined) {
        why = `${path.relative(REPO, loader)}: ${theirs}`
        break
      }
    }

    console.log(`  ${why === undefined ? 'repairs' : 'refused'} ${path.relative(REPO, repair.file)} (${repair.lines.length} lines, ${loaders.length} loaders)${why ? `: ${why}` : ''}`)
    appendFileSync(journalAt, `${JSON.stringify({ key, file: path.relative(REPO, repair.file), why: why ?? null })}\n`)

    if (why === undefined) {
      overlay.set(real(repair.file), repair.text)
      repairs.push(repair)
    } else {
      refused.push(`${path.relative(REPO, repair.file)} (${repair.lines.length} lines): ${why}`)
    }
  }

  return { overlay, repairs, lines, refused }
}

// ---- --prove: a hand-written host-description file against its saved before text ----

function prove(file: string): number {
  const absolute = path.resolve(REPO, file)
  const top = rootOf(absolute)
  const saved = path.join(BEFORE, path.basename(top), path.relative(top, absolute))

  if (!existsSync(saved)) {
    console.log(`find-migrate --prove: no saved before text at ${path.relative(REPO, saved)}`)
    return 1
  }

  const beforeText = readFileSync(saved, 'utf8')
  const afterText = readFileSync(absolute, 'utf8')
  const findsOf = (text: string): string[] => [...text.matchAll(/^\s+find\s+([^\s,]+)/gm)].map(match => match[1]!)
  const had = new Set(findsOf(beforeText))
  const found = [...new Set(findsOf(afterText).filter(name => !had.has(name)))]
  const context: EmitContext = { host: describesHost(deckName(top) ?? '') }
  const why = context.host
    ? typeOnly(emit(absolute, beforeText, context), emit(absolute, afterText, context), found)
    : same(emit(absolute, beforeText), emit(absolute, afterText))
      ? undefined
      : 'the output differs'

  console.log(`find-migrate --prove ${path.relative(REPO, absolute)} (finds ${found.join(', ') || 'none'}): ${why ?? 'proven'}`)

  return why === undefined ? 0 : 1
}

// ---- the run ----

function run(): void {
  // a --commit run reads the lock table before any work, so a missing parent stops it at once
  if (commit) {
    lockedPaths()
  }

  const packages = readdirSync(DECKS)
    .filter(name => existsSync(path.join(DECKS, name, 'deck.tree')) && existsSync(path.join(DECKS, name, 'code')))
    .filter(name => !only || only.includes(name))
    .sort()

  let filesWritten = 0
  let findsWritten = 0
  let referencesSeen = 0
  const lockedAt: string[] = []
  const listed: string[] = []

  for (const name of packages) {
    const top = path.join(DECKS, name)
    const host = describesHost(deckName(top) ?? '')
    const census = packageCensus(name)
    let overlay: Map<string, string> | undefined

    if (repairBear) {
      const bears = repairBears(name, census.files)

      const repaired = bears.repairs.reduce((sum, repair) => sum + repair.lines.length, 0)
      console.log(`\n== ${name} bear: ${bears.lines} stale lines, ${repaired} repairable in ${bears.repairs.length} files, ${bears.refused.length} refused`)

      for (const line of bears.refused) {
        console.log(`  REFUSED bear ${line}`)
      }

      if (commit) {
        for (const repair of bears.repairs) {
          const original = readFileSync(repair.file, 'utf8')

          if (host && !saveBefore(top, repair.file, original)) {
            console.log(`  REFUSED ${path.relative(REPO, repair.file)}: a different before text is saved`)
            continue
          }

          writeFileSync(repair.file, repair.text)
        }

        console.log(`   ${name}: ${bears.repairs.length} bear files written; run again without --repair-bear, so the census reads the repaired chains`)
        continue
      }

      overlay = bears.overlay
    }

    const byFile = new Map<string, Unimported[]>()

    for (const ref of census.unimported) {
      byFile.set(ref.file, [...(byFile.get(ref.file) ?? []), ref])
    }

    referencesSeen += census.unimported.length
    let pkgFiles = 0
    let pkgFinds = 0
    let pkgRefused = 0
    let pkgByHand = 0

    console.log(`\n== ${name}${host ? ' (a host description: type-only proof)' : ''}: ${census.unimported.length} unimported references in ${byFile.size} files`)

    for (const [file, refs] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
      const where = path.relative(REPO, file)

      if (isLocked(where)) {
        lockedAt.push(`${where}: ${refs.length}`)
        continue
      }

      const outcome = host ? migrateHost(file, refs, path.join(top, 'code'), overlay) : migrate(file, refs)
      pkgByHand += outcome.byHand.length

      if (outcome.kind === 'refused') {
        pkgRefused++
        listed.push(`  REFUSED ${where}: ${outcome.why}${outcome.byHand.length ? `\n      by hand: ${outcome.byHand.join(', ')}` : ''}`)
        console.log(`  refused ${where}: ${outcome.why}`)
        continue
      }

      pkgFiles++
      pkgFinds += outcome.finds.length
      console.log(`  ${commit ? 'wrote' : 'would write'} ${where}: ${outcome.finds.join(', ')}${outcome.byHand.length ? ` (by hand: ${outcome.byHand.join(', ')})` : ''}`)

      if (outcome.byHand.length) {
        listed.push(`  BY HAND ${where}: ${outcome.byHand.join(', ')}`)
      }

      if (commit) {
        // the file as it is NOW must be the text this run read, or another writer got there first
        if (readFileSync(file, 'utf8') !== outcome.original) {
          listed.push(`  REFUSED ${where}: changed on disk since it was read, so it was not written`)
          continue
        }

        if (host && !saveBefore(top, file, outcome.original)) {
          listed.push(`  REFUSED ${where}: a different before text is saved under tmp/scope/bind-before, so it was not written`)
          continue
        }

        writeFileSync(file, outcome.text)
      }
    }

    filesWritten += pkgFiles
    findsWritten += pkgFinds
    console.log(`   ${name}: ${pkgFiles} files, ${pkgFinds} finds, ${pkgRefused} files refused, ${pkgByHand} names by hand`)
  }

  console.log('')

  for (const line of listed) {
    console.log(line)
  }

  if (lockedAt.length > 0) {
    console.log(`\nowned by another session (locks.json), skipped:\n  ${lockedAt.join('\n  ')}`)
  }

  console.log(
    `\nfind-migrate: ${packages.length} packages, ${referencesSeen} unimported references, ${findsWritten} finds in ${filesWritten} files ${commit ? 'written' : 'to write (report only: --commit writes)'}`,
  )
}

const direct = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (direct) {
  if (proveFile !== undefined) {
    process.exitCode = prove(proveFile)
  } else {
    run()
  }
}
