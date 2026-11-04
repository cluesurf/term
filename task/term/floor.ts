// Every non-.tree source file in the Term toolchain, classed against the floor, against a baseline that only shrinks.
//
// THE RULE IT HOLDS (note/project/term/self-host/02-the-floor.md). Term is written in Term, and a source file that is not
// `.tree` is allowed only in one of six classes. Everything else is TypeScript still waiting to be ported, and the
// count of it is the distance left. Without a gate "written in .tree" is a slogan.
//
//   F1 shim       a native runtime shim: any file under a `runtime/` directory inside `code/`, which is where
//                 `nativePrelude` looks for one
//   F2 glue       a file a foreign loader requires in its own language (the VS Code extensions)
//   F3 generated  build output: under a package's `host/`, named `*.generated.*`, or whose FIRST line is a comment that
//                 opens with GENERATED or says @generated. The word anywhere else is prose about generating (D104)
//   F5 manifest   a foreign tool's own format: package.json, Cargo.toml and its lock, Package.swift, a Gradle script,
//                 a pnpm lock, a Dockerfile, an RPM spec
//   F6 oracle     code Term is held against: `test/oracle/**`, `mark/*/idiom.*`, `deck/mark/{demo,kernels}/**`,
//                 `test/native/**`, and the fake npm package of `test/call/test-dock-fixture/vendor/`
//   F7 script     a script a foreign host runs before any `term` exists (HOST_SCRIPTS, each named by D104)
//   port          anything else: TypeScript tooling, its config, its tests, all waiting to become .tree
//
// (F4, an external tool, is a program and not a file in the tree, so nothing here can be one.)
//
// EVERY RULE READS THE TERM-RELATIVE PATH, so `deck/flow/...` and `test/native/...` mean what they say (they were matched
// against a path relative to the deck, and the F2 rule never fired). Build output no git tracks is not counted at all: it
// is `git check-ignore` that says so. A file that is not source (data, media, docs) is listed apart and is no port.
//
// THE STAY LIST. `--stays` takes `git ls-files` and sorts every tracked non-.tree file into D104's classes: the appendix
// of decision/104-everything-ends-as-tree-p11-p12-queue.md, reproduced. `--class <path>...` prints one file's answers.
//
// F1 BY NAME (D029, change/001-finish-self-host/decision/029-host-by-design-ports-three-runtimes-floor.md). Beside the
// path rule, FLOOR_F1_FILES names the runtimes that emitted or served code loads by path, each with its reason.
// task/term/self-host-left.ts imports the same list, so the two tools cannot disagree. The list may only hold such a
// file, and the gate fails on a listed file that no longer exists.
//
// THE CLASS IS DECIDED BY PATH AND HEADER, NEVER BY JUDGEMENT, so the same file is classed the same way twice.
//
// THE BASELINE. note/project/term/self-host/floor.json lists every `port` file as of the last `--commit`. A port file that is
// NOT in it fails at once: new TypeScript in the toolchain is a regression, not a choice. A baselined file now absent
// is removed, the only count called progress. A baselined file present under another class is reclassified, which
// ports nothing. `--commit` rewrites the list, and the list may only shrink, with one named exception:
//
// UNDERCOUNTED AND OWED (D108, change/001-finish-self-host/decision/108-floor-baseline-admits-the-undercounted-and-owes-the-growth.md).
// A file enters `port` only on UNDERCOUNTED AND with a first commit, in its own repository, strictly before the list's
// fixed asOf: git proves the old walk could not see it. Any other file a lead has placed is a row of OWED, outside
// `port`, naming the item that owes it. A row whose item is done or rejected, or does not exist, fails the gate while
// its file exists. A row whose file has gone leaves floor.json on `--commit`. Both lists are lines of this file, seen
// in a diff and added by a lead's Decide: item, and no flag adds to either. A later classifier fix that uncovers more
// files writes a new list under its own decision.
//
//   pnpm term:floor            report, and fail on a new port file, a refused listed file, or an owed row past its item
//   pnpm term:floor --list     every port file, with its lines, then every owed file, with its item
//   pnpm term:floor --commit   rewrite the baseline (shrink only, D108's lists apart)
//   pnpm term:floor --commit --first-write <item>   take a baseline when none exists, refused unless <item> is a done
//                              Decide: item of change 001 citing the flag, since a first write takes the whole set
//   pnpm term:floor --stays [--list]    the tracked non-.tree files by D104's classes, with --list file by file
//   pnpm term:floor --class <path>...   class and stay kind of Term-relative paths

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scan as hostTextScan } from './host-text'
import { PARENT_ROOT, TERM_ROOT, parentPaths, parentRoot } from './root'

