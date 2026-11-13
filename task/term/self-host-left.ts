// What is still TypeScript in every Term deck, and why, by bucket (term-self-host-001-0013).
//
// One command instead of a scout's hand count, so every milestone's gate is `self-host-left.ts --deck <d>`. It replaces
// tmp/remaining-make.sh, which is wrong in two ways: it hides a TWIN (a `.ts` with a `.tree` of the same path, still the
// live code because tsconfig.json tries the `.ts` first) and it counts a FAT FACE (a `.ts` that calls its port and still
// holds logic, state or IO) as unported.
//
//   tsx task/term/self-host-left.ts [--deck <d>] [--json]
//   tsx task/term/self-host-left.ts --line [--deck <d>] [--json]    the .ts in each of make:line's six bundles, per deck,
//                                                                     then the hidden-dock check (exit 1 on a refusal)
//   tsx task/term/self-host-left.ts --hidden [--ports <dir>]...       the hidden-dock check alone, over every emitted port
//                                                                     or only the folders named
//   pnpm term:left [--line] ...                                       the same, from the repository root
//
// Walked: every deck under <term>/deck/ (named by its folder: `make`, `call`, ...) and the Term package's own `test/`,
// `task/`, `hold/` and `mark/` (named `pkg/test`, `pkg/task`, `pkg/hold`, `pkg/mark`). `--deck pkg` takes all four.
// The excludes are floor.ts's, plus `host/` and `*-cache`, and any file git ignores: build output no git tracks
// (`deck/flow/make/*`) is not counted (D104). A file counts when it is source: `.ts`, `.mts`, `.mjs`, `.js`, or the foreign
// `.rs`, `.swift`, `.kt`, `.py`, `.sh`, `.go`, `.ps1`, and is not `.d.ts` or `*.generated.ts`. Every other file (data,
// media, docs, manifests, config) is listed apart by D104's kind, in the verdict and as `apart` in the JSON, and is in no
// bucket. Every counted file lands in exactly one bucket, taken in this order:
//
//   owned      a path note/project/workflow/locks.json marks `owned` (the underlying bucket is kept as `class` in --json)
//   floor-f6/7 an oracle or a script a foreign host runs, by floor.ts's path rules. A foreign file goes straight to its
//              floor class: it has no imports to read
//   twin       a `.tree` of the same path exists and the `.ts` is a full body: it imports no port
//   thin-face  imports a port of its OWN deck, is under 150 lines, and holds no module state and no Node IO (isThin)
//   fat-face   imports a port of its own deck and holds more
//   pipeline   the 14 files of change 001's spec §1 item 1 (compile.ts and the 13 passes it drives)
//   host       the host-by-design files D029 ports: the six time/ drivers and check/views
//   dead       D029's dead files, which REMOVE batch 2 deletes
//   floor-fN   floor.ts's own classes by path and first-line header (F1 `runtime/` shims and FLOOR_F1_FILES, F2 vscode
//              glue, F3 generated)
//   unported   everything else
//
// A PORT is an import whose target has no `.ts` (`.mts`, `.mjs`, `.js`) of its own but has a `.tree` of the same path,
// or lies under a `host/port/` directory: the tsconfig `paths` second candidate. IMPORTERS are the walked files, plus the
// repository's own `task/term/` scripts, that import a file by any specifier: relative, `@term/<deck>/...`, `@/...`,
// a dynamic `import()` or a `require`.
//
// A `.tree` DOCK is an importer too (term-self-host-001-1296, decision 157 rule 4, trap T-0118). Every `.tree` under the
// walked roots is read as the build reads it: `buildable` (deck/call/code/make.ts) turns a file of `test` blocks into
// its rewritten text and a feed grammar into the reader it generates, then the compiler's parser
// (`@term/make/code/parser/tree`) reads that, its nodes walked the way dock-aliases.ts walks them, never a regex. Each
// `load <module>` whose module resolves to a walked `.ts` is an edge, its importer the `.tree` path. A shelved `.tree`
// (`mark draft`) is read too and flagged `shelved`: the build skips it, but it still names the module and breaks when
// unshelved. A `.tree` that neither builds nor parses is listed as unread, never passed over. Each dock is marked
// SUBJECT when the `.tree` is the target's own suite, and OTHER otherwise. A suite is the target's own when it is
//   - a suite of the target's deck, `deck/<d>/test/**/*.test.tree` docking a file under `deck/<d>/` (decision 157 rule
//     1: the deck/deck suites are statement ports of the faces' own tests, owed with the face), or
//   - a package suite of the same path, `test/<p>.tree` docking `deck/<d>/code/<p>.ts` (decision 106 rule 2).
// An OTHER dock of a face loads the port now (decision 157 rule 2), and gate 0137 step 1 fails on one. The JSON's
// `docks` lists every dock of a file with its mark, and `treeDocks` and the verdict list every `.tree` that docks the
// counted TypeScript, a face or not (index.ts and form.ts are `unported` here and still owed by decision 153).
//
// Output: the verdict (at most 15 lines, then one line per `.tree` docking the counted TypeScript) on stdout and the
// full list in <term>/tmp/self-host/left/<date>.json (with `--deck d`, `<date>-d.json`, so a limited run never replaces
// the full one). `--json` prints that JSON instead.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { classOfPath, FLOOR_F1_FILES, stayOf } from './floor'
import { PARENT_ROOT, TERM_ROOT, parentRoot } from './root'
// the shelf marker, spelled as deck/call/code/draft.ts tests it (an unindented `mark draft` or `note draft` line). Not
// imported: draft.ts reaches a PORT (draft-mark.tree) through the Term package's tsconfig paths, which a run from the
// repository root never reads, and the import failed as "Cannot find module @term/call/code/draft"
const declaresDraft = (text: string): boolean => /^(mark|note) draft\s*$/m.test(text)

