// THE NATIVE ENTRY'S RULER: how far rustc gets on the CLI's own entry, `deck/call/code/line/base.tree`, and what stops it,
// by class (item term-self-host-001-0796, the first step of the native CLI).
//
// It compiles the entry for Rust as a library, writes it with its prelude and crates as a cargo project under
// `.base/@term/code/native-entry/`, and reads `cargo check` in two passes:
//
//   1. as emitted. The first stop is the parse of the docks the emitter writes as `use <spec>;` with a spec no crate
//      holds (`use node::fs;`, `use @term::make::code::resolve;`).
//   2. with those `use` lines commented out, so rustc reaches name resolution and what is behind it.
//
// The classes, in the order a native CLI meets them:
//
//   unlinkable use      a dock the emitter wrote as a `use` no crate holds, by source: node, @term/make, @cluesurf/save,
//                       another @term package, other
//   javascript bind     a bind with no rust case: the emitter writes SEED_UNSUPPORTED_BIND_<name> at each site
//   unresolved module   E0433 and E0432 in pass 2, by the module named (most are the node and global docks)
//   unresolved crate    E0463, or E0432 "no external crate": a crate the manifest does not hold
//   loose read          a value typed unknown or dynamic (the boxed `Rc<dyn Any>`) read as if its type were known: a
//                       field, a method, a call, a format or a walk of it. The source's typing, not the emitter's
//   emitter defect      everything else rustc refuses, by rustc phase (syntax, name, construction, type, borrow,
//                       control) and error code, each with its main.rs line, so it can be minimized
//
// A class that reads zero lets rustc reach its next phase. rustc reports type errors only for the bodies that resolve,
// and borrow errors only for the bodies that type, so every class past name resolution is a lower bound.
//
// THE VERB GROUPS. Every `load` of the entry is a group, and its closure is the files its loads reach (through the
// compiler's own resolver). A Rust item is traced to the files whose top-level statement has its name (a merger suffix
// such as `__native32` is left out), and an error counts for every group whose closure holds one of them. The groups
// overlap, so their sum is not the total, and a name defined in several files counts for each: the totals are exact,
// the groups are a bound. A group's docks are counted from its files' `dock load` lines.
//
// Report only: it writes nothing but its own cargo project and `report.json` in it, and exits 0 whatever rustc says.
//
//   pnpm term:native-entry                  the whole report
//   pnpm term:native-entry --out <dir>      the cargo project and the report somewhere else
//   pnpm term:native-entry --skip-cargo     the compile and the text census only
//   pnpm term:native-entry --reuse          the emitted project already in the folder, no compile (minutes saved)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve as resolvePath } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { cratesNamed } from '@term/make/code/compile/native-main'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { projectHome } from '@term/call/code/home'
import { TERM_ROOT } from './root'

const ENTRY = 'deck/call/code/line/base.tree'
const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(name)
const valueOf = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

type RustError = { line: number; column: number; code: string; message: string }
type Item = { start: number; name: string }
type Statement = { name?: string; span?: { file?: string } }

const read = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const callRoot = (): string => join(TERM_ROOT, 'deck/call')