// F1 by name (D029): the runtimes emitted or served code imports by path, relative to the Term package
// (the Term root). Each holds its reason. self-host-left.ts reads this list
export const FLOOR_F1_FILES: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'deck/make/code/engine/backend/runtime.ts',
    reason:
      'the RT value library every program the engine TypeScript backend emits imports by path (engine/backend/typescript-text.tree:467)',
  },
  {
    path: 'deck/make/code/view/reactive.ts',
    reason:
      'the signal runtime every emitted view imports by path (view/compile.tree:488); its export shape is a contract with emitted code',
  },
  {
    path: 'deck/make/code/dev/client.ts',
    reason:
      'the browser half of term dev: devClient returns browser JavaScript embedding applyHmr, served at /@seed/client.mjs by deck/call/code/dev/server.ts',
  },
]

// D108 section 2: what the old walk could not see, by path from the repository root. asOf is fixed here and is never
// the baseline's `taken`, which moves on every write
const UNDERCOUNTED: { asOf: string; decision: number; files: ReadonlyArray<string> } = {
  asOf: '2026-10-30',
  decision: 108,
  files: [
    'test/call/commands.ts',
    'test/lint/catalog.ts',
    'test/check/universal.ts',
    'test/compile/feed-mill-bench.ts',
    'test/assurance/hold.sh',
    'test/check/foundation.sh',
    ...parentPaths('deck/zone/test/all.sh'),
    ...parentPaths('deck/zone/test/e2e.sh'),
    ...parentPaths('deck/zone/test/fresh.sh'),
    ...parentPaths('deck/zone/test/help.sh'),
    ...parentPaths('deck/zone/test/load.sh'),
    ...parentPaths('deck/zone/test/save.sh'),
  ],
}

// D108 section 3: files outside `port`, each owed by a named item of change 001
const OWED: ReadonlyArray<{ path: string; item: string }> = [
  { path: 'deck/call/code/launch-only.ts', item: 'term-self-host-001-0721' },
  { path: 'deck/call/code/census-keep.ts', item: 'term-self-host-001-0142' },
  { path: 'deck/make/code/check/hold-key-memo.ts', item: 'term-self-host-001-0748' },
  ...(PARENT_ROOT ? [{ path: parentPaths('deck/zone/test/spot.sh')[0]!, item: 'term-self-host-001-0749' }] : []),
  { path: 'test/compile/list-loose-native.ts', item: 'term-self-host-001-0708' },
  { path: 'test/call/boot-graph.ts', item: 'term-self-host-001-0602' },
  { path: 'test/call/build-entry-ask.ts', item: 'term-self-host-001-0602' },
  { path: 'test/call/test-turns.ts', item: 'term-self-host-001-0605' },
  { path: 'test/call/unit-pool-once.ts', item: 'term-self-host-001-0685' },
  { path: 'test/check/hold-key-memo.ts', item: 'term-self-host-001-0557' },
  { path: 'test/check/none-owner.ts', item: 'term-self-host-001-0560' },
  { path: 'test/check/unsettled-construction.ts', item: 'term-self-host-001-0567' },
  { path: 'test/compile/async-across-units.ts', item: 'term-self-host-001-0569' },
  { path: 'test/compile/carried-trace.ts', item: 'term-self-host-001-0569' },
  { path: 'test/compile/feed-state-fresh.ts', item: 'term-self-host-001-0570' },
  { path: 'test/compile/name-key-run.ts', item: 'term-self-host-001-0573' },
  { path: 'test/compile/raise-memo.ts', item: 'term-self-host-001-0575' },
  { path: 'test/compile/sift-call-subject.ts', item: 'term-self-host-001-0575' },
  { path: 'test/compile/exception-param.ts', item: 'term-self-host-001-0654' },
  { path: 'test/compile/free-element-native.ts', item: 'term-self-host-001-0654' },
  { path: 'test/compile/dynamic-native.ts', item: 'term-self-host-001-0708' },
  { path: 'test/compile/json-negative-zero-native.ts', item: 'term-self-host-001-0708' },
  { path: 'test/compile/made-exception.ts', item: 'term-self-host-001-0656' },
  { path: 'test/compile/melt-kinds.ts', item: 'term-self-host-001-0657' },
  { path: 'test/compile/native-shadow.ts', item: 'term-self-host-001-0657' },
  { path: 'test/compile/slot-raise-native.ts', item: 'term-self-host-001-0659' },
  { path: 'test/compile/slot-raise.ts', item: 'term-self-host-001-0660' },
  { path: 'test/compile/cache-reclaimed.ts', item: 'term-self-host-001-0662' },
  { path: 'test/compile/slot-report.ts', item: 'term-self-host-001-0693' },
  { path: 'test/server/store-clean.ts', item: 'term-self-host-001-0677' },
]