// absolute, so the command works from any directory (the way save-before.ts does)
const REPO = TERM_ROOT
const TERM = TERM_ROOT
const LOCKS = (): string => join(parentRoot(), 'note/project/workflow/locks.json')
const OUT = join(TERM, 'tmp/self-host/left')

const BUCKETS = [
  'owned',
  'twin',
  'thin-face',
  'fat-face',
  'pipeline',
  'host',
  'dead',
  'floor-f1',
  'floor-f2',
  'floor-f3',
  'floor-f5',
  'floor-f6',
  'floor-f7',
  'unported',
] as const

type Bucket = (typeof BUCKETS)[number]

// the 14 pipeline files, spec.md §1 item 1: compile.ts, the passes it drives, and the query layer. Their lines sum to
// the 4,890 of state.md
const PIPELINE = new Set(
  [
    'compile/compile',
    'compile/emit-target',
    'compile/def-pass',
    'compile/incremental-parse',
    'compile/subscribe',
    'compile/stub',
    'compile/cache',
    'compile/query',
    'compile/incremental',
    'compile/analyzer',
    'compile/separate',
    'compile/watch',
    'compile/worker-pool',
    'compile/def-worker',
  ].map(name => `deck/make/code/${name}.ts`),
)

// the host-by-design files D029 (item 0092) ports: the six time/ drivers, and check/views (item 0103's). The three
// runtimes are F1 by name (FLOOR_F1_FILES, floor.ts), the dead three are DEAD below
const HOST = new Set(
  [
    'time/benchmark',
    'time/cpu',
    'time/execute',
    'time/memory',
    'time/output',
    'time/runner',
    'check/views',
  ].map(name => `deck/make/code/${name}.ts`),
)

// F1 by name: one list with floor.ts, so the two tools cannot disagree (D029)
const F1_NAMED = new Set(FLOOR_F1_FILES.map(entry => entry.path))

// dead by D029: REMOVE batch 2 (item term-self-host-001-0118) deletes them. engine/backend/typescript.ts was copied to
// test/engine/backend/compiled.ts, its one importer's helper
const DEAD = new Set(
  ['view/terminal', 'lint/seed-rule', 'engine/backend/typescript'].map(name => `deck/make/code/${name}.ts`),
)

// never walked: floor.ts's own list, and the generated and cached folders the brief names
const SKIP = new Set(['node_modules', '.base', 'tmp', 'target', '.build', '.git', 'link', '.gradle', 'build', 'host'])
const CODE = /\.(ts|mts|mjs|js)$/
const CODE_EXT = ['.ts', '.mts', '.mjs', '.js']
// foreign source: counted and classed by path. CODE alone is what an import can resolve to
const FOREIGN = /\.(rs|swift|kt|py|sh|go|ps1)$/

type Root = { name: string; dir: string; deck: string | null }

type File = {
  abs: string
  path: string
  root: Root
  lines: number
  text: string
  bucket: Bucket
  owned: Bucket | null
  importers: string[]
  port: string[]
  docks: TreeDock[]
}

// a `.tree` that docks the file, whether the file is that suite's subject (decision 157), and whether it is shelved
type TreeDock = { tree: string; mark: 'subject' | 'other'; shelved: boolean }

