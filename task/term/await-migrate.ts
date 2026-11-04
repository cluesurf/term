// Await by default, carried through the repository WITHOUT CHANGING WHAT ANY FILE MEANS
// (note/project/term/await-by-default-and-mark-metadata.md, section 3).
//
// THE SWITCH. Inside a task a call to an async task is awaited with nothing written, and was before this: async
// resolution (check/async-resolve.ts) inserts the await and marks the caller async. OUTSIDE every task (a top-level
// `host` or statement, a component's body, a closure in either that is not async) nothing can wait, and such a call
// handed back a pending value with no message. The switch (check/effects.ts, `setAwaitOutsideTasks`) makes that an
// error naming `tick`, which is how a place that cannot wait says it means the pending value. Flipping it changes no
// output, only which files build, so every file it would refuse is rewritten first.
//
// WHAT THIS DOES, per file:
//   1. every call the switch would refuse becomes `tick` (`call f` -> `tick f`, a bare `f(x)` -> `tick f(x)`), which
//      is the call it was: started, not waited for, the pending value
//   2. every `wait true` under a call to an async TASK is removed: the call is awaited with nothing written, so the
//      marker says nothing. A `wait true` on a call into a `dock load` module is the only thing that awaits it, and
//      the proof keeps it, since removing it changes the output
//
// THE PROOF, per file, before anything is written: the file compiled under the OLD rule as it is, and under the NEW
// rule as rewritten, must emit the same TypeScript, and the same Rust where the file builds for Rust. A file whose
// output differs is listed and not written. When the whole rewrite differs, the ticks are tried alone and each
// `wait true` removal is then kept only if the output still matches, so one edit cannot cost a file the rest.
//
// A file the old rule cannot build is not evidence about anything and is skipped, with the reason counted. A file
// that only fails because a file it imports is refused by the new rule is retried once that file is rewritten.
//
// Reports by default; writes only with --commit, reading each file again immediately before writing it and refusing
// one that changed since it was read.
//
//   pnpm term:await-migrate                         every .tree under the Term and zone trees, report
//   pnpm term:await-migrate --only deck/zone        a path substring, or several joined by commas
//   pnpm term:await-migrate --commit                write
//   pnpm term:await-migrate --no-rust               TypeScript only

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { makeParseMemo } from '@term/make/code/compile/load'
import type { Resolver } from '@term/make/code/compile/load'
import type { CompileCache } from '@term/make/code/compile/cache'
import { projectCache } from '@term/call/code/cache-store'
import { setAwaitOutsideTasks } from '@term/make/code/check/effects'
import { waitTrueSites } from '@term/make/code/check/note-metadata'
import { parse } from '@term/make/code/parser/tree'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import type { Program } from '@term/make/code/compile/node'
import { TERM_ROOT, parentPaths } from './root'

const TERM = TERM_ROOT
const HOME = TERM_ROOT