// a name as both spellings meet: `char-code-at`, `char_code_at`, `CharCodeAt` and `char_code_at__native3` are one
function plain(name: string): string {
  return name.replace(/__.*$/, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// the entry for Rust: its source with prelude and main, and each top-level name's files
function emitEntry(entry: string): { source: string; preludeLines: number; names: Record<string, string[]> } | string[] {
  const root = callRoot()
  const result = compile(
    { file: entry, text: readFileSync(entry, 'utf8') },
    {
      resolve: projectResolver(root, 'rust'),
      roleOf: projectRoleOf(root),
      leanOf: projectLeanOf(root),
      deckOf: projectDeckOf(),
      env: 'rust',
      library: true,
    } as never,
  ) as { ok: boolean; program?: Statement[]; diagnostics?: { name?: string; code?: string; message?: string }[] }

  if (!result.ok || !result.program) {
    return (result.diagnostics ?? []).map(d => `${d.name ?? d.code ?? 'no name'}: ${(d.message ?? '').slice(0, 200)}`)
  }

  const rust = emitRust(result.program as never)
  const prelude = nativePrelude(result.program as never, 'rust', read, rust)
  const names: Record<string, string[]> = {}
  for (const statement of result.program) {
    const file = statement.span?.file
    if (!statement.name || !file) continue
    const key = plain(statement.name)
    const files = (names[key] ??= [])
    const at = relative(TERM_ROOT, file)
    if (!files.includes(at)) files.push(at)
  }
  return { source: [prelude, rust, 'fn main() {}', ''].join('\n'), preludeLines: prelude.split('\n').length, names }
}

// a `use` the emitter wrote for a dock that no crate holds
const UNLINKABLE_USE = /^use (@[^;]+|[^ ;]*:[^:;][^;]*|node::[^;]+);/

function useSource(spec: string): string {
  if (spec.startsWith('node::')) return 'node'
  if (spec.startsWith('@term::make')) return '@term/make'
  if (spec.startsWith('@cluesurf::save')) return '@cluesurf/save'
  if (spec.startsWith('@term::')) return `@term/${spec.split('::')[1]}`
  return 'other'
}

function dockSource(spec: string): string {
  if (spec.startsWith('node:')) return 'node'
  if (spec.startsWith('global:')) return 'global'
  if (spec.startsWith('@term/make')) return '@term/make'
  if (spec.startsWith('@cluesurf/save')) return '@cluesurf/save'
  if (spec.startsWith('@term/')) return `@term/${spec.split('/')[1]}`
  if (spec.startsWith('.')) return 'relative'
  return 'other'
}

const ITEM =
  /^(?:pub(?:\([a-z]+\))? )?(?:async )?(?:unsafe )?(?:extern "C" )?(fn|struct|enum|const|static|type|trait|mod|union|macro_rules!)\s+([A-Za-z_][A-Za-z0-9_]*)/
const IMPL = /^impl(?:<[^{]*?>)?\s+(?:[A-Za-z_][A-Za-z0-9_:<>, ]*\s+for\s+)?([A-Za-z_][A-Za-z0-9_]*)/

// the top-level items of a Rust source, each by its first line
function itemsOf(source: string): Item[] {
  const items: Item[] = []
  source.split('\n').forEach((line, index) => {
    const m = ITEM.exec(line)
    if (m) {
      items.push({ start: index + 1, name: m[2] })
      return
    }
    const impl = IMPL.exec(line)
    if (impl) items.push({ start: index + 1, name: impl[1] })
  })
  return items
}

function itemAt(items: Item[], line: number): Item | undefined {
  let low = 0
  let high = items.length - 1
  let found: Item | undefined
  while (low <= high) {
    const mid = (low + high) >> 1
    if (items[mid].start <= line) {
      found = items[mid]
      low = mid + 1
    } else high = mid - 1
  }
  return found
}

// each load of the entry, and the .tree files its closure reaches
function groupsOf(entry: string): Map<string, Set<string>> {
  const resolve = projectResolver(callRoot(), 'rust')
  const loadsOf = new Map<string, string[]>()
  const loads = (file: string): string[] => {
    const known = loadsOf.get(file)
    if (known) return known
    const found: string[] = []
    for (const m of (read(file) ?? '').matchAll(/^load ([^\s,<>]+)/gm)) {
      const target = resolve(m[1].replaceAll('{platform}', 'rust'), file) as { file: string } | undefined
      if (target?.file?.endsWith('.tree')) found.push(target.file)
    }
    loadsOf.set(file, found)
    return found
  }
  const groups = new Map<string, Set<string>>()
  for (const m of readFileSync(entry, 'utf8').matchAll(/^load (@term\/[^\s,]+)/gm)) {
    const start = resolve(m[1], entry) as { file: string } | undefined
    if (!start) continue
    const seen = new Set([start.file])
    const stack = [start.file]
    while (stack.length) for (const next of loads(stack.pop()!)) if (!seen.has(next)) (seen.add(next), stack.push(next))
    groups.set(
      m[1].replace('@term/call/work/', ''),
      new Set([...seen].map(file => relative(TERM_ROOT, file))),
    )
  }
  return groups
}

// the docks a file writes, from its `dock load` block
function docksOf(file: string): string[] {
  const docks: string[] = []
  let inDock = false
  for (const line of (read(join(TERM_ROOT, file)) ?? '').split('\n')) {
    if (/^dock load\b/.test(line)) {
      inDock = true
      continue
    }
    if (/^\S/.test(line)) inDock = false
    const m = inDock ? /^\s+load <([^>]+)>/.exec(line) : undefined
    if (m) docks.push(m[1])
  }
  return docks
}

function cargoCheck(project: string): { status: number | null; log: string; errors: RustError[] } {
  const run = spawnSync('cargo', ['check', '--quiet', '--message-format', 'short'], {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: { ...process.env, CARGO_TARGET_DIR: join(project, 'target'), RUSTFLAGS: '-A warnings --cap-lints allow' },
  })
  const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  const errors: RustError[] = []
  for (const line of log.split('\n')) {
    const m = /^src\/main\.rs:(\d+):(\d+): error(\[E\d+\])?: (.*)$/.exec(line)
    if (m) errors.push({ line: Number(m[1]), column: Number(m[2]), code: m[3]?.slice(1, -1) ?? 'no code', message: m[4] })
    else if (/^error(\[E\d+\])?: /.test(line) && !/could not compile|aborting due to/.test(line)) {
      errors.push({ line: 0, column: 0, code: /\[(E\d+)\]/.exec(line)?.[1] ?? 'no code', message: line })
    }
  }
  return { status: run.status, log, errors }
}

const KINDS = ['javascript bind', 'unresolved module', 'unresolved crate', 'loose read', 'emitter defect']

// the phase of rustc an error code belongs to, for the emitter defects
const PHASES: [string, RegExp][] = [
  ['syntax', /^no code$/],
  ['name', /^E0(425|428|072|412|422|423|424|531|532|533)$/],
  ['construction', /^E0063$/],
  ['borrow', /^E0(382|499|502|505|506|507|508|594|596|597|716)$/],
  ['control', /^E0(267|268|061)$/],
]

function phaseOf(code: string): string {
  return PHASES.find(([, test]) => test.test(code))?.[0] ?? 'type'
}

function classOf(error: RustError): { kind: string; key: string } {
  const bind = /`SEED_UNSUPPORTED_BIND_([A-Za-z0-9_]+)`/.exec(error.message)
  if (bind) return { kind: 'javascript bind', key: bind[1] }
  if (error.code === 'E0463' || /no external crate/.test(error.message)) {
    return { kind: 'unresolved crate', key: /`([^`]+)`/.exec(error.message)?.[1] ?? error.message }
  }
  if (error.code === 'E0433' || error.code === 'E0432') {
    const named = /`([^`]+)`/.exec(error.message)
    return { kind: 'unresolved module', key: named ? named[1] : error.message.slice(0, 80) }
  }
  // a value typed unknown or dynamic, the boxed `Rc<dyn Any>`, read as if its type were known: a field, a method, a
  // call, a format or a walk of it. The source's typing, not the emitter's (decision 012 of term/compiler)
  if (/^E0(609|599|615|618|277|608)$/.test(error.code) && /\bdyn std::any::Any\b/.test(error.message)) {
    return { kind: 'loose read', key: error.code }
  }
  return { kind: 'emitter defect', key: `${phaseOf(error.code)} ${error.code}` }
}

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function sum(map: Map<string, number>): number {
  let total = 0
  for (const value of map.values()) total += value
  return total
}

function top(map: Map<string, number>, count: number): string[] {
  return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, count).map(([k, v]) => `${v}  ${k}`)
}

function main(): void {
  const out = resolvePath(valueOf('--out') ?? projectHome(TERM_ROOT, 'native-entry'))
  const entry = join(TERM_ROOT, ENTRY)
  const started = Date.now()
  const report: Record<string, unknown> = { entry: ENTRY, at: new Date().toISOString() }
  const kept = join(out, 'emitted.json')
  mkdirSync(join(out, 'src'), { recursive: true })

  let source: string
  let preludeLines: number
  let names: Record<string, string[]>
  if (flag('--reuse') && existsSync(kept) && existsSync(join(out, 'src/main.rs'))) {
    ;({ preludeLines, names } = JSON.parse(readFileSync(kept, 'utf8')))
    source = readFileSync(join(out, 'src/main.rs'), 'utf8').replace(/^\/\/ (use .*)$/gm, '$1')
    console.log(`native-entry: ${ENTRY} for rust, the emitted project reused`)
  } else {
    const emitted = emitEntry(entry)
    const seconds = Math.round((Date.now() - started) / 1000)
    if (Array.isArray(emitted)) {
      console.log(`native-entry: ${ENTRY} for rust, refused (${seconds} s), ${emitted.length} diagnostics:`)
      for (const line of emitted.slice(0, 40)) console.log(`  ${line}`)
      report.refused = emitted
      writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
      return
    }
    ;({ source, preludeLines, names } = emitted)
    console.log(`native-entry: ${ENTRY} for rust, compiled (${seconds} s)`)
    writeFileSync(kept, JSON.stringify({ preludeLines, names }))
  }

  const uses = new Map<string, number>()
  const binds = new Map<string, number>()
  for (const line of source.split('\n')) {
    const use = UNLINKABLE_USE.exec(line)
    if (use) increment(uses, use[1])
    for (const m of line.matchAll(/\bSEED_UNSUPPORTED_BIND_([A-Za-z0-9_]+)/g)) increment(binds, m[1])
  }
  const bySource = new Map<string, { modules: number; lines: number }>()
  for (const [spec, lines] of uses) {
    const group = bySource.get(useSource(spec)) ?? { modules: 0, lines: 0 }
    group.modules += 1
    group.lines += lines
    bySource.set(useSource(spec), group)
  }

  console.log(`  ${source.split('\n').length} lines of Rust, the prelude ${preludeLines}`)
  console.log(`\nunlinkable uses: ${uses.size} modules on ${sum(uses)} lines`)
  for (const [name, group] of [...bySource].sort((a, b) => b[1].lines - a[1].lines)) {
    console.log(`  ${name.padEnd(16)} ${String(group.modules).padStart(4)} modules ${String(group.lines).padStart(5)} lines`)
  }
  for (const line of top(uses, 80)) console.log(`    ${line}`)
  console.log(`\njavascript binds: ${binds.size} names on ${sum(binds)} sites`)
  for (const line of top(binds, 15)) console.log(`  ${line}`)

  report.lines = source.split('\n').length
  report.uses = { modules: uses.size, lines: sum(uses), bySource: Object.fromEntries(bySource), each: Object.fromEntries(uses) }
  report.binds = { names: binds.size, sites: sum(binds) }

  const crates = cratesNamed(source, read(join(TERM_ROOT, 'deck/base/code/native/rust/Cargo.toml')) ?? '')
  writeFileSync(
    join(out, 'Cargo.toml'),
    `[package]\nname = "term-native-entry"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${crates.join('\n')}\n`,
  )
  writeFileSync(join(out, 'src/main.rs'), source)
  report.crates = crates.length

  // the groups and what each holds
  const groups = groupsOf(entry)
  const groupsOfFile = new Map<string, string[]>()
  for (const [group, files] of groups) for (const file of files) (groupsOfFile.get(file) ?? groupsOfFile.set(file, []).get(file)!).push(group)
  const owners = (name: string): string[] => {
    const found = new Set<string>()
    for (const file of names[plain(name)] ?? []) for (const group of groupsOfFile.get(file) ?? []) found.add(group)
    return [...found]
  }
  const rows = new Map<string, Map<string, number>>()
  const row = (group: string): Map<string, number> => rows.get(group) ?? rows.set(group, new Map()).get(group)!
  for (const [group, files] of groups) {
    const here = row(group)
    here.set('files', files.size)
    for (const file of files) for (const dock of docksOf(file)) increment(here, `dock ${dockSource(dock)}`)
  }
  for (const [name, sites] of binds) {
    for (const group of owners(name)) {
      increment(row(group), 'bind names')
      increment(row(group), 'bind sites', sites)
    }
  }

  if (flag('--skip-cargo')) {
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`\nwritten ${out} (cargo skipped)`)
    return
  }

  // pass 1: as emitted
  const first = cargoCheck(out)
  writeFileSync(join(out, 'cargo-1.log'), first.log)
  const firstCodes = new Map<string, number>()
  for (const e of first.errors) increment(firstCodes, e.code)
  console.log(`\npass 1, as emitted: cargo status ${first.status}, ${first.errors.length} errors`)
  for (const line of top(firstCodes, 10)) console.log(`  ${line}`)
  report.pass1 = { status: first.status, errors: first.errors.length, codes: Object.fromEntries(firstCodes) }

  // pass 2: the unlinkable uses commented out
  writeFileSync(join(out, 'src/main.rs'), source.split('\n').map(line => (UNLINKABLE_USE.test(line) ? `// ${line}` : line)).join('\n'))
  const second = cargoCheck(out)
  writeFileSync(join(out, 'cargo-2.log'), second.log)
  writeFileSync(join(out, 'src/main.rs'), source)

  const items = itemsOf(source)
  const lines = source.split('\n')
  const kinds = new Map<string, Map<string, number>>()
  const defects: string[] = []
  for (const error of second.errors) {
    const { kind, key } = classOf(error)
    increment(kinds.get(kind) ?? kinds.set(kind, new Map()).get(kind)!, key)
    const item = error.line > preludeLines ? itemAt(items, error.line) : undefined
    const placed = error.line === 0 ? ['none'] : error.line <= preludeLines ? ['prelude'] : item ? owners(item.name) : []
    for (const group of placed.length ? placed : ['unplaced']) increment(row(group), kind)
    if (kind === 'emitter defect') {
      defects.push(
        `main.rs:${error.line}:${error.column} ${error.code} ${error.message.slice(0, 160)} | in ${item?.name ?? 'the prelude'} (${(item && names[plain(item.name)]?.join(', ')) ?? '?'}) | ${(lines[error.line - 1] ?? '').trim().slice(0, 160)}`,
      )
    }
  }

  console.log(`\npass 2, uses commented out: cargo status ${second.status}, ${second.errors.length} errors`)
  const classes: Record<string, unknown> = {}
  for (const kind of KINDS) {
    const map = kinds.get(kind) ?? new Map<string, number>()
    console.log(`  ${kind}: ${sum(map)} sites on ${map.size} ${kind === 'emitter defect' ? 'codes' : 'names'}`)
    for (const line of top(map, kind === 'emitter defect' ? 30 : 15)) console.log(`    ${line}`)
    classes[kind] = { sites: sum(map), names: map.size, each: Object.fromEntries([...map].sort((a, b) => b[1] - a[1])) }
  }
  console.log('\nemitter defects:')
  for (const line of defects.slice(0, 80)) console.log(`  ${line}`)
  report.pass2 = { status: second.status, errors: second.errors.length, classes, defects }

  const columns = ['files', 'dock node', 'dock global', 'dock @term/make', 'dock @cluesurf/save', 'bind names', 'bind sites', ...KINDS]
  const short = ['files', 'node', 'global', 'make', 'save', 'binds', 'b-sites', 'b-errs', 'module', 'crate', 'loose', 'defect']
  console.log('\nper group (overlapping: a file, a bind or an error counts for every group whose closure holds it):')
  console.log(`  ${'group'.padEnd(20)}${short.map(h => h.padStart(8)).join('')}`)
  const table: Record<string, Record<string, number>> = {}
  for (const [group, here] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${group.padEnd(20)}${columns.map(c => String(here.get(c) ?? 0).padStart(8)).join('')}`)
    table[group] = Object.fromEntries(columns.map(c => [c, here.get(c) ?? 0]))
  }
  report.groups = table

  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\nwritten ${out}, ${Math.round((Date.now() - started) / 1000)} s`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exit(1)
}