// the compiler's parser and the build's one reading of a file, the ones short-loads.ts imports: the Term tsconfig's
// `@term/*` paths reach them. Imported by `main` before any `.tree` is read, so `--line` and `--hidden` never load them
let parse: (source: { file: string; text: string }) => { ok: boolean; tree: { nodes: Array<unknown> } }
let buildable: (file: string, source: string) => { text: string } | { faults: string[] }

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const wantJson = args.includes('--json')
  let only: string | null = null
  let portDirs: string[] | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === '--deck') {
      only = args[i + 1] ?? null

      if (only === null || only.startsWith('--')) {
        fail('--deck needs a name')
      }

      i++
    } else if (arg === '--ports') {
      const dir = args[i + 1]

      if (dir === undefined || dir.startsWith('--')) {
        fail('--ports needs a folder')
      }

      portDirs = [...(portDirs ?? []), resolve(dir)]
      i++
    } else if (arg !== '--json' && arg !== '--line' && arg !== '--hidden') {
      fail(`unknown argument ${arg}`)
    }
  }

  if (args.includes('--line') || args.includes('--hidden')) {
    const bundles = args.includes('--line') ? lineCount(only) : undefined
    const hidden = hiddenDocks(portDirs ?? listPortDirs())

    // an allowlist entry is stale only when every port was read
    if (portDirs !== null) {
      hidden.unused = []
    }

    if (wantJson) {
      console.log(JSON.stringify({ ...(bundles ? { bundle: bundles } : {}), hidden }, null, 2))
    } else {
      if (bundles) {
        printBundles(bundles)
      }

      printHidden(hidden)
    }

    const missing = bundles?.some(bundle => bundle.built === null) ?? false

    if (hidden.refused.length > 0 || missing) {
      process.exitCode = 1
    }

    return
  }

  const roots = listRoots()

  if (only !== null && !roots.some(root => matches(root, only!))) {
    fail(`no deck ${only}; have ${roots.map(root => root.name).join(' ')}`)
  }

  const walked: File[] = []
  const apartWalked: Array<{ path: string; root: Root }> = []
  const treesWalked: string[] = []

  for (const root of roots) {
    walk(root, root.dir, walked, apartWalked, treesWalked)
  }

  const ignored = gitIgnored([
    ...walked.map(file => file.path),
    ...apartWalked.map(file => file.path),
    ...treesWalked.map(abs => relative(TERM, abs)),
  ])
  const files = walked.filter(file => !ignored.has(file.path))
  const apartFiles = apartWalked.filter(file => !ignored.has(file.path))
  const trees = treesWalked.filter(abs => !ignored.has(relative(TERM, abs)))

  const byAbs = new Map(files.map(file => [file.abs, file]))
  const locks = readLocks()

  // every import edge, built once over the walked files and the repository's own task/term scripts
  const outside = scripts()
  const edges = new Map<File, Set<string>>()

  for (const file of [...files.filter(one => CODE.test(one.abs)), ...outside]) {
    for (const spec of importsOf(file.text)) {
      const found = resolveImport(spec, file.abs)

      const target = found.file === null ? undefined : byAbs.get(found.file)

      if (target !== undefined && target !== file) {
        const importer = file.root.name === 'repo' ? `repo:${relative(REPO, file.abs)}` : file.path
        const seen = edges.get(target) ?? new Set<string>()
        seen.add(importer)
        edges.set(target, seen)
      }
    }
  }

  // every `.tree` dock of a walked file (T-0118: the edges above read code files only)
  parse = (await import('@term/make/code/parser/tree')).parse
  buildable = (await import('@term/call/code/make')).buildable
  const treeRead = treeDocks(trees, byAbs)

  for (const [target, docks] of treeRead.docks) {
    const seen = edges.get(target) ?? new Set<string>()

    for (const dock of docks) {
      seen.add(dock.tree)
    }

    edges.set(target, seen)
    target.docks = docks.sort((a, b) => a.tree.localeCompare(b.tree))
  }

  for (const file of files) {
    file.importers = [...(edges.get(file) ?? [])].sort()
    file.port = CODE.test(file.abs) ? [...new Set(ports(file).module)].sort() : []
    const under = bucketOf(file, locks)
    file.bucket = under.bucket
    file.owned = under.owned
  }

  const kept = only === null ? files : files.filter(file => matches(file.root, only!))
  const apart: Record<string, number> = {}

  for (const file of apartFiles) {
    if (only === null || matches(file.root, only)) {
      const kind = stayOf(file.path)
      apart[kind] = (apart[kind] ?? 0) + 1
    }
  }

  // the invariant: one bucket per file, and the buckets sum to the files walked
  const total = BUCKETS.reduce((sum, bucket) => sum + kept.filter(file => file.bucket === bucket).length, 0)

  if (total !== kept.length) {
    fail(`buckets hold ${total} files and ${kept.length} were walked`)
  }

  const record = {
    taken: today(),
    term: TERM,
    deck: only,
    files: kept.length,
    lines: kept.reduce((sum, file) => sum + file.lines, 0),
    bucket: tally(kept),
    apart,
    tree: { read: treeRead.read, shelved: treeRead.shelved, unread: treeRead.unread },
    treeDocks: treeDocksOf(kept),
    deckBucket: Object.fromEntries(
      roots
        .filter(root => kept.some(file => file.root === root))
        .map(root => [root.name, tally(kept.filter(file => file.root === root))]),
    ),
    file: kept.map(file => ({
      path: file.path,
      deck: file.root.name,
      bucket: file.bucket,
      ...(file.owned === null ? {} : { class: file.owned }),
      lines: file.lines,
      importers: file.importers,
      port: file.port,
      docks: file.docks,
    })),
  }

  mkdirSync(OUT, { recursive: true })
  const name = `${record.taken}${only === null ? '' : `-${only.replace(/\//g, '-')}`}.json`
  const target = join(OUT, name)
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`)

  if (wantJson) {
    console.log(JSON.stringify(record, null, 2))
    return
  }

  verdict(roots, kept, target, apart)
  printTreeDocks(record.treeDocks, record.tree)
}

// THE .TREE DOCKS (term-self-host-001-1296). Each `.tree` is read by the compiler's parser, and every `load` whose
// target is a text (`load <module>, name alias`, under a `dock` or not, at any depth) is a dock, read off the parse tree
// as dock-aliases.ts reads it. A `{platform}` module and one naming no walked file are not edges.
type TreeRead = { docks: Map<File, TreeDock[]>; read: number; shelved: number; unread: string[] }

function treeDocks(trees: string[], byAbs: Map<string, File>): TreeRead {
  const docks = new Map<File, TreeDock[]>()
  let read = 0
  let shelved = 0
  const unread: string[] = []

  for (const abs of trees) {
    const source = readFileSync(abs, 'utf8')

    // a cheap filter: a dock this tool can resolve names `<.` or `<@`, and the parse below decides what is a dock
    if (!source.includes('<@') && !source.includes('<.')) {
      continue
    }

    const tree = relative(TERM, abs)
    const built = buildable(abs, source)

    if (!('text' in built)) {
      unread.push(tree)
      continue
    }

    const parsed = parse({ file: abs, text: built.text })

    if (!parsed.ok) {
      unread.push(tree)
      continue
    }

    const isShelved = declaresDraft(source)
    read++

    if (isShelved) {
      shelved++
    }

    for (const module of dockedModules(parsed.tree.nodes as ParseNode[])) {
      const found = resolveImport(module, abs)
      const target = found.file === null ? undefined : byAbs.get(found.file)

      if (target === undefined) {
        continue
      }

      const list = docks.get(target) ?? []

      if (!list.some(dock => dock.tree === tree)) {
        list.push({ tree, mark: subjectOf(tree, target.path) ? 'subject' : 'other', shelved: isShelved })
      }

      docks.set(target, list)
    }
  }

  return { docks, read, shelved, unread: unread.sort() }
}

// the parser's node, as much of it as this reads (dock-aliases.ts's shape)
type ParsePart = { kind: string; text?: string }
type ParseNode = { kind: string; nodes?: ParseNode[]; parts?: ParsePart[] }

// a name or text node's plain text, or undefined when it interpolates (`{platform}`) or is another kind
function plainOf(node: ParseNode | undefined): string | undefined {
  if (!node || (node.kind !== 'name' && node.kind !== 'text') || !node.parts) {
    return undefined
  }

  if (!node.parts.every(part => part.kind === 'chunk')) {
    return undefined
  }

  return node.parts.map(part => part.text ?? '').join('')
}

function headOf(node: ParseNode | undefined): string | undefined {
  const first = node?.kind === 'group' ? node.nodes?.[0] : undefined

  return first?.kind === 'name' ? plainOf(first) : undefined
}

function dockedModules(nodes: ParseNode[]): string[] {
  const out: string[] = []

  const visit = (group: ParseNode): void => {
    if (headOf(group) === 'load') {
      const target = group.nodes?.[1]
      const module = target?.kind === 'text' ? plainOf(target) : undefined

      if (module !== undefined) {
        out.push(module)
      }
    }

    for (const child of group.nodes?.slice(1) ?? []) {
      if (child.kind === 'group') {
        visit(child)
      }
    }
  }

  for (const group of nodes) {
    if (group.kind === 'group') {
      visit(group)
    }
  }

  return out
}

// SUBJECT: the target's own suite (the header above). Decision 157's census reads so: the deck/deck/test suites are the
// faces' own, and test/compile, test/call, test/deck, test/view and task/ use a face as a helper
function subjectOf(tree: string, target: string): boolean {
  const suite = /^deck\/([^/]+)\/test\/.*\.test\.tree$/.exec(tree)

  if (suite !== null) {
    return target.startsWith(`deck/${suite[1]}/`)
  }

  const own = /^test\/(.+)\.tree$/.exec(tree)
  const module = /^deck\/[^/]+\/code\/(.+)\.ts$/.exec(target)

  return own !== null && module !== null && own[1] === module[1]
}

type TreeRow = { tree: string; mark: 'subject' | 'other'; shelved: boolean; module: Array<{ path: string; bucket: Bucket }> }

// one row per `.tree` that docks the kept files: what it docks, each with its bucket, and its mark (`other` when any
// of its docks is other)
function treeDocksOf(kept: File[]): TreeRow[] {
  const byTree = new Map<string, TreeRow>()

  for (const file of kept) {
    for (const dock of file.docks) {
      const row = byTree.get(dock.tree) ?? { tree: dock.tree, mark: 'subject', shelved: dock.shelved, module: [] }
      row.module.push({ path: file.path, bucket: file.owned ?? file.bucket })

      if (dock.mark === 'other') {
        row.mark = 'other'
      }

      byTree.set(dock.tree, row)
    }
  }

  return [...byTree.values()]
    .map(row => ({ ...row, module: row.module.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.mark.localeCompare(b.mark) || a.tree.localeCompare(b.tree))
}

function printTreeDocks(rows: TreeRow[], tree: { read: number; shelved: number; unread: string[] }): void {
  const other = rows.filter(row => row.mark === 'other').length
  const unread = tree.unread.length === 0 ? 'none' : tree.unread.join(', ')

  console.log(`.tree docks: ${tree.read} .tree read (${tree.shelved} shelved); ${rows.length} dock this TypeScript: ${rows.length - other} subject (owed with it), ${other} other`)
  console.log(`  unread, no dock seen: ${unread}`)

  for (const row of rows) {
    const shown = row.module
      .map(one => `${one.path.replace(/^deck\/[^/]+\/code\//, '')}${one.bucket === 'thin-face' || one.bucket === 'fat-face' ? '' : ` [${one.bucket}]`}`)
      .join(', ')

    console.log(`  ${row.mark === 'other' ? 'OTHER  ' : 'owed   '} ${row.tree}${row.shelved ? ' (shelved)' : ''}: ${shown}`)
  }
}

// `--line`: what every bundle make:line writes is made of, per deck, from the esbuild metafile it writes beside each
// (`.base/@term/code/<name>-meta.json`, term-cli-in-term-0010 for line.js, decision cli-in-term/018 part 1 for the other
// five). A deck's TypeScript is every bundled input under `deck/<d>/` that is not under `host/` (a `host/port/` file is a
// module compiled from `.tree`, counted as a port). Anything outside the decks (`node_modules` is external) is named by
// its first three folders. This counts what the toolchain SHIPS, which the walk above cannot: a `.ts` no verb reaches
// is in the walk and not in a bundle, and dock.mjs, built straight from hook-dispatch.ts and copied into every booted
// console, is in no import graph
const BUNDLES: Array<{ bundle: string; meta: string }> = [
  { bundle: 'host/line.js', meta: 'line-meta.json' },
  { bundle: 'host/need.mjs', meta: 'need-meta.json' },
  { bundle: 'host/need-hand.mjs', meta: 'need-hand-meta.json' },
  { bundle: 'host/dock.mjs', meta: 'dock-meta.json' },
  { bundle: 'host/build-worker.mjs', meta: 'build-worker-meta.json' },
  { bundle: 'host/separate-worker.mjs', meta: 'separate-worker-meta.json' },
]

type DeckRow = { ts: number; tsLines: number; port: number; portLines: number }

type BundleCount = {
  bundle: string
  // null when make:line has not written the metafile yet
  built: string | null
  meta: string
  deck: Record<string, DeckRow>
  total: { ts: number; tsLines: number; port: number }
}

function lineCount(only: string | null): BundleCount[] {
  return BUNDLES.map(({ bundle, meta }) => bundleCount(bundle, join(TERM, '.base/@term/code', meta), only))
}

function bundleCount(bundle: string, meta: string, only: string | null): BundleCount {
  if (!existsSync(meta)) {
    return { bundle, built: null, meta: relative(REPO, meta), deck: {}, total: { ts: 0, tsLines: 0, port: 0 } }
  }

  const read = JSON.parse(readFileSync(meta, 'utf8')) as { inputs: Record<string, { bytes: number }> }
  const decks: Record<string, DeckRow> = {}
  const row = (name: string) => (decks[name] ??= { ts: 0, tsLines: 0, port: 0, portLines: 0 })

  for (const input of Object.keys(read.inputs)) {
    const abs = resolve(TERM, input)
    const path = relative(TERM, abs)
    const match = /^deck\/([^/]+)\/(.*)$/.exec(path)
    // outside the Term decks (the package's own task/): named by its first three folders from the repo
    const deck = match ? match[1]! : relative(REPO, abs).split('/').slice(0, 3).join('/')

    if (only !== null && deck !== only) {
      continue
    }

    const lines = existsSync(abs) ? count(readFileSync(abs, 'utf8')) : 0

    if (match && match[2]!.startsWith('host/')) {
      row(deck).port++
      row(deck).portLines += lines
    } else if (/\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(path)) {
      row(deck).ts++
      row(deck).tsLines += lines
    }
  }

  const names = Object.keys(decks).sort((a, b) => decks[b]!.ts - decks[a]!.ts || a.localeCompare(b))
  const total = names.reduce(
    (sum, name) => ({ ts: sum.ts + decks[name]!.ts, tsLines: sum.tsLines + decks[name]!.tsLines, port: sum.port + decks[name]!.port }),
    { ts: 0, tsLines: 0, port: 0 },
  )

  return { bundle, built: lstatSync(meta).mtime.toISOString(), meta: relative(REPO, meta), deck: decks, total }
}

function printBundles(bundles: BundleCount[]): void {
  for (const one of bundles) {
    if (one.built === null) {
      console.log(`${one.bundle.padEnd(20)} no metafile ${one.meta}: run pnpm --dir ${TERM} run make:line`)
      continue
    }

    const names = Object.keys(one.deck).sort((a, b) => one.deck[b]!.ts - one.deck[a]!.ts || a.localeCompare(b))
    const calls = one.deck.call?.ts ?? 0

    console.log(`${one.bundle.padEnd(20)} ${String(one.total.ts).padStart(4)} .ts (${one.total.tsLines} lines), ${one.total.port} ports, deck/call .ts ${calls}; metafile of ${one.built}`)

    for (const name of names) {
      const row = one.deck[name]!
      console.log(`  ${name.padEnd(18)} ${String(row.ts).padStart(4)} .ts (${row.tsLines} lines), ${row.port} ports (${row.portLines} lines)`)
    }
  }
}

// THE HIDDEN-DOCK CHECK (decision cli-in-term/018 part 1). A bundle's metafile shows what esbuild found by a static
// import, and a dock census shows a `dock load`. Neither sees a port that loads code at run time: an `import(` or
// `require(` whose argument is computed, a literal dynamic import of the toolchain's own source (0069 found five binds
// whose text was `import("@term/call/code/feed")` and the like), or a text naming a `.ts` file that the port reads, copies
// or bundles (boot-running.tree's hook-dispatch.ts candidates, which esbuild bundled at run time). Every emitted port
// (deck/*/host/port/**/*.ts) is read here, each finding grouped by its text across the ports that inline it, and each
// must be named in HIDDEN_ALLOWED with its target, or the check fails
type HiddenKind = 'computed' | 'literal' | 'ts-text'

type HiddenFinding = { kind: HiddenKind; text: string; ports: string[]; at: string; allowed: string | null }

type Hidden = { ports: number; allowed: HiddenFinding[]; refused: HiddenFinding[]; unused: string[] }

// each entry names what the finding loads or writes. A computed import is matched by its text, a `.ts` text by its
// exact value
const HIDDEN_ALLOWED: Array<{ name: string; target: string; kind: HiddenKind; match: RegExp }> = [
  { name: 'version-dispatch', target: 'another installed version\'s host/line.js (work/need/version-dispatch.tree)', kind: 'computed', match: /^import\(url\)$/ },
  { name: 'test-running', target: 'the test module the run just compiled (work/testing/test-running.tree)', kind: 'computed', match: /pathToFileURL\(out\)\.href \+ "\?run=" \+ runCount\.imports\)$/ },
  { name: 'repl-session', target: 'the module the REPL just compiled (work/bundle/repl-session.tree)', kind: 'computed', match: /^import\(address\.href\)$/ },
  { name: 'twin-admission', target: 'the twin module under test (deck/test/code/twin-admission.tree)', kind: 'computed', match: /pathToFileURL\(ask\["module"\]\)\.href\)$/ },
  { name: 'smt solver', target: 'the z3-solver package, found from the cwd (deck/test/code/runtime/smt-text.ts)', kind: 'computed', match: /^import\(pathToFileURL\(found\)\.href\)$/ },
  // file names the toolchain WRITES, never a module it loads
  { name: 'app.ts', target: 'the app entry a build writes (cask, unit-writing, serve, make)', kind: 'ts-text', match: /^app\.ts$/ },
  { name: 'entry.ts', target: 'the bundle entry a build writes (client-bundle, cask, worker-casting)', kind: 'ts-text', match: /^entry\.ts$/ },
  { name: 'boot.ts', target: 'the client boot client-bundle writes into its cache folder', kind: 'ts-text', match: /^boot\.ts$/ },
  { name: 'index.ts', target: 'the worker index worker-casting writes', kind: 'ts-text', match: /^index\.ts$/ },
  { name: 'prelude.ts', target: 'the prelude unit-writing writes beside a unit', kind: 'ts-text', match: /^prelude\.ts$/ },
  { name: 'module.ts', target: 'the test module test-running writes before importing it', kind: 'ts-text', match: /^module\.ts$/ },
  { name: 'fuzz-entry.ts', target: 'the fuzz campaign entry hunt writes', kind: 'ts-text', match: /^fuzz-entry\.ts$/ },
  { name: 'grammar.ts', target: 'deck/deck/code/grammar.ts, which grammar-bundling WRITES from the mill grammar', kind: 'ts-text', match: /^grammar\.ts$/ },
]