const ROOTS = [
  join(TERM, 'deck'),
  join(TERM, 'test'),
  join(TERM, 'mark'),
  join(TERM, 'task'),
  ...parentPaths('deck/zone'),
  ...parentPaths('deck/term/deck/land.tree'),
  ...parentPaths('mesh/deck'),
  ...parentPaths('mesh/site'),
]

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const rust = !argv.includes('--no-rust')
const onlyAt = argv.indexOf('--only')
const only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    // `host/` beside a deck.tree is build output, and `deck/host` is the @term/host PACKAGE, which is source
    const output = name === 'host' ? existsSync(join(dir, 'deck.tree')) : SKIP.has(name)

    if (output || name.endsWith('-cache')) {
      continue
    }

    const full = join(dir, name)
    const stat = lstatSync(full)

    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      trees(full, out)
    } else if (name.endsWith('.tree') && name !== 'draft.tree' && name !== 'deck.tree' && name !== 'role.tree') {
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

// ---- compiling, under either rule, with rewritten files read in place of the disk ----

const parsed = makeParseMemo()
const caches = new Map<string, CompileCache>()
// the files rewritten so far in this run, by real path: what an importer reads instead of the disk
const overlay = new Map<string, string>()

function cacheOf(root: string): CompileCache {
  const known = caches.get(root) ?? projectCache(root)
  caches.set(root, known)

  return known
}

function real(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

function overlaid(resolve: Resolver): Resolver {
  return (path, from, how) => {
    const found = resolve(path, from, how)

    if (!found) {
      return found
    }

    const text = overlay.get(real(found.file))

    return text === undefined ? found : { ...found, text }
  }
}

type Emit =
  | { ok: true; ts: string; rs?: string; program: Program }
  | { ok: false; diagnostics: Diagnostic[] }

function emit(file: string, text: string, root: string, rule: 'old' | 'new'): Emit {
  setAwaitOutsideTasks(rule === 'new')

  const options = {
    resolve: overlaid(projectResolver(root)),
    roleOf: projectRoleOf(root),
    leanOf: projectLeanOf(root),
    parsed,
    cache: cacheOf(root),
  }

  try {
    const node = compile({ file, text }, options)

    if (!node.ok) {
      return { ok: false, diagnostics: node.diagnostics }
    }

    if (!rust) {
      return { ok: true, ts: node.typescript, program: node.program }
    }

    const native = compile({ file, text }, { ...options, resolve: overlaid(projectResolver(root, 'rust')), env: 'rust', cache: undefined })

    // a file that does not build for Rust is compared on TypeScript alone, and the same on both sides
    return { ok: true, ts: node.typescript, rs: native.ok ? emitRust(native.program) : 'rust: does not build', program: node.program }
  } catch (cause) {
    return { ok: false, diagnostics: [{ name: 'threw', message: String(cause).split('\n')[0] } as Diagnostic] }
  } finally {
    setAwaitOutsideTasks(false)
  }
}

// Names the compiler derives from a SOURCE POSITION, which removing a `wait true` line moves: `walk-head-94-2` (a
// walk's sequence held in a local, compile/mint-bridge.ts) emits as `walkHead942`. Deterministic and meaningless, so
// compared with the position taken out, exactly as `pnpm term:lean-equal` compares them (task/term/lean-equal.ts)
function positionless(text: string | undefined): string | undefined {
  return text?.replace(/\bwalkHead\d+\b/g, 'walkHead#').replace(/\bwalk_head_\d+_\d+\b/g, 'walk_head_#')
}

function same(a: Emit, b: Emit): boolean {
  return a.ok && b.ok && positionless(a.ts) === positionless(b.ts) && positionless(a.rs) === positionless(b.rs)
}

// ---- the edits ----

type Edit = { span: Span; text: string; kind: 'tick' | 'wait' }

function offsetOf(lines: string[], pos: { line: number; column: number }): number {
  let at = 0

  for (let i = 0; i < pos.line; i++) {
    at += (lines[i]?.length ?? 0) + 1
  }

  return at + pos.column
}

function apply(text: string, edits: Edit[]): string {
  const lines = text.split('\n')
  const ranges = edits
    .map(edit => ({ start: offsetOf(lines, edit.span.start), end: offsetOf(lines, edit.span.end), text: edit.text }))
    .sort((a, b) => b.start - a.start)

  let out = text
  let floor = Infinity

  for (const range of ranges) {
    if (range.end > floor) {
      continue
    }

    out = out.slice(0, range.start) + range.text + out.slice(range.end)
    floor = range.start
  }

  return out
}

// a refused call, made a `tick`: the `call` word becomes `tick`, and a bare-head call gets `tick ` in front
function tickOf(text: string, span: Span): Edit | undefined {
  const line = text.split('\n')[span.start.line] ?? ''
  const at = line.slice(span.start.column)

  if (at.startsWith('call ')) {
    return {
      kind: 'tick',
      span: { start: span.start, end: { line: span.start.line, column: span.start.column + 4 } },
      text: 'tick',
    }
  }

  if (/^[a-z]/.test(at)) {
    return { kind: 'tick', span: { start: span.start, end: span.start }, text: 'tick ' }
  }

  return undefined
}

// the async task names a compiled program defines: a name defined in more than one file is split by file
// (`name__in<g>_<k>`), and it is async only when every part is
function asyncCallees(program: Program): (name: string) => boolean {
  const parts = new Map<string, boolean[]>()

  for (const statement of program) {
    if (statement.form === 'function') {
      const base = statement.name.replace(/__in\d+_\d+$/, '')
      const list = parts.get(base) ?? []
      list.push(statement.async === true)
      parts.set(base, list)
    }
  }

  return name => (parts.get(name) ?? []).length > 0 && parts.get(name)!.every(Boolean)
}

// every parameter and local name the program binds, any of which may shadow a task of the same name
function boundNames(program: unknown): Set<string> {
  const names = new Set<string>()

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const record = value as Record<string, unknown>

    if (record.form === 'let' && typeof record.name === 'string') {
      names.add(record.name)
    }

    if ((record.form === 'function' || record.form === 'closure') && Array.isArray(record.params)) {
      for (const param of record.params as { name: string }[]) {
        names.add(param.name)
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(child)
      }
    }
  }

  visit(program)

  return names
}

// ---- one file ----

type Outcome =
  | { kind: 'written'; ticks: number; waits: number; kept: number; text: string; original: string }
  | { kind: 'untouched' }
  | { kind: 'skip'; why: string }
  | { kind: 'blocked'; why: string }
  | { kind: 'differ'; why: string }

// Top-level heads that only DEFINE (a task, a form, an import, a rule, a binding, a template, metadata). The switch
// walks only what is outside every task, so a file whose top level holds nothing else, and no `wait true`, cannot
// change: it is not compiled. Anything else at the top (`host`, `view`, `hook`, a call) is compiled and judged.
const DEFINING = new Set(['task', 'form', 'load', 'dock', 'rule', 'mask', 'bind', 'tree', 'fuse', 'note', 'mark', 'test', 'deck', 'role', 'roll', 'tell', 'bear', 'suit', 'kind', 'twin'])

function couldChange(text: string): boolean {
  if (/\bwait true\b/.test(text)) {
    return true
  }

  return text.split('\n').some(line => {
    const head = /^([a-z][a-z0-9-]*)/.exec(line)?.[1]

    return head !== undefined && !DEFINING.has(head)
  })
}

function migrate(file: string): Outcome {
  const text = overlay.get(real(file)) ?? readFileSync(file, 'utf8')

  if (/^(mark|note) draft\s*$/m.test(text.slice(0, 2000))) {
    return { kind: 'skip', why: 'shelved (`mark draft`)' }
  }

  // a file a generator writes is that generator's output: it changes when the generator does, never here
  if (/^# GENERATED\b/.test(text)) {
    return { kind: 'skip', why: 'generated (`# GENERATED`): the generator is the source' }
  }

  if (!couldChange(text)) {
    return { kind: 'untouched' }
  }

  const root = rootOf(file)
  const old = emit(file, text, root, 'old')

  if (!old.ok) {
    return { kind: 'skip', why: 'does not build under the old rule' }
  }

  const tree = parse({ file, text })

  if (!tree.ok) {
    return { kind: 'skip', why: 'does not parse' }
  }

  // 2. the `wait true`s on calls to async tasks, by what the old build knows is async
  const isAsync = asyncCallees(old.program)
  const bound = boundNames(old.program)
  // A file that loads a PLATFORM module (`{platform}`, a `native/` path) may call a name that is an async task on
  // one backend and a plain binding on another, where the marker is the only await. When its Rust build fails as it
  // stands, the Rust half of the proof compares two failures and sees nothing, so its markers are left alone. Found
  // by `compile/roundtrip rust` after the first run removed 97 such markers from the stdlib (restored)
  const blind = rust && old.rs === 'rust: does not build' && /\{platform\}|\/native\//.test(text)
  const waits: Edit[] = waitTrueSites(tree.tree, text)
    .filter(site => !blind && !site.definition && isAsync(site.callee) && !bound.has(site.callee))
    .map(site => ({ kind: 'wait' as const, span: site.remove, text: '' }))

  // 1. the calls the new rule refuses, in THIS file. A refusal in an imported file is that file's to fix
  const now = emit(file, text, root, 'new')
  const ticks: Edit[] = []

  if (!now.ok) {
    const here = now.diagnostics.filter(d => d.name === 'async-outside-task' && real(d.span?.file ?? d.file ?? '') === real(file))
    const elsewhere = now.diagnostics.filter(d => !here.includes(d))

    if (elsewhere.length > 0) {
      const first = elsewhere[0]!

      return { kind: 'blocked', why: `${first.name}: ${first.message.slice(0, 160)} (${relative(HOME, first.span?.file ?? first.file ?? '?')})` }
    }

    for (const diagnostic of here) {
      const edit = diagnostic.span ? tickOf(text, diagnostic.span) : undefined

      if (!edit) {
        return { kind: 'differ', why: `no tick spelling for the call at line ${(diagnostic.span?.start.line ?? 0) + 1}` }
      }

      ticks.push(edit)
    }
  }

  if (ticks.length === 0 && waits.length === 0) {
    return { kind: 'untouched' }
  }

  const all = apply(text, [...ticks, ...waits])

  if (same(old, emit(file, all, root, 'new'))) {
    return { kind: 'written', ticks: ticks.length, waits: waits.length, kept: 0, text: all, original: text }
  }

  // the whole rewrite differs: the ticks alone, then each removal kept only while the output still matches
  const ticked = apply(text, ticks)

  if (!same(old, emit(file, ticked, root, 'new'))) {
    return { kind: 'differ', why: 'the ticks alone change the output' }
  }

  const accepted: Edit[] = []

  for (const wait of waits) {
    const tried = apply(text, [...ticks, ...accepted, wait])

    if (same(old, emit(file, tried, root, 'new'))) {
      accepted.push(wait)
    }
  }

  if (ticks.length === 0 && accepted.length === 0) {
    return { kind: 'untouched' }
  }

  const final = apply(text, [...ticks, ...accepted])

  return same(old, emit(file, final, root, 'new'))
    ? { kind: 'written', ticks: ticks.length, waits: accepted.length, kept: waits.length - accepted.length, text: final, original: text }
    : { kind: 'differ', why: 'the accepted edits together change the output' }
}

// ---- the run ----

function main(): void {
  const files: string[] = []

  for (const dir of ROOTS) {
    trees(dir, files)
  }

  // the parser's fixtures hold an expected tree after `---`, and are not programs
  // `--only a,b`: any of the substrings
  // `--list <file>`: absolute paths, one a line
  const listAt = argv.indexOf('--list')
  const wanted = listAt >= 0 ? readFileSync(argv[listAt + 1]!, 'utf8').split('\n').filter(Boolean) : only ? only.split(',') : []
  const chosen = files.filter(file => !/\/test\/parser\/file\//.test(file) && (wanted.length === 0 || wanted.some(part => file.includes(part))))
  const tally = { written: 0, untouched: 0, skip: 0, blocked: 0, differ: 0, ticks: 0, waits: 0, kept: 0 }
  const skipped = new Map<string, number>()
  // every finding also goes to stderr as it happens, so a run stopped part way still says what it wrote
  const listed: string[] = []
  const push = listed.push.bind(listed)

  listed.push = (...lines: string[]): number => {
    for (const line of lines) {
      process.stderr.write(`${line}\n`)
    }

    return push(...lines)
  }
  const name = (file: string) => relative(HOME, file)
  let pending = chosen

  console.log(`term await-migrate: ${chosen.length} files, TypeScript${rust ? ' and Rust' : ''}${commit ? ', writing' : ', report only'}`)

  // two passes: a file blocked by an import's refusal is tried again once that import is rewritten
  for (let pass = 1; pass <= 2 && pending.length > 0; pass++) {
    const blocked: string[] = []
    let at = 0

    for (const file of pending) {
      at++
      process.stderr.write(`  [${pass}:${at}/${pending.length}] ${name(file)}\n`)

      const outcome = migrate(file)

      switch (outcome.kind) {
        case 'written': {
          tally.written++
          tally.ticks += outcome.ticks
          tally.waits += outcome.waits
          tally.kept += outcome.kept
          overlay.set(real(file), outcome.text)
          listed.push(`  ${commit ? 'WROTE' : 'WOULD WRITE'} ${name(file)}: ${outcome.ticks} tick, ${outcome.waits} wait true removed${outcome.kept ? `, ${outcome.kept} kept (removing it changes the output)` : ''}`)

          if (commit) {
            // the file as it is NOW must be the text this run read, or another writer got there first
            if (readFileSync(file, 'utf8') !== outcome.original) {
              listed.push(`  REFUSED ${name(file)}: changed on disk since it was read, so it was not written`)
              tally.written--
              tally.differ++
              break
            }

            writeFileSync(file, outcome.text)
          }

          break
        }
        case 'untouched':
          tally.untouched++
          break
        case 'skip':
          tally.skip++
          skipped.set(outcome.why, (skipped.get(outcome.why) ?? 0) + 1)
          break
        case 'blocked':
          if (pass === 1) {
            blocked.push(file)
          } else {
            tally.blocked++
            listed.push(`  BLOCKED ${name(file)}: ${outcome.why}`)
          }

          break
        case 'differ':
          tally.differ++
          listed.push(`  DIFFER ${name(file)}: ${outcome.why}`)
          break
      }
    }

    pending = blocked
  }

  console.log('')

  for (const line of listed) {
    console.log(line)
  }

  console.log('')

  for (const [why, count] of skipped) {
    console.log(`  skipped ${count}: ${why}`)
  }

  console.log('')
  console.log(
    `term await-migrate: ${tally.written} ${commit ? 'written' : 'to write'} (${tally.ticks} calls to tick, ${tally.waits} wait true removed, ${tally.kept} wait true kept), ${tally.untouched} untouched, ${tally.skip} skipped, ${tally.blocked} blocked, ${tally.differ} differ`,
  )

  if (tally.differ + tally.blocked > 0) {
    process.exitCode = 1
  }
}

main()
