// THE PORT SWITCH, the build half (note/term/self-host/04-the-port-switch.md, self-hosting-0018).
//
// A toolchain module ported to Term lives at `deck/<d>/code/<path>.tree`, and its TypeScript original is DELETED in
// the same change. The TypeScript that still imports `@term/<d>/code/<path>` then resolves through the second
// `paths` candidate in tsconfig.json (`./deck/<d>/host/port/*`) to the module this script writes. tsc, tsx and esbuild all
// read those paths, so nothing else has to know a module moved.
//
// WHY NOT `term make`. `term make` writes a module's TypeScript and nothing else, and a module that docks a native
// shim (`bit`, `clock`) then names a global nobody defines: `declare const bit: any`, and the first call is a
// ReferenceError. `term boot` prepends those shims for an app. A ported toolchain module is a LIBRARY imported by
// TypeScript, so it needs the same prelude written into the module itself, which is what makes it a drop-in. Doing
// that in `term make` would change every package's output, including emitted grammars other projects compile under
// `tsc --strict`, so it lives here, where only the toolchain's own ports go through it.
//
// It runs before the CLI is bundled (`pnpm run make:line`), so `host/line.js` always carries the current ports. A
// module is written only when its content changed.
//
// THE SKIP (term-cli-in-term-0002). Compiling all 321 modules to find them unchanged took 2.5 to 4 minutes of every
// make:line and release. A module is now skipped when its output is provably what a compile would write: the manifest
// at `.base/@term/code/port-build.json` holds, per module, a hash of its text, the COMPILER FINGERPRINT (the content of
// every file the bundle of this script reaches, which is the compiler, the CLI modules it calls and the ported modules
// it is built from, plus the lockfile, the Node version and the TERM_ / SEED_ environment), every observation the
// process had made of the disk by the end of its compile (task/port-trace.ts: each read's content hash, each existence,
// stat and directory listing), and its output's hash. A module is skipped only when all of them still hold and its
// output on disk is that output. Anything missing, unreadable or untrackable compiles. `--full` compiles everything.
//
//   npx tsx task/port-build.ts            build every port, report what changed
//   npx tsx task/port-build.ts --check    write nothing, exit 1 if any port's output is missing or stale
//   npx tsx task/port-build.ts --only dev/hmr    only the ports whose path holds the text, for a fast port loop
//   npx tsx task/port-build.ts --progress        also `progress <done> <total>` on stderr per module (task/release.ts)
//   npx tsx task/port-build.ts --full     compile every module, skipping none (the skip's own proof compares against it)
//   npx tsx task/port-build.ts --explain  also `  skip  <path>` for each module skipped
//   npx tsx task/port-build.ts --verify flow/code/   write nothing, take no lock: exit 1 unless every port whose path
//                                         holds the text is the output the last build wrote from its source AS IT IS NOW
//
// The skip's proof: test/call/port-build-skip.ts (a copy of the tree, edits to a port, a stdlib file and the compiler,
// each skip run byte-identical to a --full run).
//
// NEVER OLDER OUTPUT OVER NEWER (term-cli-in-term-0151). A full run takes minutes, and it read each module's text when
// it planned, then compiled and wrote it with no second look. A second run overlapping it (another session's make:line
// beside a port-one) wrote the port of the NEW text, said `built`, and the first run then wrote the OLD text's port over
// it, with no error anywhere (cli-in-term traps.md, items 0075, 0101, 0077). So a module's text is read at its own turn,
// every `.tree` its compile read is written down (port-trace.ts openWindow), and just before the write each is read
// again: one that changed compiles the module again from the new text, and after ATTEMPTS the module is not written
// and is reported `MOVED` (exit 1). test/call/port-race.ts holds it.
//
// THE MANIFEST LOSES NO ROW (term-cli-in-term-0158). Each entry is keyed by EVERY observation its build made, and the
// table holds one value per observation, so an old entry that saw a file otherwise than this run did cannot be written
// beside this run's. It was dropped, and with dozens of sessions editing the tree nearly every build disagreed with
// something: one folder build left 6 modules of 321, and `--verify` said 'no build has recorded it' of ports that were
// their source's last build (a rerun said `unchanged`). Such an entry is now kept with its reads replaced by the one
// row that never holds (UNTRACKABLE): never skipped, so it compiles next time, while `--verify` still has the text and
// the output its build wrote. A module this run reached and left unwritten (MOVED, FAIL) keeps its old entry the same
// way, a FAIL marked `failed` so `--verify` never calls its port current.