function listPortDirs(): string[] {
  return readdirSync(join(TERM, 'deck'))
    .sort()
    .map(deck => join(TERM, 'deck', deck, 'host', 'port'))
    .filter(dir => existsSync(dir))
}

function portFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = lstatSync(full)

    if (stat.isDirectory()) {
      portFiles(full, out)
    } else if (stat.isFile() && /\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full)
    }
  }
}

function hiddenDocks(dirs: string[]): Hidden {
  const files: string[] = []

  for (const dir of dirs) {
    portFiles(dir, files)
  }

  const found = new Map<string, HiddenFinding>()
  const add = (kind: HiddenKind, text: string, file: string, line: number): void => {
    const key = `${kind}\u0000${text}`
    const port = relative(TERM, file)
    const one = found.get(key) ?? { kind, text, ports: [], at: `${port}:${line}`, allowed: null }

    if (!one.ports.includes(port)) {
      one.ports.push(port)
    }

    found.set(key, one)
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
    const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
        const argument = node.arguments[0]

        if (loads && argument !== undefined) {
          if (!isText(argument)) {
            add('computed', node.getText(source).replace(/\s+/g, ' '), file, lineOf(node))
          } else if (/^(\.|\/|@\/|@term\/)/.test(argument.text) && !resolveImport(argument.text, file).port) {
            // the toolchain's own source, loaded at run time: a dock no census sees
            add('literal', argument.text, file, lineOf(node))
          }
        }
      }

      // a text naming a `.ts` file, not a bare extension (`.ts`, `.d.ts`)
      if (isText(node) && /\.ts$/.test(node.text) && !/^(\.[a-z]+)+$/.test(node.text)) {
        add('ts-text', node.text, file, lineOf(node))
      }

      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  const used = new Set<string>()
  const allowed: HiddenFinding[] = []
  const refused: HiddenFinding[] = []

  for (const one of [...found.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text))) {
    const entry = HIDDEN_ALLOWED.find(candidate => candidate.kind === one.kind && candidate.match.test(one.text))

    if (entry) {
      used.add(entry.name)
      allowed.push({ ...one, allowed: `${entry.name}: ${entry.target}` })
    } else {
      refused.push(one)
    }
  }

  return { ports: files.length, allowed, refused, unused: HIDDEN_ALLOWED.filter(entry => !used.has(entry.name)).map(entry => entry.name) }
}