// run from the repository root, the way `pnpm term:floor` runs it
const HOME = TERM_ROOT
const TERM = TERM_ROOT
const BASELINE = join(TERM_ROOT, 'task/term/floor.json')
const CHECKLIST = (): string => join(parentRoot(), 'note/project/term/self-host/change/001-finish-self-host/checklist.json')

const argv = process.argv.slice(2)
const list = argv.includes('--list')
const commit = argv.includes('--commit')

// every Term package, plus the Term repository's own suites, plus zone, which is a Term package living outside it.
// Built on demand, so a tool importing FLOOR_F1_FILES from any directory walks nothing
function listRoots(): Array<{ name: string; dir: string }> {
  return [
    ...readdirSync(join(TERM, 'deck'))
      .sort()
      .filter(name => lstatSync(join(TERM, 'deck', name)).isDirectory())
      .map(name => ({ name: `@term/${name}`, dir: join(TERM, 'deck', name) })),
    { name: 'test/', dir: join(TERM, 'test') },
    // parentPaths answers relative to the Term root, so it is joined to it: run from any other folder, the bare path
    // named a folder that is not there and `git -C` threw
    ...(PARENT_ROOT ? [{ name: '@term/zone', dir: join(TERM, parentPaths('deck/zone')[0]!) }] : []),
  ]
}

const F1_NAMED = new Set(FLOOR_F1_FILES.map(entry => entry.path))

// never walked: dependencies, caches, scratch, and native build output
const SKIP = new Set(['node_modules', '.base', 'tmp', 'target', '.build', '.git', 'link', '.gradle', 'build'])

// source in any language, the upstream benchmarks' own suffixes among them (`nbody.node-8.node`, `nbody.rust`)
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|rs|swift|kt|kts|c|h|go|py|sh|ps1|java|node|kotlin|rust)$/
const MANIFEST =
  /(^|\/)(package\.json|Cargo\.toml|Cargo\.lock|Package\.swift|Package\.resolved|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.vscodeignore|Dockerfile\.[^/]+|[^/]+\.dockerfile|term\.spec)$/

export type Class = 'F1 shim' | 'F2 glue' | 'F3 generated' | 'F5 manifest' | 'F6 oracle' | 'F7 script' | 'port'

// D104's kinds of tracked non-.tree file: six that stay, then what leaves (`config` with the TypeScript, `stray` in
// REMOVE batch 3, `port` by porting)
export type Stay = 'shim' | 'manifest' | 'script' | 'oracle' | 'data' | 'docs' | 'config' | 'stray' | 'port'