// FIRST, before the compiler loads: the trace must see every read a compiler module makes, including while it loads
import { closeWindow, observations, observationCount, observe, openWindow, real, setRecording, sha, untraced, UNTRACKABLE } from './port-trace'
import traced, { writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf } from '@term/call/code/role-of'
import { projectHome } from '@term/call/code/home'
import { commandRoutes, toCamel } from '@term/call/code/hook-dispatch'
// THE LINE LOCK (note/project/term/decision/002-make-line-lock.md): one port-build or make:line at a time, since this
// compiles with whatever compiler is half edited in the working tree. Under make:line the token it passes down says
// the lock is ours already. Loaded by its path from this file, and skipped where it is absent: test/call/port-build-skip.ts
// runs a copy of this script in a temporary tree of its own, which no other build shares
const LINE_LOCK = new URL('../../../../task/term/line-lock.ts', import.meta.url)

async function holdLineLock(by: string): Promise<void> {
  if (!untraced(() => existsSync(LINE_LOCK))) {
    return
  }

  // a CommonJS module (it says why): its exports are the default, and named too where node's lexer finds them
  type Lock = { holdForProcess: (term: string, by: string) => unknown }
  const loaded = (await import(LINE_LOCK.href)) as Partial<Lock> & { default?: Lock }
  const lock = loaded.holdForProcess ? (loaded as Lock) : loaded.default!
  lock.holdForProcess(TERM, by)
}

const { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = real

// run from the Term package root, the way every script under task/ is
const TERM = process.cwd()

// the toolchain LIBRARIES whose ports TypeScript imports, each with the code subtrees it ports. Of `@term/call`,
// `code/browser` is the browser compiler's in-memory disk, and `code/work/item` is a library, the terminal output
// standard every command prints through (note/project/term/output/). `code/line` is the console, `line/base.tree`, and
// the top-level `code/work/*.tree` its verbs and its dispatcher: built here since term-cli-in-term-0012, so make:line
// can bundle the console as `host/term-line.js` (see THE RUN ENTRY below)
const DECKS: Record<string, string[]> = {
  make: ['code'],
  deck: ['code'],
  flow: ['code'],
  scan: ['code'],
  test: ['code'],
  // `code/work/*/**`: every FOLDER under code/work (a lane's ports, decision cli-in-term/001), and `code/work/*` the
  // verb files directly in it
  call: ['code/work/*/**', 'code/work/*', 'code/line', 'code/browser', 'code/*'],
}

// THE RUN ENTRY (term-cli-in-term-0012). A module whose top level declares `hook` commands is a console, and its port
// alone runs nothing: no Term program can read its own hooks, so the route tree is known only here, from the compile.
// Beside such a port goes `<name>-run.ts`, which `make:line` bundles: the routes as data, each command's task as the
// port's export, and the start of the run handed to `work/dispatch.tree`'s `start-line` and `fail-line`, the way
// `term boot` writes a console's `run.mjs` (boot-plan.tree `cli-run-text`). The parsing of a command's own flags and
// the call of its task are still hook-dispatch.ts's `runCommandLine`, until the switch (term-cli-in-term-0013). A usage
// refusal comes back from it as data and `refuse-line` words it as yargs did (decision cli-in-term/016 part 4); every
// other console's entry (boot-plan.tree `cli-run-text`) keeps hook-dispatch's own two lines.
// Undefined when the module declares no hook; a task some route names that the port does not export is an error
function runEntry(name: string, content: string, program: Parameters<typeof commandRoutes>[0]): { text: string } | { missing: string[] } | undefined {
  const routes = commandRoutes(program)

  if (routes.length === 0) {
    return undefined
  }

  const tasks = new Map<string, string>()
  const walk = (list: typeof routes): void => {
    for (const route of list) {
      const task = route.calls[0]?.name

      if (task) {
        tasks.set(task, toCamel(task))
      }

      walk(route.children)
    }
  }

  walk(routes)

  const missing = [...tasks].filter(([, camel]) => !new RegExp(`^export (async )?function ${camel}\\(`, 'm').test(content)).map(([task]) => task)

  if (missing.length > 0) {
    return { missing }
  }

  const data = JSON.stringify(routes, (key, value) => (key === 'span' ? undefined : (value as unknown)))
  const entries = [...tasks].sort(([a], [b]) => a.localeCompare(b)).map(([task, camel]) => `  ${JSON.stringify(task)}: line.${camel},`)

  return {
    text: [
      `// THE RUN ENTRY of the Term console ${name}, written by task/port-build.ts beside its port (term-cli-in-term-0012).`,
      '// Generated: edit the console or port-build, never this file.',
      `import * as line from './${name.split('/').pop()!.replace(/\.tree$/, '')}'`,
      "import { failLine, refuseLine, startLine } from '@term/call/code/work/dispatch'",
      "import { runCommandLine } from '@term/call/code/hook-dispatch'",
      '',
      `const routes = ${data}`,
      '',
      'const tasks: Record<string, unknown> = {',
      ...entries,
      '}',
      '',
      'const start = startLine(routes, process.argv.slice(2))',
      '',
      'if (start.done) {',
      '  if (start.exit !== 0) {',
      '    process.exit(start.exit)',
      '  }',
      '} else {',
      '  try {',
      "    const code = await runCommandLine({ name: 'term', routes, argv: start.words, resolve: task => tasks[task] as ((...values: unknown[]) => unknown) | undefined, refuse: refuseLine })",
      '',
      '    if (code !== 0) {',
      '      process.exit(code)',
      '    }',
      '  } catch (error) {',
      '    process.exit(failLine(error))',
      '  }',
      '}',
      '',
    ].join('\n'),
  }
}

// a subtree written `<dir>/*/**` takes every directory directly in `<dir>`, each whole, and no file of `<dir>` itself
function folders(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)

    if (!SKIP.has(name) && !name.endsWith('-cache') && lstatSync(full).isDirectory()) {
      trees(full, out)
    }
  }
}

// a subtree written `<dir>/*` takes the .tree files directly in that directory and none below it: `@term/call`'s own
// modules ported to Term sit in `code/` beside their TypeScript faces, where `code/line` and `code/work` hold the console
function shallow(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)

    if (name.endsWith('.tree') && name !== 'draft.tree' && !lstatSync(full).isSymbolicLink() && lstatSync(full).isFile()) {
      out.push(full)
    }
  }
}

const check = process.argv.includes('--check')
// `--verify [<path text>]` takes its own filter, the way `--only` does
const verifyAt = process.argv.indexOf('--verify')
const verify = verifyAt >= 0
const verifyText = verify && process.argv[verifyAt + 1] && !process.argv[verifyAt + 1]!.startsWith('--') ? process.argv[verifyAt + 1] : undefined
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : verifyText

// THE WRITE-TIME CHECK: how many times a module whose sources keep changing under it is compiled before it is left
// unwritten as MOVED
const ATTEMPTS = 3

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])