function printHidden(hidden: Hidden): void {
  const shown = (one: HiddenFinding): string => `${one.kind.padEnd(8)} ${JSON.stringify(one.text).slice(0, 90)} in ${one.ports.length} port${one.ports.length === 1 ? '' : 's'} (${one.at})`

  console.log(`hidden docks: ${hidden.ports} ports read, ${hidden.allowed.length + hidden.refused.length} found, ${hidden.allowed.length} allowed, ${hidden.refused.length} refused`)

  for (const one of hidden.allowed) {
    console.log(`  allowed  ${shown(one)}: ${one.allowed}`)
  }

  for (const one of hidden.refused) {
    console.log(`  REFUSED  ${shown(one)}`)
  }

  if (hidden.unused.length > 0) {
    console.log(`  allowlist entries nothing matched (remove them): ${hidden.unused.join(', ')}`)
  }
}

function listRoots(): Root[] {
  const roots: Root[] = readdirSync(join(TERM, 'deck'))
    .sort()
    .filter(name => lstatSync(join(TERM, 'deck', name)).isDirectory())
    .map(name => ({ name, dir: join(TERM, 'deck', name), deck: name }))

  for (const name of ['test', 'task', 'hold', 'mark']) {
    const dir = join(TERM, name)

    if (existsSync(dir)) {
      roots.push({ name: `pkg/${name}`, dir, deck: null })
    }
  }

  return roots
}