const GLUE = [/^deck\/flow\/editor\/vscode\//, /^deck\/test\/code\/vscode\//]

// run before any `term` exists, or inside a distro image, a test desktop or osascript (D104)
const HOST_SCRIPTS = new Set([
  'deck/base/code/find/driver/mac.js',
  'make/find-linux-qt.py',
  'make/find-linux-session.sh',
  'make/find-linux-walk.py',
  'task/dev/bootstrap/start.ps1',
  'task/dev/bootstrap/start.sh',
  'task/distro/debian.sh',
  'task/distro/fedora.sh',
  'task/launcher/term.go',
])

const STRAY = new Set([
  'deck/host/probe.ts',
  'deck/make/code/compile/minting-values.tree.rename.py',
  'deck/test/code/runtime/smt-text.ts.part',
  'deck/bind/code/browser/scripthost/.!85945!.DS_Store',
])

const CONFIG =
  /(^|\/)(tsconfig[^/]*\.json|eslint\.config\.[a-z]+|vitest\.config\.[a-z]+|\.eslintrc\.json|\.prettierrc\.json|\.prettierignore)$|(^|\/)\.vscode\/|^task\/lint\.sh$/
const DOCS = /\.(md|png|svg|css|html)$|(^|\/)(LICENSE|NOTICE|\.gitignore|\.npmignore|\.archiveignore)$/
const DATA = /\.(json|txt|xo|line|tsv|golden)$/

function isOracle(path: string): boolean {
  return (
    /(^|\/)test\/oracle\//.test(path) ||
    /^mark\/[^/]+\/idiom\.[^/]+$/.test(path) ||
    /^deck\/mark\/(demo|kernels)\//.test(path) ||
    /^test\/native\//.test(path) ||
    /^test\/call\/test-dock-fixture\/vendor\//.test(path)
  )
}

// GENERATED is a header only on the first line (past a `#!`), opening a comment. `// GENERATED, so it cannot drift` on
// line 3 of a hand-written page writer, and `// Is a GENERATED reader as fast` as a benchmark's first line, are prose
export function isGeneratedHeader(text: string): boolean {
  const lines = text.slice(0, 600).split('\n')
  const first = lines[0]!.startsWith('#!') ? (lines[1] ?? '') : lines[0]!

  return /^\s*(\/\/+|#+|\/\*+|--)\s*GENERATED\b/.test(first) || /^\s*(\/\/+|#+|\/\*+|--).*@generated\b/.test(first)
}

// the class of a file by its Term-relative path and its text (read only when the path does not settle it). `host/` is
// a package's output folder, never the package named host (T-0483)
export function classOfPath(path: string, read: () => string): Class {
  if (/^host\/|(^|\/)deck\/[^/]+\/host\//.test(path) || /\.generated\.[a-z]+$/.test(path) || /\.data\.js$/.test(path)) {
    return 'F3 generated'
  }

  if (MANIFEST.test(path)) {
    return 'F5 manifest'
  }

  if (isOracle(path)) {
    return 'F6 oracle'
  }

  if (HOST_SCRIPTS.has(path)) {
    return 'F7 script'
  }

  // a runtime shim anywhere, or the per-platform runtime package itself (`native/rust/lib.rs`, the Swift package's
  // `Sources/`), which is the floor's own scaffolding
  if (/(^|\/)code\/(.*\/)?runtime\//.test(path) || /(^|\/)code\/native\/[^/]+\//.test(path)) {
    return 'F1 shim'
  }

  // F1 by name, D029
  if (F1_NAMED.has(path)) {
    return 'F1 shim'
  }

  if (GLUE.some(rule => rule.test(path))) {
    return 'F2 glue'
  }

  return isGeneratedHeader(read()) ? 'F3 generated' : 'port'
}

// which of D104's kinds a tracked non-.tree file is, by its Term-relative path alone
export function stayOf(path: string): Stay {
  if (STRAY.has(path)) {
    return 'stray'
  }

  if (CONFIG.test(path)) {
    return 'config'
  }

  if (MANIFEST.test(path)) {
    return 'manifest'
  }

  if (HOST_SCRIPTS.has(path)) {
    return 'script'
  }

  if (isOracle(path)) {
    return 'oracle'
  }

  // deck/mark's own programs are .ts waiting to port. What it holds beside them (expected output) belongs to the oracles
  if (/^deck\/mark\//.test(path) && !SOURCE.test(path) && !/\.md$/.test(path)) {
    return 'oracle'
  }

  if (/\.(rs|swift|kt)$/.test(path) && classOfPath(path, () => '') === 'F1 shim') {
    return 'shim'
  }

  if (DOCS.test(path)) {
    return 'docs'
  }

  return DATA.test(path) ? 'data' : 'port'
}

// the files git ignores, of those named relative to `dir`. Exit 1 is "none", any other failure is no answer
function ignoredIn(dir: string, paths: string[]): Set<string> {
  try {
    const out = execFileSync('git', ['-C', dir, 'check-ignore', '--stdin', '-z'], {
      input: paths.join('\0'),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    })

    return new Set(out.toString('utf8').split('\0').filter(path => path !== ''))
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      return new Set<string>()
    }

    throw new Error(`git check-ignore failed in ${dir}`)
  }
}

type Found = { root: string; path: string; key: string; full: string; lines: number; cls: Class }

// the date of a file's first commit, asked of the repository that holds it (deck/zone is its own), or nothing when no
// commit holds it. --follow lists the oldest add last
function firstCommitOf(full: string): string | undefined {
  try {
    const out = execFileSync(
      'git',
      ['-C', dirname(full), 'log', '--follow', '--diff-filter=A', '--format=%cs', '--', basename(full)],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )

    return out.toString('utf8').split('\n').filter(line => line !== '').pop()
  } catch {
    return undefined
  }
}

// each item of change 001 by id, with its state. No checklist reads as no item. With no parent named there is no
// checklist to read: undefined, and the owed rows go unjudged (a --commit names the parent, so it never writes them so)
function readItemStates(): Map<string, string> | undefined {
  if (PARENT_ROOT === undefined && !commit) {
    return undefined
  }

  if (!existsSync(CHECKLIST())) {
    return new Map()
  }

  const items: Array<{ id: string; state: string }> = JSON.parse(readFileSync(CHECKLIST(), 'utf8')).item

  return new Map(items.map(entry => [entry.id, entry.state]))
}

// the item a first write names, the word after --first-write
function firstWriteItem(): string | undefined {
  const at = argv.indexOf('--first-write')
  const word = at === -1 ? undefined : argv[at + 1]

  return word === undefined || word.startsWith('--') ? undefined : word
}

// the reason a first write may not go ahead, if there is one. It takes the whole set, so deleting floor.json would admit
// any growth: only a finished Decide: item of change 001 that cites this flag names one (item 0753)
function firstWriteRefusal(id: string | undefined): string | undefined {
  if (id === undefined) {
    return '--first-write names no item, and it must name the finished Decide: item that cites it'
  }

  const items: Array<{ id: string; state: string; what?: string; proof?: string }> = existsSync(CHECKLIST())
    ? JSON.parse(readFileSync(CHECKLIST(), 'utf8')).item
    : []
  const item = items.find(entry => entry.id === id)

  if (item === undefined) {
    return `${id} does not exist`
  }

  if (!(item.what ?? '').startsWith('Decide:')) {
    return `${id} is not a Decide: item`
  }

  if (item.state !== 'done') {
    return `${id} is ${item.state}, not done`
  }

  return `${item.what} ${item.proof ?? ''}`.includes('--first-write') ? undefined : `${id} does not cite --first-write`
}

// the reason a row with a file on disk fails the gate, if it does
function rowFailure(row: { path: string; item: string }, states: Map<string, string>): string | undefined {
  const state = states.get(row.item)

  if (state === undefined) {
    return `${row.path}: its item ${row.item} does not exist`
  }

  return state === 'done' || state === 'rejected' ? `${row.path}: its item ${row.item} is ${state}, and the file is still here` : undefined
}

function walk(root: { name: string; dir: string }, dir: string, out: Found[], apart: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.endsWith('-cache') || name.startsWith('.env')) {
      continue
    }

    const full = join(dir, name)
    const stat = lstatSync(full)

    // a symlink points back into the tree, and following one loops (rename plan, lesson 2)
    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      walk(root, full, out, apart)
      continue
    }

    const path = relative(TERM, full)

    if (name.endsWith('.tree')) {
      continue
    }

    if (!SOURCE.test(name) && !MANIFEST.test(path)) {
      apart.push(full)
      continue
    }

    if (name.endsWith('.d.ts')) {
      continue
    }

    const text = readFileSync(full, 'utf8')
    const cls = classOfPath(path, () => text)

    out.push({ root: root.name, path, key: relative(HOME, full), full, lines: text.split('\n').length, cls })
  }
}