function trees(dir: string, out: string[]): void {
  if (!existsSync(dir) || existsSync(join(dir, 'draft.tree'))) {
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

// `--progress`: a `progress <done> <total>` line on STDERR after each module, for a caller that shows the step live
// (task/release.ts). Stderr, so the stdout this script has always printed, and the summary line make:port and the
// release read off it, stay as they were. It cannot print through the output library: it builds the ports that library
// is made of
const showProgress = process.argv.includes('--progress')
const full = process.argv.includes('--full')
// `--explain`: a `  skip  <path>` line per module skipped, which test/call/port-build-skip.ts reads
const explain = process.argv.includes('--explain')

// raised whenever what a manifest entry means changes, so an older manifest is read as no manifest
const SCHEMA = 1

// one module's last good build. `reads` are ranges [from, to) of rows of the manifest's `table`, each row an
// observation `[op\0path, what it saw]`: every observation the building process had made by the end of this compile
// `run`: the hash of the console's run entry written beside it, for a module that declares hooks (THE RUN ENTRY)
// `failed`: a later build of the module failed and wrote nothing, so the port on disk is this entry's (THE MANIFEST
// LOSES NO ROW)
type Entry = { text: string; fingerprint: string; out: string; reads: [number, number][]; run?: string; failed?: true }
type Manifest = { schema: number; table: [string, string][]; modules: Record<string, Entry> }

function readManifest(path: string): Manifest | undefined {
  try {
    const manifest = JSON.parse(untraced(() => readFileSync(path, 'utf8'))) as Manifest

    if (manifest.schema !== SCHEMA || !Array.isArray(manifest.table) || typeof manifest.modules !== 'object') {
      return undefined
    }

    return manifest
  } catch {
    return undefined
  }
}

// THE COMPILER, as content: every file esbuild's bundle of this script reaches through tsconfig.json's paths (the
// compiler, the CLI modules it calls, the ported modules it is built from, and this script with its prelude splice),
// which is the code tsx runs here, since make:line bundles the same graph the same way. Beside it the nearest lockfile
// (the packages left external), the tsconfig, Node, and every TERM_ / SEED_ / NODE_ variable. Undefined when any of it
// cannot be read, and then nothing is skipped
async function fingerprint(): Promise<string | undefined> {
  try {
    const { build } = await import('esbuild')
    const result = await build({
      entryPoints: [join(TERM, 'task', 'port-build.ts')],
      absWorkingDir: TERM,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      tsconfig: join(TERM, 'tsconfig.json'),
      metafile: true,
      write: false,
      logLevel: 'silent',
    })
    const hash = createHash('sha256')

    hash.update(`schema ${SCHEMA}\nnode ${process.version} ${process.platform} ${process.arch}\n`)

    for (const name of Object.keys(process.env).sort()) {
      if (/^(TERM|SEED|NODE)_/.test(name)) {
        hash.update(`env ${name}=${process.env[name]}\n`)
      }
    }

    let lock: string | undefined

    for (let dir = TERM; ; dir = dirname(dir)) {
      if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
        lock = join(dir, 'pnpm-lock.yaml')
        break
      }

      if (dirname(dir) === dir) {
        break
      }
    }

    const files = [...Object.keys(result.metafile.inputs).map(input => join(TERM, input)), join(TERM, 'tsconfig.json')]

    if (lock) {
      files.push(lock)
    }

    for (const file of files.sort()) {
      hash.update(`file ${file} ${sha(readFileSync(file))}\n`)
    }

    return hash.digest('hex')
  } catch {
    return undefined
  }
}

// sorted indexes as [from, to) ranges
function ranges(indexes: number[]): [number, number][] {
  const out: [number, number][] = []

  for (const index of [...indexes].sort((a, b) => a - b)) {
    const last = out[out.length - 1]

    if (last && last[1] === index) {
      last[1] = index + 1
    } else if (!last || last[1] < index) {
      out.push([index, index + 1])
    }
  }

  return out
}

// THE PORT'S TEXT: the native prelude, then the emitted module. Each runtime shim goes in ONCE (term-cli-in-term-0127).
// The prelude looks a dock's shim up by the dock's NAME and dedupes by the path it tried. A `<global:JSON>` dock looks
// for `runtime/JSON.ts`, and on a case-insensitive disk (macOS, APFS) that path opens `runtime/json.ts`, the shim
// @term/base/json's own dock already brought in: one file under two spellings, written twice, `const json` declared
// twice, which esbuild refuses while `term make` (which writes no prelude) passes. So a shim is keyed by the FILE it
// opens (device and inode), and a second path to a file already given reads as empty
export function portContent(program: Parameters<typeof nativePrelude>[0], typescript: string): string {
  const given = new Set<string>()
  // through the TRACED `fs`: what the prelude reads is an input of the output like any file the compile read
  const prelude = nativePrelude(program, 'node', path => {
    if (!traced.existsSync(path)) {
      return undefined
    }

    const stat = untraced(() => traced.statSync(path))
    const file = `${stat.dev}:${stat.ino}`

    if (given.has(file)) {
      return ''
    }

    given.add(file)
    return traced.readFileSync(path, 'utf8')
  })
  // the emitted module declares each native global it calls (`declare const bit: any`) so it typechecks WITHOUT the
  // prelude, and the prelude defines it (`const bit = {...}`). Both in one file is TS2451 "Cannot redeclare", which
  // `tsc` reported on every port that docks a native until 2026-10-04, so the declaration of a name the prelude
  // defines is dropped
  const defined = new Set([...(prelude ?? '').matchAll(/^const ([A-Za-z_$][\w$]*) =/gm)].map(match => match[1]!))
  const body = typescript
    .split('\n')
    .filter(line => {
      const declared = /^declare const ([A-Za-z_$][\w$]*)\s*:/.exec(line)

      return !declared || !defined.has(declared[1]!)
    })
    .join('\n')

  return `${prelude ? `${prelude}\n` : ''}${body}`
}

// a module's port: under `host/port/`, never `host/` itself: `term make` writes `host/<path>.ts` WITHOUT the prelude,
// and two writers on one path left whichever ran last (found the same hour: the port worked, then a `term make` of the
// compiler package overwrote it and the next import threw `bit is not defined`)
function portPath(root: string, file: string): string {
  return join(root, 'host', 'port', relative(root, file).replace(/\.tree$/, '.ts'))
}

// a module's text as it is on disk now, or undefined when it is gone or shelved (`mark draft`, or the old `note draft`)
function sourceOf(file: string): string | undefined {
  const text = untraced(() => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  })

  return text === undefined || /^(mark|note) draft\s*$/m.test(text.slice(0, 2000)) ? undefined : text
}