function matches(root: Root, name: string): boolean {
  return root.name === name || (name === 'pkg' && root.name.startsWith('pkg/'))
}

function walk(root: Root, dir: string, out: File[], apart: Array<{ path: string; root: Root }>, trees: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.endsWith('-cache') || name.startsWith('.env')) {
      continue
    }

    const full = join(dir, name)
    const stat = lstatSync(full)

    // a symlink points back into the tree, and following one loops
    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      walk(root, full, out, apart, trees)
      continue
    }

    // a `.tree` is never counted, but its docks are importer edges
    if (name.endsWith('.tree')) {
      trees.push(full)
      continue
    }

    if (/\.d\.m?ts$/.test(name) || name.endsWith('.generated.ts')) {
      continue
    }

    if (!CODE.test(name) && !FOREIGN.test(name)) {
      apart.push({ path: relative(TERM, full), root })
      continue
    }

    const text = readFileSync(full, 'utf8')

    out.push({
      abs: full,
      path: relative(TERM, full),
      root,
      lines: count(text),
      text,
      bucket: 'unported',
      owned: null,
      importers: [],
      port: [],
      docks: [],
    })
  }
}

// the repository's own scripts import the decks too: they are importers, never counted
function scripts(): File[] {
  const root: Root = { name: 'repo', dir: join(REPO, 'task/term'), deck: null }
  const out: File[] = []

  for (const name of readdirSync(root.dir).sort()) {
    const full = join(root.dir, name)

    if (CODE.test(name) && !/\.d\.m?ts$/.test(name) && lstatSync(full).isFile()) {
      out.push({
        abs: full,
        path: relative(TERM, full),
        root,
        lines: 0,
        text: readFileSync(full, 'utf8'),
        bucket: 'unported',
        owned: null,
        importers: [],
        port: [],
        docks: [],
      })
    }
  }

  return out
}