// `--stays`: every tracked non-.tree file of the Term repository, by D104's kinds
function printStays(): void {
  const tracked = execFileSync('git', ['-C', TERM, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(path => path !== '' && !path.endsWith('.tree'))
  const kinds: Stay[] = ['shim', 'manifest', 'script', 'oracle', 'data', 'docs', 'config', 'stray', 'port']

  console.log(`term floor: ${tracked.length} tracked files are not .tree`)

  for (const kind of kinds) {
    const mine = tracked.filter(path => stayOf(path) === kind).sort()

    console.log(`  ${kind.padEnd(9)} ${String(mine.length).padStart(5)}`)

    if (list) {
      for (const path of mine) {
        console.log(`    ${path}`)
      }
    }
  }
}

// `--class <path>...`: what the two rules answer for each Term-relative path
function printClasses(paths: string[]): void {
  for (const path of paths) {
    const full = join(TERM, path)
    const cls = classOfPath(path, () => (existsSync(full) ? readFileSync(full, 'utf8') : ''))

    console.log(`${cls}\t${stayOf(path)}\t${path}`)
  }
}

function main(): void {
  if (argv.includes('--stays')) {
    printStays()
    return
  }

  if (argv[0] === '--class') {
    printClasses(argv.slice(1))
    return
  }

  const ROOTS = listRoots()
  let found: Found[] = []
  let apart: string[] = []

  // a named F1 file that has gone fails the gate: the list may only name a file that exists
  const missing = FLOOR_F1_FILES.filter(entry => !existsSync(join(TERM, entry.path)))

  if (missing.length > 0) {
    console.log('term floor: FLOOR_F1_FILES names file(s) that do not exist. Take each off the list (D029):')

    for (const entry of missing) {
      console.log(`    ${entry.path}`)
    }

    process.exitCode = 1
    return
  }

  for (const root of ROOTS) {
    if (existsSync(root.dir)) {
      walk(root, root.dir, found, apart)
    }
  }

  // build output no git tracks is no file of the toolchain (`deck/flow/make/server.js`, every `host/`). deck/zone is its
  // own repository, so each root asks its own
  const notTracked = new Set<string>()

  for (const root of ROOTS) {
    const inside = [...found.map(f => f.full), ...apart].filter(full => full.startsWith(`${root.dir}/`))

    for (const path of ignoredIn(root.dir, inside.map(full => relative(root.dir, full)))) {
      notTracked.add(join(root.dir, path))
    }
  }

  found = found.filter(f => !notTracked.has(f.full))
  apart = apart.filter(full => !notTracked.has(full))

  // what the class says is outside the floor, and of that what `port` may hold: a row of OWED never reaches it (D108)
  const outside = found.filter(f => f.cls === 'port')
  const owedKeys = new Set(OWED.map(row => row.path))
  const ports = outside.filter(f => !owedKeys.has(f.key))
  const portKeys = new Set(ports.map(f => f.key))
  const owedHere = OWED.filter(row => existsSync(join(HOME, row.path)))
  const old: { port: string[]; owed?: Array<{ path: string; item: string }> } = existsSync(BASELINE)
    ? JSON.parse(readFileSync(BASELINE, 'utf8'))
    : { port: [] }
  const baseline = old.port
  const held = new Set(baseline)
  // with no baseline yet there is nothing to be new against, and a --commit --first-write takes the whole set
  const unheld = existsSync(BASELINE) ? ports.filter(f => !held.has(f.key)) : []
  const listed = new Set(UNDERCOUNTED.files)
  const fresh = unheld.filter(f => !listed.has(f.key))
  const admitted: Found[] = []
  const refused: string[] = []

  for (const f of unheld.filter(f => listed.has(f.key))) {
    const first = firstCommitOf(f.full)

    if (first === undefined) {
      refused.push(`${f.key}: no commit holds it`)
    } else if (first < UNDERCOUNTED.asOf) {
      admitted.push(f)
    } else {
      refused.push(`${f.key}: its first commit, ${first}, is not before ${UNDERCOUNTED.asOf}`)
    }
  }

  const states = readItemStates()
  const failures = states === undefined ? [] : owedHere.flatMap(row => rowFailure(row, states) ?? [])
  const left = baseline.filter(key => !portKeys.has(key))
  const removed = [
    ...left.filter(key => !existsSync(join(HOME, key))),
    ...(old.owed ?? []).map(row => row.path).filter(path => !existsSync(join(HOME, path))),
  ]
  const reclassified = left.filter(key => existsSync(join(HOME, key)))

  console.log('term floor: every non-.tree source in the Term toolchain')
  console.log('')
  console.log(`  ${'package'.padEnd(14)} ${'port'.padStart(6)} ${'lines'.padStart(8)}   ${'F1'.padStart(5)} ${'F2'.padStart(3)} ${'F3'.padStart(5)} ${'F5'.padStart(4)} ${'F6'.padStart(3)} ${'F7'.padStart(3)}`)

  for (const root of ROOTS) {
    const mine = found.filter(f => f.root === root.name)

    if (mine.length === 0) {
      continue
    }

    const count = (cls: Class): number => mine.filter(f => f.cls === cls).length
    const portLines = mine.filter(f => f.cls === 'port').reduce((sum, f) => sum + f.lines, 0)

    console.log(
      `  ${root.name.padEnd(14)} ${String(count('port')).padStart(6)} ${String(portLines).padStart(8)}   ${String(count('F1 shim')).padStart(5)} ${String(count('F2 glue')).padStart(3)} ${String(count('F3 generated')).padStart(5)} ${String(count('F5 manifest')).padStart(4)} ${String(count('F6 oracle')).padStart(3)} ${String(count('F7 script')).padStart(3)}`,
    )
  }

  const total = outside.reduce((sum, f) => sum + f.lines, 0)
  const portTotal = ports.reduce((sum, f) => sum + f.lines, 0)

  console.log('')
  console.log(`  F1 by name (D029), ${FLOOR_F1_FILES.length} file(s):`)

  for (const entry of FLOOR_F1_FILES) {
    const hit = found.find(f => relative(TERM, join(HOME, f.key)) === entry.path)
    console.log(`    ${hit?.cls ?? 'not walked'}  ${entry.path}`)
  }

  console.log('')
  console.log(`  ${outside.length} files and ${total} lines outside the floor, waiting to be ported`)
  console.log(`  port: ${ports.length} file(s)`)
  console.log(`  owed: ${owedHere.length} file(s) outside \`port\`, each held by a named item (D108)`)

  const apartBy = new Map<string, number>()

  for (const full of apart) {
    const stay = stayOf(relative(TERM, full))
    const kind = stay === 'port' ? 'other' : stay
    apartBy.set(kind, (apartBy.get(kind) ?? 0) + 1)
  }

  console.log(`  apart, not source: ${apart.length} (${[...apartBy].sort().map(([kind, n]) => `${kind} ${n}`).join(', ')})`)

  // a .tree suite holding JavaScript is no port either (decision 113), and this walk cannot see it: pnpm term:host-text
  // reads it, gate 0152 wants refused, arrow and facts at 0
  const hostText = hostTextScan({ term: TERM, prefixes: [] }).total
  console.log(
    `  host text in suites: refused ${hostText.refused}, arrow ${hostText.arrow}, facts ${hostText.facts}, declared ${hostText.declared}, held files ${hostText.heldFiles} (D113, pnpm term:host-text)`,
  )

  if (list) {
    console.log('')

    for (const f of ports) {
      console.log(`  ${String(f.lines).padStart(6)}  ${f.key}`)
    }

    console.log('')

    for (const row of owedHere) {
      console.log(`  owed by ${row.item}  ${row.path}`)
    }
  }

  // task/term/baselines.ts reads this line's count as the gone figure
  if (removed.length > 0) {
    console.log('')
    console.log(`  ${removed.length} baselined file(s) are gone: progress. \`--commit\` takes them off the list`)
  }

  if (reclassified.length > 0) {
    console.log('')
    console.log(`  ${reclassified.length} reclassified: the file is here and its class is no longer port, so nothing was ported. \`--commit\` takes them off the list:`)

    for (const key of reclassified) {
      console.log(`    ${key}`)
    }
  }

  if (admitted.length > 0) {
    console.log('')
    console.log(`  ${admitted.length} undercounted: first committed before ${UNDERCOUNTED.asOf} (D${UNDERCOUNTED.decision}). \`--commit\` adds them to port`)
  }

  if (refused.length > 0) {
    console.log('')
    console.log(`  REFUSED from UNDERCOUNTED, ${refused.length} file(s). Git does not prove it predates the list:`)

    for (const line of refused) {
      console.log(`    ${line}`)
    }
  }

  if (states === undefined && owedHere.length > 0) {
    console.log('')
    console.log(`  owed rows not judged, ${owedHere.length}: TERM_PARENT_ROOT is unset, so there is no checklist to read`)
  }

  if (failures.length > 0) {
    console.log('')
    console.log(`  OWED rows past their item, ${failures.length}. Port or remove the file, or a lead re-places the row:`)

    for (const line of failures) {
      console.log(`    ${line}`)
    }
  }

  if (!existsSync(BASELINE) && !commit) {
    console.log('')
    console.log('term floor: no baseline yet. `pnpm term:floor --commit --first-write <item>` takes one')
    process.exitCode = 1
    return
  }

  if (existsSync(BASELINE) && argv.includes('--first-write')) {
    console.log('')
    console.log('term floor: refusing --first-write with a baseline present. It names a first write and nothing else')
    process.exitCode = 1
    return
  }

  if (!existsSync(BASELINE)) {
    const named = firstWriteItem()
    const refusal = firstWriteRefusal(named)

    console.log('')

    if (refusal !== undefined) {
      console.log(`term floor: refusing --commit, no floor.json, and a first write takes the whole set: ${refusal}`)
      process.exitCode = 1
      return
    }

    console.log(`term floor: first write, named by ${named}`)
  }

  if (fresh.length > 0) {
    console.log('')
    console.log(`  NEW outside the floor, ${fresh.length} file(s). Write it in .tree, or class it by path:`)

    for (const f of fresh) {
      console.log(`    ${f.key}`)
    }
  }

  if (commit) {
    // shrink only: the baseline may lose files and gain only what UNDERCOUNTED proves, except on a first write a Decide named
    if (fresh.length > 0 || refused.length > 0) {
      console.log('')
      console.log('term floor: refusing --commit, the baseline would grow')
      process.exitCode = 1
      return
    }

    if (failures.length > 0) {
      console.log('')
      console.log('term floor: refusing --commit, an owed row outlived its item')
      process.exitCode = 1
      return
    }

    const record = {
      note: 'Every non-.tree source in the Term toolchain outside the floor classes. `port` may only shrink, but for the files UNDERCOUNTED proves. `owed` is outside it, each file held by a named item (D108). Written by pnpm term:floor --commit.',
      taken: new Date().toISOString().slice(0, 10),
      files: ports.length,
      lines: portTotal,
      owed_files: owedHere.length,
      port: ports.map(f => f.key).sort(),
      owed: [...owedHere].sort((a, b) => (a.path < b.path ? -1 : 1)),
    }

    writeFileSync(BASELINE, `${JSON.stringify(record, null, 2)}\n`)
    console.log('')
    console.log(`wrote ${relative(HOME, BASELINE)}`)
    return
  }

  if (fresh.length > 0 || refused.length > 0 || failures.length > 0) {
    process.exitCode = 1
  }
}

// run as a command, never on import (self-host-left.ts imports FLOOR_F1_FILES)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