// test/call/port-race.ts only: with TERM_PORT_BUILD_HOLD=<dir>, the first compile of the run writes `<dir>/held` (the
// module's path) and waits for `<dir>/go` before its write-time check, so the test can edit the source and run a
// second build inside that gap, the race this check closes. A test's hook and nothing else: absent, it does nothing
let held = false

function holdForTest(name: string): void {
  const dir = process.env.TERM_PORT_BUILD_HOLD

  if (!dir || held) {
    return
  }

  held = true
  untraced(() => writeFileSync(join(dir, 'held'), name))

  const until = Date.now() + 600_000

  while (!untraced(() => existsSync(join(dir, 'go'))) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
}

// `--verify`: each chosen module's port held against the manifest entry the build that wrote it left, the hash of the
// text it compiled and of the port it wrote. The module's text now must be that text, and its port that port. It
// reads the module's OWN source only: a port is emitted with every module it loads, and a change to one of those is
// the skip's business (the next port-build compiles it again), not this check's. Exit 1 on any module that fails
function verifyPorts(plan: { root: string; files: { file: string; text: string }[] }[], manifest: Manifest | undefined): void {
  let good = 0
  let bad = 0

  for (const { root, files } of plan) {
    for (const { file, text } of files) {
      const name = relative(TERM, file)
      const outPath = portPath(root, file)
      const runPath = outPath.replace(/\.ts$/, '-run.ts')
      const entry = manifest?.modules[name]
      const hashOf = (path: string): string | undefined => untraced(() => (existsSync(path) ? sha(readFileSync(path)) : undefined))
      const out = hashOf(outPath)
      const problem =
        entry === undefined
          ? 'no build has recorded it: run port-build'
          : entry.failed
            ? 'its last build failed: run port-build to see why'
            : out === undefined
            ? 'its port is missing'
            : entry.text !== sha(text)
              ? 'its source changed after its port was built'
              : entry.out !== out
                ? 'its port is not the one the last build wrote'
                : entry.run !== undefined && hashOf(runPath) !== entry.run
                  ? 'its run entry is not the one the last build wrote'
                  : undefined

      if (problem === undefined) {
        good++
      } else {
        bad++
        console.log(`  STALE ${name}  (${problem})`)
      }
    }
  }

  console.log(`term port-build --verify: ${good} current, ${bad} stale`)

  if (bad > 0 || good === 0) {
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  let built = 0
  let unchanged = 0
  let stale = 0
  let failed = 0
  // modules left unwritten because their sources kept changing while they compiled (THE WRITE-TIME CHECK)
  let moved = 0

  // port-build's own bookkeeping is no part of any module's trace. `settle` in home.ts reaches `fs` itself
  setRecording(false)

  // `--verify` writes nothing, so it waits for no one
  if (!verify) {
    await holdLineLock(`port-build${only === undefined ? '' : ` --only ${only}`}`)
  }

  const manifestPath = projectHome(TERM, 'port-build.json')
  const print = verify ? undefined : await fingerprint()
  // the last manifest, whose entries this run keeps where it writes none of its own; under `--full` none is skipped
  const previous = print === undefined ? undefined : readManifest(manifestPath)
  const old = full ? undefined : previous
  setRecording(true)

  // whether a row of the old manifest's table still sees what it saw, checked at most once a run
  const holds = new Map<number, boolean>()
  const stillHolds = (row: number): boolean => {
    let answer = holds.get(row)

    if (answer === undefined) {
      const entry = old!.table[row]

      if (!entry || entry[0] === UNTRACKABLE) {
        answer = false
      } else {
        const cut = entry[0].indexOf('\0')
        answer = observe(entry[0].slice(0, cut), entry[0].slice(cut + 1)) === entry[1]
      }

      holds.set(row, answer)
    }

    return answer
  }

  // the entries written this run, keyed by the module's path under the package; `reads` index THIS process's
  // observations. And those carried from the old manifest, whose `reads` still index its table
  const fresh: Record<string, Entry> = {}
  const carried: Record<string, Entry> = {}
  // the modules this run reached and left unwritten, each with whether its compile failed (THE MANIFEST LOSES NO ROW)
  const left = new Map<string, boolean>()

  // every module first, so the progress has its total before the first one compiles
  const plan: { root: string; files: { file: string; text: string }[] }[] = []
  const every = new Set<string>()

  for (const [deck, subtrees] of Object.entries(DECKS)) {
    const root = join(TERM, 'deck', deck)
    const files: string[] = []

    for (const subtree of subtrees) {
      if (subtree.endsWith('/*/**')) {
        folders(join(root, subtree.slice(0, -5)), files)
      } else if (subtree.endsWith('/*')) {
        shallow(join(root, subtree.slice(0, -2)), files)
      } else {
        trees(join(root, subtree), files)
      }
    }

    const chosen: { file: string; text: string }[] = []

    for (const file of files) {
      const text = untraced(() => readFileSync(file, 'utf8'))

      // `mark draft` (or the old `note draft`) shelves a file out of every build, this one included, and out of the
      // progress total, which counts what is compiled or skipped
      if (/^(mark|note) draft\s*$/m.test(text.slice(0, 2000))) {
        continue
      }

      every.add(relative(TERM, file))

      if (only === undefined || relative(TERM, file).includes(only)) {
        chosen.push({ file, text })
      }
    }

    if (chosen.length > 0) {
      plan.push({ root, files: chosen })
    }
  }

  if (verify) {
    setRecording(false)
    verifyPorts(plan, readManifest(manifestPath))
    return
  }

  const total = plan.reduce((sum, one) => sum + one.files.length, 0)
  let done = 0
  // written at once with writeSync: the loop below is synchronous, and a `process.stderr.write` to a pipe may wait in
  // node's buffer until it ends, which is the silence this exists to fill
  const tell = (): void => {
    if (!showProgress) {
      return
    }

    const bytes = Buffer.from(`progress ${done} ${total}\n`)
    let at = 0

    while (at < bytes.length) {
      try {
        at += writeSync(2, bytes, at)
      } catch (error) {
        if ((error as { code?: string }).code !== 'EAGAIN') {
          throw error
        }
      }
    }
  }

  for (const { root, files } of plan) {
    const resolve = projectResolver(root)
    const leanOf = projectLeanOf(root)

    for (const { file } of files) {
      // the modules finished before this one, told as it starts: every way out of the turn below is a `continue`
      tell()
      done++

      const name = relative(TERM, file)
      // the text NOW, not as the plan read it: a full run reaches its last module minutes after it planned
      let text = sourceOf(file)

      if (text === undefined) {
        left.set(name, false)
        moved++
        console.log(`  MOVED ${name}  (removed or shelved since this run began: run port-build again)`)
        continue
      }

      let textHash = sha(text)
      const outPath = portPath(root, file)
      const runPath = outPath.replace(/\.ts$/, '-run.ts')

      // THE SKIP: the same compiler, the same text, every observation the compile that wrote it made still seeing
      // the same thing, and that output on disk now
      const last = old?.modules[name]

      if (
        last &&
        last.fingerprint === print &&
        last.text === textHash &&
        last.reads.every(([from, to]) => {
          for (let row = from; row < to; row++) {
            if (!stillHolds(row)) {
              return false
            }
          }

          return true
        }) &&
        untraced(() => existsSync(outPath) && sha(readFileSync(outPath)) === last.out) &&
        (last.run === undefined || untraced(() => existsSync(runPath) && sha(readFileSync(runPath)) === last.run))
      ) {
        carried[name] = last
        unchanged++

        if (explain) {
          console.log(`  skip  ${name}`)
        }

        continue
      }

      // a port is a LIBRARY its TypeScript callers build values for: no case is tested by identity. THE WRITE-TIME
      // CHECK: every `.tree` this compile read, its own text first, is read again once it is done, and a change
      // compiles it again from the text as it now is
      let result: ReturnType<typeof compile> | undefined
      let changed: string | undefined

      for (let attempt = 1; ; attempt++) {
        openWindow()
        result = compile({ file, text }, { resolve, leanOf, library: true })

        const read = closeWindow()

        holdForTest(name)
        // its own text as a text, the way it was compiled; the others by their bytes, the way the trace hashes them
        changed = sourceOf(file) === text ? [...read].find(([path, hash]) => path !== file && observe('read', path) !== hash)?.[0] : file

        if (changed === undefined || attempt === ATTEMPTS) {
          break
        }

        console.log(`  again ${name}  (${relative(TERM, changed)} changed while it compiled)`)

        const now = sourceOf(file)

        if (now === undefined) {
          break
        }

        text = now
        textHash = sha(text)
      }

      if (changed !== undefined) {
        left.set(name, false)
        moved++
        console.log(`  MOVED ${name}  (${relative(TERM, changed)} changed while it compiled, ${ATTEMPTS} times: its port is left as it was, run port-build again)`)
        continue
      }

      if (!result.ok) {
        left.set(name, true)
        failed++
        console.log(`  FAIL  ${name}`)

        for (const d of result.diagnostics.slice(0, 3)) {
          console.log(`        ${d.name}: ${d.message}`)
        }

        continue
      }

      const content = portContent(result.program, result.typescript)
      // only the CLI's own consoles get a run entry: a hook module elsewhere (deck/test/code/fixture/hunt-cli.tree, a
      // test fixture whose hooks name tasks it never defines) is a library like any other port
      const run = basename(root) === 'call' ? runEntry(name, content, result.program) : undefined

      if (run && 'missing' in run) {
        left.set(name, true)
        failed++
        console.log(`  FAIL  ${name}`)
        console.log(`        run-entry: the port exports no task for ${run.missing.join(', ')}, which a hook names`)
        continue
      }

      // the key of this output: every observation this process has made so far, since a compiler may cache across
      // the modules of one run, so this output can rest on a file an earlier module's compile read
      const entry: Entry | undefined =
        print === undefined
          ? undefined
          : { text: textHash, fingerprint: print, out: sha(content), reads: [[0, observationCount()]], ...(run ? { run: sha(run.text) } : {}) }
      const existing = untraced(() => (existsSync(outPath) ? readFileSync(outPath, 'utf8') : undefined))
      const existingRun = run ? untraced(() => (existsSync(runPath) ? readFileSync(runPath, 'utf8') : undefined)) : undefined

      if (existing === content && existingRun === run?.text) {
        if (entry) {
          fresh[name] = entry
        }

        unchanged++
        continue
      }

      if (check) {
        stale++
        console.log(`  STALE ${name}`)
        continue
      }

      untraced(() => {
        mkdirSync(join(outPath, '..'), { recursive: true })
        writeFileSync(outPath, content)

        if (run) {
          writeFileSync(runPath, run.text)
        }
      })

      if (entry) {
        fresh[name] = entry
      }

      built++
      console.log(`  built ${relative(TERM, outPath)}`)
    }
  }

  tell()

  // the manifest: this run's observations first, so a fresh entry's ranges index them as they are, then each row a
  // carried entry needs. A carried entry, or an old one this run did not reach (`--only`) or reached and left unwritten
  // (MOVED, FAIL), whose row now disagrees with what this run saw (a file changed since its build) is kept with the row
  // that never holds as its reads, and compiles next time (THE MANIFEST LOSES NO ROW)
  if (!check && print !== undefined) {
    setRecording(false)

    const table = observations()
    const at = new Map(table.map(([key], index) => [key, index]))
    const modules: Record<string, Entry> = { ...fresh }
    const reached = new Set([...plan.flatMap(one => one.files.map(({ file }) => relative(TERM, file)))])
    const keep: Record<string, Entry> = { ...carried }

    for (const [name, entry] of Object.entries(previous?.modules ?? {})) {
      if (!reached.has(name) && every.has(name)) {
        keep[name] = entry
      } else if (left.has(name)) {
        keep[name] = left.get(name) ? { ...entry, failed: true } : entry
      }
    }

    // the one row no skip ever passes (stillHolds answers false for it)
    const never = (): [number, number][] => {
      let index = at.get(UNTRACKABLE)

      if (index === undefined) {
        index = table.length
        table.push([UNTRACKABLE, 'never'])
        at.set(UNTRACKABLE, index)
      }

      return [[index, index + 1]]
    }

    for (const [name, entry] of Object.entries(keep)) {
      const rows: number[] = []
      let agrees = !entry.failed

      for (const [from, to] of entry.reads) {
        for (let row = from; row < to && agrees; row++) {
          const seen = previous!.table[row]

          if (!seen) {
            agrees = false
            break
          }

          let index = at.get(seen[0])

          if (index === undefined) {
            index = table.length
            table.push(seen)
            at.set(seen[0], index)
          } else if (table[index]![1] !== seen[1]) {
            agrees = false
          }

          rows.push(index)
        }
      }

      modules[name] = { ...entry, reads: agrees ? ranges(rows) : never() }
    }

    try {
      const manifest: Manifest = { schema: SCHEMA, table, modules }
      const temporary = `${manifestPath}.${process.pid}`

      untraced(() => {
        mkdirSync(dirname(manifestPath), { recursive: true })
        writeFileSync(temporary, JSON.stringify(manifest))
        real.renameSync(temporary, manifestPath)
      })
    } catch {
      // a manifest that cannot be written only means the next run compiles more
    }
  }

  console.log(
    `term port-build: ${built} built, ${unchanged} unchanged${check ? `, ${stale} stale` : ''}, ${failed} failed${moved > 0 ? `, ${moved} moved` : ''}`,
  )

  if (failed > 0 || stale > 0 || moved > 0) {
    process.exitCode = 1
  }
}

// run as a script; imported (test/call/port-prelude-once.ts reads `portContent`) it builds nothing
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