// the walked files git ignores: build output that floor.ts's skip list does not name
function gitIgnored(paths: string[]): Set<string> {
  try {
    const out = execFileSync('git', ['-C', TERM, 'check-ignore', '--stdin', '-z'], {
      input: paths.join('\0'),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    })

    return new Set(out.toString('utf8').split('\0').filter(path => path !== ''))
  } catch (error) {
    // exit 1 is "none ignored". Any other failure is no answer, and a count that quietly skipped it would be wrong
    if ((error as { status?: number }).status === 1) {
      return new Set<string>()
    }

    return fail(`git check-ignore failed in ${TERM}`)
  }
}

// wc -l: the number of line ends, which is what state.md's hand counts used
function count(text: string): number {
  let lines = 0

  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    lines++
  }

  return lines
}

// the parent's owned locks, each a path in the parent. With no parent named there are none, and the rest still runs
function readLocks(): string[] {
  if (PARENT_ROOT === undefined) {
    return []
  }

  const lock = JSON.parse(readFileSync(LOCKS(), 'utf8')).lock as Array<{ path: string; mode: string }>

  return lock.filter(entry => entry.mode === 'owned').map(entry => join(PARENT_ROOT!, entry.path))
}

function isOwned(abs: string, locks: string[]): boolean {
  // a lock names a file, or a folder (a trailing slash survives `join`, so test the prefix with one)
  return locks.some(lock => abs === lock || abs.startsWith(lock.endsWith('/') ? lock : `${lock}/`))
}

function importsOf(text: string): string[] {
  const info = ts.preProcessFile(text, true, true)

  return info.importedFiles.map(entry => entry.fileName)
}

// The specifiers the file loads at run time. An `import type`, an `export type` and an import whose every name is
// `type` carry a contract and run nothing, so they are not a call to the port: `compile/node` is a `.tree` that emits
// only types, and importing it does not make a body a face.
function valueImportsOf(file: File): string[] {
  const kind = /\.m?js$/.test(file.abs) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file.abs, file.text, ts.ScriptTarget.ES2022, false, kind)
  const typed = new Set<string>()
  const valued = new Set<string>()

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      const names = clause?.namedBindings
      const only =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            names !== undefined &&
            ts.isNamedImports(names) &&
            names.elements.length > 0 &&
            names.elements.every(element => element.isTypeOnly)))

      ;(only ? typed : valued).add(statement.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const names = statement.exportClause
      const only =
        statement.isTypeOnly ||
        (names !== undefined &&
          ts.isNamedExports(names) &&
          names.elements.length > 0 &&
          names.elements.every(element => element.isTypeOnly))

      ;(only ? typed : valued).add(statement.moduleSpecifier.text)
    }
  }

  // a dynamic `import()` or `require` is no declaration above, and runs
  return importsOf(file.text).filter(spec => valued.has(spec) || !typed.has(spec))
}

type Resolved ={ file: string | null; port: boolean; target: string | null }

// the tsconfig `paths` the toolchain uses: `@term/<deck>/*` is the deck or its emitted port, `@/*` is the Term package
function resolveImport(spec: string, from: string): Resolved {
  const bases: string[] = []

  if (spec.startsWith('.')) {
    bases.push(resolve(dirname(from), spec))
  } else if (spec.startsWith('@term/')) {
    const m = /^@term\/([^/]+)\/(.*)$/.exec(spec)

    if (m !== null) {
      bases.push(join(TERM, 'deck', m[1]!, m[2]!), join(TERM, 'deck', m[1]!, 'host/port', m[2]!))
    }
  } else if (spec.startsWith('@/')) {
    bases.push(join(TERM, spec.slice(2)))
  } else if (spec === '@cluesurf/deck.tree') {
    bases.push(join(TERM, 'deck/deck/code/index'))
  }

  for (const base of bases) {
    const file = firstFile(base)

    if (file !== null) {
      return { file, port: file.includes('/host/port/'), target: base }
    }
  }

  // no code file: a `.tree` of that path is a port, as is anything named under `host/port/`
  for (const base of bases) {
    const stem = base.replace(/\.(m?js|ts)$/, '')

    if (base.endsWith('.tree') ? existsSync(base) : existsSync(`${stem}.tree`)) {
      return { file: null, port: true, target: base }
    }
  }

  return { file: null, port: spec.includes('/host/port/'), target: bases[0] ?? null }
}

function firstFile(base: string): string | null {
  const stem = base.replace(/\.(m?js)$/, '')
  const tried = [base, ...CODE_EXT.map(ext => `${base}${ext}`), ...CODE_EXT.map(ext => `${stem}${ext}`)]

  for (const path of tried) {
    if (CODE.test(path) && isFile(path)) {
      return path
    }
  }

  for (const ext of CODE_EXT) {
    if (isFile(join(base, `index${ext}`))) {
      return join(base, `index${ext}`)
    }
  }

  return null
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

// which port does the file import: any (for a twin), and one of its own deck (for a face)
function ports(file: File): { any: boolean; own: boolean; module: string[] } {
  const own = file.root.deck === null ? null : join(TERM, 'deck', file.root.deck)
  const module: string[] = []
  let any = false
  let mine = false

  for (const spec of valueImportsOf(file)) {
    const found = resolveImport(spec, file.abs)

    if (!found.port) {
      continue
    }

    any = true

    if (found.target !== null) {
      module.push(relative(TERM, found.target))
    }

    if (own !== null && found.target !== null && (found.target === own || found.target.startsWith(`${own}/`))) {
      mine = true
    }
  }

  return { any, own: mine, module }
}

// THIN_LINES: architecture.md#faces says "thin faces (under 150 lines)". The brief's test (nothing but imports,
// re-exports and type declarations) leaves no thin face at all: every real one is a few wrapper functions that hand the
// call to the port (`check/induct.ts`, `ir/facts/range.ts`), so a strict test reads all 27 of state.md's as fat. A face
// is thin when it is short and holds no module state and no IO (deviation, item 0013's proof).
const THIN_LINES = 150

function isThin(file: File): boolean {
  if (file.lines >= THIN_LINES) {
    return false
  }

  const kind = /\.m?js$/.test(file.abs) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file.abs, file.text, ts.ScriptTarget.ES2022, false, kind)

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      // IO: a Node built-in
      if (/^(node:|fs$|path$|child_process$)/.test(statement.moduleSpecifier.text)) {
        return false
      }
    } else if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags

      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer

        // module state: a `let`, or a constant that builds a map, set or array to be mutated or compared by identity (an
        // object literal is a lint rule or a table of functions, not state)
        const stateful =
          (flags & ts.NodeFlags.Const) === 0 ||
          (init !== undefined && (ts.isNewExpression(init) || ts.isArrayLiteralExpression(init)))

        if (stateful) {
          return false
        }
      }
    }
  }

  return true
}

// floor.ts's own answer, so the two tools cannot disagree. `port` is no floor class. Build output git ignores never
// reaches here: main drops it before any file is classed
function floorClass(file: File): Bucket | null {
  const cls = classOfPath(file.path, () => file.text)

  return cls === 'port' ? null : (`floor-${cls.slice(0, 2).toLowerCase()}` as Bucket)
}

// the bucket the file has, and for an owned file the bucket it would have without the lock
function bucketOf(file: File, locks: string[]): { bucket: Bucket; owned: Bucket | null } {
  const under = classify(file)

  return isOwned(file.abs, locks) ? { bucket: 'owned', owned: under } : { bucket: under, owned: null }
}

// The order is the brief's with two changes, both from the data (deviations, item 0013's proof):
//  - a TWIN is a `.ts` whose same-path `.tree` is not a shelved draft. The brief's test ("imports no port") cannot hold:
//    a twin calls Term helpers like any body (every `diagnose` is `parser/diagnostic.tree`), so by imports 16 of the 21
//    twins read as faces. traps.md T021 is why the path test is exact: a port and its face never share a module path, and
//    the one same-path `.tree` beside a face is the shelved draft `check/totality.tree` (`mark draft`).
//  - the named PIPELINE and HOST lists come before the face test, which would otherwise take every one of them
//    (compile.ts imports 25 passes, time/benchmark.ts imports time/compare)
function classify(file: File): Bucket {
  // an oracle or a foreign host's script is that whatever it imports: `mark/*/idiom.ts`, deck/mark's `same.ts`, `mac.js`.
  // A foreign file has no imports to read
  const floor = floorClass(file)

  if (floor === 'floor-f6' || floor === 'floor-f7') {
    return floor
  }

  if (FOREIGN.test(file.abs)) {
    return floor ?? 'unported'
  }

  const tree = file.abs.replace(/\.(ts|mts|mjs|js)$/, '.tree')

  if (existsSync(tree) && !isDraft(tree)) {
    return 'twin'
  }

  if (PIPELINE.has(file.path)) {
    return 'pipeline'
  }

  if (HOST.has(file.path)) {
    return 'host'
  }

  if (DEAD.has(file.path)) {
    return 'dead'
  }

  if (F1_NAMED.has(file.path)) {
    return 'floor-f1'
  }

  if (ports(file).own) {
    return isThin(file) ? 'thin-face' : 'fat-face'
  }

  return floorClass(file) ?? 'unported'
}

// a shelved `.tree` is skipped by the build and is no port of anything, asked the way the build walk asks it
// (`declaresDraft`, deck/call/code/draft.ts): an unindented line, anywhere in the raw text
function isDraft(tree: string): boolean {
  return declaresDraft(readFileSync(tree, 'utf8'))
}

type Cell = { files: number; lines: number }

function tally(files: File[]): Record<string, Cell> {
  const out: Record<string, Cell> = {}

  for (const bucket of BUCKETS) {
    const mine = files.filter(file => file.bucket === bucket)

    if (mine.length > 0) {
      out[bucket] = { files: mine.length, lines: mine.reduce((sum, file) => sum + file.lines, 0) }
    }
  }

  return out
}

function row(label: string, files: File[]): string {
  const lines = files.reduce((sum, file) => sum + file.lines, 0)
  const cells = Object.entries(tally(files)).map(([bucket, cell]) => `${bucket} ${cell.files} (${cell.lines})`)

  return `${label.padEnd(10)} ${String(files.length).padStart(4)} files ${String(lines).padStart(7)} lines: ${cells.join(', ')}`
}

// at most 15 lines: one per root with files (the smallest folded into `other` past 11), a total, what is apart, and
// where the list went
function verdict(roots: Root[], kept: File[], target: string, apart: Record<string, number>): void {
  const lit = roots
    .map(root => ({ root, files: kept.filter(file => file.root === root) }))
    .filter(entry => entry.files.length > 0)
    .sort((a, b) => weigh(b.files) - weigh(a.files))

  const lines: string[] = []

  for (const entry of lit.slice(0, lit.length > 12 ? 11 : lit.length)) {
    lines.push(row(entry.root.name, entry.files))
  }

  if (lit.length > 12) {
    const rest = lit.slice(11)
    lines.push(row(`other ${rest.length}`, rest.flatMap(entry => entry.files)))
  }

  lines.push(row('total', kept))
  lines.push(`apart, not source: ${Object.entries(apart).sort().map(([kind, n]) => `${kind} ${n}`).join(', ')}`)
  lines.push(`list: ${relative(REPO, target)}`)

  console.log(lines.join('\n'))
}

function weigh(files: File[]): number {
  return files.reduce((sum, file) => sum + file.lines, 0)
}

function today(): string {
  const now = new Date()
  const two = (n: number): string => String(n).padStart(2, '0')

  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

function fail(why: string): never {
  console.error(`${why}\nusage: self-host-left.ts [--line | --hidden [--ports <dir>]] [--deck <d>] [--json]`)
  process.exit(2)
}

main().catch(error => {
  console.error(error)
  process.exit(2)
})
