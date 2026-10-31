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
// Since decision 038 (term-self-host-001-0288) the observations are THE MODULE'S OWN: what its compile and its prelude
// observed, each one every time it was made, plus what the process observed outside any module, never the running
// total of the process. So an edit rebuilds the modules that read the file and no other. Every cache that could carry
// one module's reads into another is made per module here (the resolver, the role reader, the parse and walk memos) or
// attributed by the trace (port-trace.ts SOUNDNESS).
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
//
// STAGE0 (term-self-host-001-0018, decision 036 of note/project/term/self-host/change/001-finish-self-host/decision/).
// Every port compiles with STAGE0, a frozen bundle of the compile closure (task/stage0.ts), never with the working
// tree's compiler, and the compiler fingerprint is stage0's id, so an edit to a compiler `.tree` rebuilds only the
// ports whose own text or imports changed, and a half-edited compiler cannot break the build that would rebuild it.
// Only `pnpm run stage0:pin` changes stage0. A pin whose bundle is missing fails here with that command.
//
//   npx tsx task/port-build.ts --stage-check   then STEP 2: every port compiled again with the working tree's
//                                         compiler (stage1, which now resolves to the ports step 1 wrote) into
//                                         tmp/self-host/stage-check/, each output compared byte for byte with step
//                                         1's, the first differing line of each named. Exit 1 on any difference. The
//                                         line lock is freed before step 2, which writes nothing a build reads

// FIRST, before the compiler loads: the trace must see every read a compiler module makes, including while it loads
import { beginModule, closeWindow, endModule, observations, observe, openWindow, real, setRecording, sha, untraced, UNTRACKABLE } from './port-trace'
import traced, { writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ParseMemo, WalkMemo } from '@term/make/code/compile/load'
import { projectHome } from '@term/call/code/home'
import type { DockRoute, Program } from '@term/make/code/compile/node'
import { readPin, stage0Path, STAGE0_SOURCES } from './stage0'
import { shelvedText } from './port-shelved'

// the compile closure port-build calls, from stage0 or (under --stage-check) the working tree
type Compiler = {
  compile: typeof import('@term/make/code/compile/compile').compile
  collectModules: typeof import('@term/make/code/compile/load').collectModules
  makeParseMemo: typeof import('@term/make/code/compile/load').makeParseMemo
  nativePrelude: typeof import('@term/make/code/compile/native').nativePrelude
  projectResolver: typeof import('@term/call/code/make').projectResolver
  projectLeanOf: typeof import('@term/call/code/role-of').projectLeanOf
  toCamel: typeof import('@term/make/code/compile/typescript').toCamel
}
// THE LINE LOCK (note/project/term/decision/002-make-line-lock.md): one port-build or make:line at a time, since this
// compiles with whatever compiler is half edited in the working tree. Under make:line the token it passes down says
// the lock is ours already. Loaded by its path from this file: <repo>/deck/term/deck/term/task/ is five levels below
// <repo>, whose task/term/line-lock.ts it is. A missing lock module is an ERROR, never a skip: with one `../` too few
// the path named <repo>/deck/task/term/line-lock.ts, which never exists, so from 2026-10-23 to item
// term-self-host-001-0475 every port-build ran with no lock at all and nothing said so. test/call/port-build-skip.ts
// clones the tree into the same layout and copies the lock module beside it, so its runs lock their own clone
const LINE_LOCK = new URL('../../../../../task/term/line-lock.ts', import.meta.url)

// the lock held for this process, which `--stage-check` frees before its step 2. Throws where the lock module is absent
async function holdLineLock(by: string): Promise<{ free: () => void } | undefined> {
  if (!untraced(() => existsSync(LINE_LOCK))) {
    throw new Error(
      `port-build: the line lock module is not at ${fileURLToPath(LINE_LOCK)}, so this run cannot take the lock and ` +
        'refuses to compile (note/project/term/decision/002-make-line-lock.md). Run port-build from its place in the ' +
        'repository, five levels below the task/term/ that holds line-lock.ts',
    )
  }

  // a CommonJS module (it says why): its exports are the default, and named too where node's lexer finds them
  type Lock = { holdForProcess: (term: string, by: string) => { free: () => void } }
  const loaded = (await import(LINE_LOCK.href)) as Partial<Lock> & { default?: Lock }
  const lock = loaded.holdForProcess ? (loaded as Lock) : loaded.default!
  return lock.holdForProcess(TERM, by)
}

const { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = real

// run from the Term package root, the way every script under task/ is
const TERM = process.cwd()

// the stdlib every port loads is the working tree's. The compiler finds it by walking up from its own file, and
// stage0's file sits under the user home, so it is named here (the same folder the walk finds from deck/make)
process.env.TERM_STDLIB ??= join(TERM, 'deck', 'base')

// STAGE0: the pinned bundle, loaded here, at the top, so its reads while it loads are in the trace as the compiler's
// always were. `--verify` compiles nothing and loads nothing
async function loadStage0(): Promise<{ id: string; compiler: Compiler }> {
  const command = `pnpm --dir ${TERM} run stage0:pin`
  const pin = readPin()

  if (!pin) {
    throw new Error(`stage0 is not pinned (no task/stage0.json). Pin it, which bundles the working tree's compiler: ${command}`)
  }

  const file = stage0Path(pin.id, 'compile.mjs')

  if (!untraced(() => existsSync(file) && sha(readFileSync(file)) === pin.id)) {
    throw new Error(`stage0 ${pin.id} is not installed at ${file}. Pin it again from this working tree: ${command}`)
  }

  return { id: pin.id, compiler: (await import(pathToFileURL(file).href)) as Compiler }
}

const stage0 = process.argv.includes('--verify') ? undefined : await loadStage0()

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

// THE CLI COMMAND ROUTES of a program: every top-level `hook` (lowered to a dock statement), each bound call carrying
// its task's parameter names. hook-dispatch.ts's `commandRoutes`, written out here so port-build builds on a fresh
// clone before any port exists; work/hook/parsing.tree `command-routes` is its port, paired by tmp/self-host/pairs/
// hook-parse.ts (term-cli-in-term-0224)
function commandRoutes(program: Program): DockRoute[] {
  const params = new Map<string, string[]>()

  for (const s of program) {
    if (s.form === 'function') {
      params.set(s.name, s.params.map(p => p.name))
    }
  }

  const named = (route: DockRoute): DockRoute => ({
    ...route,
    calls: route.calls.map(call => (params.has(call.name) ? { ...call, params: params.get(call.name) } : call)),
    children: route.children.map(named),
  })

  return program.flatMap(s => (s.form === 'dock' ? [named(s.route)] : []))
}

// THE RUN ENTRY (term-cli-in-term-0012). A module whose top level declares `hook` commands is a console, and its port
// alone runs nothing: no Term program can read its own hooks, so the route tree is known only here, from the compile.
// Beside such a port goes `<name>-run.ts`, which `make:line` bundles: the routes as data, each command's task as the
// port's export, and the start of the run handed to `work/dispatch.tree`'s `start-line` and `fail-line` through the
// console's own `start-console`, `fail-console` and `refuse-console`, so the entry imports the console's port alone and
// ships one copy of the dispatch closure and one run state (decision cli-in-term/018 part 3), the way
// `term boot` writes a console's `run.mjs` (boot-plan.tree `cli-run-text`). The parsing of a command's own flags and
// the call of its task are the Term dispatcher's `run-command-line` (work/hook/running.tree, decision cli-in-term/018
// part 2, term-cli-in-term-0224), imported from its own port: it holds no state the console's closure holds, so the
// second import ships no second run state. A usage refusal comes back from it as data and `refuse-line` words it as
// yargs did (decision cli-in-term/016 part 4); every other console's entry (boot-plan.tree `cli-run-text`) keeps the
// dispatcher's own two lines.
// Undefined when the module declares no hook; a task some route names that the port does not export is an error
function runEntry(name: string, content: string, program: Program, toCamel: Compiler['toCamel']): { text: string } | { missing: string[] } | undefined {
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

  // the run entry's own three calls, tasks of the console (decision cli-in-term/018 part 3), checked like the routes'
  const own: Array<[string, string]> = ['start-console', 'refuse-console', 'fail-console'].map(task => [task, toCamel(task)])
  const missing = [...tasks, ...own].filter(([, camel]) => !new RegExp(`^export (async )?function ${camel}\\(`, 'm').test(content)).map(([task]) => task)

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
      "import { runCommandLine } from '@term/call/code/work/hook/running'",
      '',
      `const routes = ${data}`,
      '',
      'const tasks: Record<string, unknown> = {',
      ...entries,
      '}',
      '',
      'const start = line.startConsole(routes, process.argv.slice(2))',
      '',
      'if (start.done) {',
      '  if (start.exit !== 0) {',
      '    process.exit(start.exit)',
      '  }',
      '} else {',
      '  try {',
      "    const code = await runCommandLine({ name: 'term', routes, argv: start.words, resolve: task => tasks[task] as ((...values: unknown[]) => unknown) | undefined, refuse: line.refuseConsole })",
      '',
      '    if (code !== 0) {',
      '      process.exit(code)',
      '    }',
      '  } catch (error) {',
      '    process.exit(line.failConsole(error))',
      '  }',
      '}',
      '',
    ].join('\n'),
  }
}

// THE PRINTER'S RUN (decision term-cli-in-term-0240). A port is emitted whole, with its own copy of every module it
// loads, so the run a port prints through is ITS copy of work/output/printer.tree, and since 0221 that state is a plain
// module `host` again (decision cli-in-term/018 part 3). A caller outside the port (a pair spec) that opens a run
// through a separate printer import opens a run the port never sees, so every port whose closure holds the printer
// exports the printer's open-run, close-run, set-output and is-run-open. The emitter exports every function it keeps,
// and keeps only what a root reaches, so a module whose import closure holds the printer compiles with printerKeeper's
// text after its own: tasks of the module (roots) that call the four. Its names are aliased, so no name the module
// defines or imports is shadowed. The source on disk is never changed. The closure is read off the import walk before
// the compile (holdsPrinter), never off a first compile: compiling to find out, then again with the keeper, cost a
// second compile and a discarded TypeScript emit for every such module, 230 s of a 752 s full build (term-cli-in-term-0252)
const PRINTER = 'deck/call/code/work/output/printer.tree'

// is-run-open is one comparison, and the simplifier inlines it into every caller, so it is kept as a task of the
// module (port-printer-is-run-open, a root) and exported under the printer's name by printerExports. The return is
// spelled the way the module's own mode reads it
function printerKeeper(lean: boolean): string {
  return [
    '',
    '',
    '# written by task/port-build.ts, never in the source (decision term-cli-in-term-0240): the printer run tasks a',
    '# caller of this port drives',
    'load @term/call/work/output/printer',
    '  find open-run, name port-printer-open-run',
    '  find close-run, name port-printer-close-run',
    '  find set-output, name port-printer-set-output',
    '  find is-run-open, name port-printer-run-open',
    '',
    'task port-printer-run',
    '  take input, like dynamic',
    '  take flags, like dynamic',
    '  take tool-version, like text',
    '  like void',
    '  call port-printer-set-output',
    '    read flags',
    '    read tool-version',
    '  call port-printer-open-run',
    '    read input',
    '  call port-printer-close-run',
    '    read input',
    '',
    'task port-printer-is-run-open',
    '  like boolean',
    ...(lean ? ['  back port-printer-run-open()'] : ['  send back', '    call port-printer-run-open']),
    '',
  ].join('\n')
}

// the port's text with the printer's is-run-open exported by its own name when the simplifier inlined it away
function printerExports(content: string): string {
  if (!/^export function portPrinterIsRunOpen\(/m.test(content) || /^export (async )?function isRunOpen\(/m.test(content)) {
    return content
  }

  return `${content}\n// the printer's is-run-open, kept by port-build (decision term-cli-in-term-0240)\nexport { portPrinterIsRunOpen as isRunOpen }\n`
}

// whether a module's import closure holds the printer (the printer's own port keeps every task it defines). The walk is
// the compile's own (collectModules), sharing its parse memo and walk memo, so its reads are the compile's reads,
// nothing is parsed twice, and the compile's walk keeps each module's part (a kept part still resolves its loads again)
function holdsPrinter(
  name: string,
  source: { file: string; text: string },
  resolve: Parameters<Compiler['collectModules']>[1],
  parsed: ParseMemo,
  walked: WalkMemo,
  collectModules: Compiler['collectModules'],
): boolean {
  if (name === PRINTER) {
    return false
  }

  return collectModules(source, resolve, parsed, undefined, walked).sources.some(unit => unit.file.endsWith(`/${PRINTER}`))
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

// raised whenever what a manifest entry means changes, so an older manifest is read as no manifest. 2: an entry's
// reads are its own compile's observations (decision 038), no longer the process's running total
const SCHEMA = 2

// one module's last good build. `reads` are ranges [from, to) of rows of the manifest's `table`, each row an
// observation `[op\0path, what it saw]`: every observation this module's own compile made (decision 038)
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

// THE COMPILER, as content: stage0's id (the sha256 of the bundle every port compiles with, STAGE0 above), and every
// file esbuild's bundle of this script reaches through tsconfig.json's paths, which since stage0 is this script with
// its prelude splice, the trace and the home paths, never the working tree's compiler (it is loaded by a path esbuild
// does not follow). Beside them the nearest lockfile, the tsconfig, Node, and every TERM_ / SEED_ / NODE_ variable
// but LAUNCH_ONLY's.
// Undefined when any of it cannot be read, and then nothing is skipped
//
// The variables that say only how port-build was started, which the fingerprint leaves out. Each of them in it made the
// same tree a full rebuild of every module from another route or terminal, reported as `0 built, N unchanged`:
//   TERM_LINE_LOCK, TERM_LINE_LOCK_BY   who holds the line lock. make:line hands down a fresh random token every run
//                                       (traps.md T-0018b)
//   TERM_PROGRAM, TERM_PROGRAM_VERSION, TERM_SESSION_ID, TERM_FEATURES
//                                       the terminal emulator's own (iTerm2, Apple Terminal, VS Code), no Term variable.
//                                       TERM_SESSION_ID differs in every terminal pane
//   TERM_DEPTH                          the output library's nesting depth (output.ts openRun), set for every child of
//                                       a Term run, as `pnpm term:release` is
//   NODE_PATH                           pnpm's lookup path for the tsx it launched, which differs by where pnpm was run
//                                       from: `pnpm term:release` at the repository root gives tsx 4.20.3's, make:line
//                                       the global one's. A release's port-build took 27 minutes for `0 built, 680
//                                       unchanged` (item term-self-host-001-0453)
const LAUNCH_ONLY = /^(TERM_LINE_LOCK|TERM_LINE_LOCK_BY|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|TERM_FEATURES|TERM_DEPTH|NODE_PATH)$/

async function fingerprint(stage0Id: string): Promise<string | undefined> {
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

    hash.update(`schema ${SCHEMA}\nstage0 ${stage0Id}\nnode ${process.version} ${process.platform} ${process.arch}\n`)

    // LAUNCH_ONLY's variables are left out: each says how this process was started, never what a compile writes
    for (const name of Object.keys(process.env).sort()) {
      if (/^(TERM|SEED|NODE)_/.test(name) && !LAUNCH_ONLY.test(name)) {
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
export function portContent(
  program: Parameters<Compiler['nativePrelude']>[0],
  typescript: string,
  nativePrelude: Compiler['nativePrelude'] = stage0!.compiler.nativePrelude,
): string {
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

  return text === undefined || shelvedText(text) ? undefined : text
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
  const lock = verify ? undefined : await holdLineLock(`port-build${only === undefined ? '' : ` --only ${only}`}`)

  const manifestPath = projectHome(TERM, 'port-build.json')
  const print = stage0 === undefined ? undefined : await fingerprint(stage0.id)
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
      // progress total, which counts what is compiled or skipped. The marker counts anywhere in the file (port-shelved.ts)
      if (shelvedText(text)) {
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

  const { compile, collectModules, makeParseMemo, projectResolver, projectLeanOf, toCamel } = stage0!.compiler

  // the keys of each module written this run (decision 038), turned into rows of the manifest's table when it is written
  const freshKeys = new Map<string, string[]>()

  for (const { root, files } of plan) {
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
      // THE MODULE'S OWN KEY (decision 038): from here to its port's text, everything observed is this module's
      beginModule()
      for (let attempt = 1; ; attempt++) {
        openWindow()
        // the resolver and the role reader keep what they read (projectResolver's readCache and resolveMemo,
        // projectRuleOf's byPackage and byFile), so each is made per compile: shared, a module served from them would
        // show none of the reads its output rests on (decision 038), and a second attempt would read the old text
        const resolve = projectResolver(root)
        const leanOf = projectLeanOf(root)
        // one parse and one walk per module of the closure, shared by the printer's walk and the compile, as compile
        // makes a parse memo per call
        const parsed = makeParseMemo()
        const walked: WalkMemo = new Map()
        // THE PRINTER'S RUN (decision term-cli-in-term-0240): a closure that holds the printer compiles with
        // printerKeeper's text after the module's own
        const keep = holdsPrinter(name, { file, text }, resolve, parsed, walked, collectModules)
        result = compile({ file, text: keep ? `${text}${printerKeeper(leanOf(file) === true)}` : text }, { resolve, leanOf, library: true, parsed, walked })

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
        endModule()
        left.set(name, false)
        moved++
        console.log(`  MOVED ${name}  (${relative(TERM, changed)} changed while it compiled, ${ATTEMPTS} times: its port is left as it was, run port-build again)`)
        continue
      }

      if (!result.ok) {
        endModule()
        left.set(name, true)
        failed++
        console.log(`  FAIL  ${name}`)

        for (const d of result.diagnostics.slice(0, 3)) {
          console.log(`        ${d.name}: ${d.message}`)
        }

        continue
      }

      const content = printerExports(portContent(result.program, result.typescript))
      // only the CLI's own consoles get a run entry: a hook module elsewhere (deck/test/code/fixture/hunt-cli.tree, a
      // test fixture whose hooks name tasks it never defines) is a library like any other port
      const run = basename(root) === 'call' ? runEntry(name, content, result.program, toCamel) : undefined
      // the module's key ends with its prelude's reads
      const keys = endModule()

      if (run && 'missing' in run) {
        left.set(name, true)
        failed++
        console.log(`  FAIL  ${name}`)
        console.log(`        run-entry: the port exports no task for ${run.missing.join(', ')}, which a hook names`)
        continue
      }

      // the key of this output: the observations of its own compile (decision 038). `reads` is filled from `keys`
      // when the manifest is written, as rows of its table
      const entry: Entry | undefined =
        print === undefined ? undefined : { text: textHash, fingerprint: print, out: sha(content), reads: [], ...(run ? { run: sha(run.text) } : {}) }

      if (entry) {
        freshKeys.set(name, keys)
      }
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
    const modules: Record<string, Entry> = {}
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

    // this run's entries, each by the rows of its own keys (decision 038); an untrackable one by the row that never
    // holds
    for (const [name, entry] of Object.entries(fresh)) {
      const keys = freshKeys.get(name) ?? [UNTRACKABLE]
      const rows = keys.map(key => at.get(key))

      modules[name] = {
        ...entry,
        reads: keys.includes(UNTRACKABLE) || rows.some(row => row === undefined) ? never() : ranges(rows as number[]),
      }
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

  if (stageCheck && !check) {
    if (process.exitCode === 1) {
      console.log('term port-build --stage-check: step 2 not run, step 1 did not build every port')
      return
    }

    await stageTwo(plan, lock)
  }
}

const stageCheck = process.argv.includes('--stage-check')

// STEP 2 of `--stage-check` (decision 030 §1, 036): every chosen module compiled again with the working tree's
// compiler, which resolves to the ports step 1 just wrote (stage1), into `tmp/self-host/stage-check/`, and held byte
// for byte against step 1's port and run entry. The ports on disk are hashed while the lock is still held, then the
// lock is freed: step 2 writes only its scratch folder, and what it compares against is in memory
async function stageTwo(plan: { root: string; files: { file: string; text: string }[] }[], lock: { free: () => void } | undefined): Promise<void> {
  setRecording(false)

  const hashOf = (path: string): string | undefined => (existsSync(path) ? sha(readFileSync(path)) : undefined)
  const stageOne = new Map<string, { out?: string; run?: string }>()

  for (const { root, files } of plan) {
    for (const { file } of files) {
      const outPath = portPath(root, file)
      stageOne.set(file, { out: hashOf(outPath), run: hashOf(outPath.replace(/\.ts$/, '-run.ts')) })
    }
  }

  lock?.free()

  // the working tree's modules, by specifiers esbuild cannot follow, so the fingerprint never reaches them
  const working: Record<string, unknown> = {}

  for (const specifier of Object.keys(STAGE0_SOURCES)) {
    Object.assign(working, (await import(specifier)) as Record<string, unknown>)
  }

  const c = working as Compiler
  const scratch = join(TERM, 'tmp', 'self-host', 'stage-check')
  let same = 0
  let differ = 0
  let failed = 0

  // the first line where two texts differ, 1-based, with both lines
  const firstDifference = (a: string, b: string): string => {
    const left = a.split('\n')
    const right = b.split('\n')

    for (let line = 0; line < Math.max(left.length, right.length); line++) {
      if (left[line] !== right[line]) {
        return `line ${line + 1}\n          stage0: ${(left[line] ?? '<end>').slice(0, 160)}\n          stage1: ${(right[line] ?? '<end>').slice(0, 160)}`
      }
    }

    return 'no line differs (a byte at the end)'
  }

  for (const { root, files } of plan) {
    const resolve = c.projectResolver(root)
    const leanOf = c.projectLeanOf(root)

    for (const { file } of files) {
      const name = relative(TERM, file)
      const text = sourceOf(file)

      if (text === undefined) {
        continue
      }

      const parsed = c.makeParseMemo()
      const walked: WalkMemo = new Map()
      const keep = holdsPrinter(name, { file, text }, resolve, parsed, walked, c.collectModules)
      const result = c.compile({ file, text: keep ? `${text}${printerKeeper(leanOf(file) === true)}` : text }, { resolve, leanOf, library: true, parsed, walked })

      if (!result.ok) {
        failed++
        console.log(`  FAIL   ${name}  (stage1 cannot compile it: ${result.diagnostics[0]?.name ?? ''} ${result.diagnostics[0]?.message ?? ''})`)
        continue
      }

      const content = printerExports(portContent(result.program, result.typescript, c.nativePrelude))
      const run = basename(root) === 'call' ? runEntry(name, content, result.program, c.toCamel) : undefined
      const runText = run && 'text' in run ? run.text : undefined
      const outPath = join(scratch, relative(TERM, portPath(root, file)))

      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, content)

      if (runText !== undefined) {
        writeFileSync(outPath.replace(/\.ts$/, '-run.ts'), runText)
      }

      const one = stageOne.get(file)!
      const portSame = one.out === sha(content)
      const runSame = one.run === (runText === undefined ? undefined : sha(runText))

      if (portSame && runSame) {
        same++
        continue
      }

      differ++

      const stagePath = portPath(root, file)
      const which = portSame ? stagePath.replace(/\.ts$/, '-run.ts') : stagePath
      const theirs = existsSync(which) ? readFileSync(which, 'utf8') : ''
      console.log(`  DIFFER ${name}  (${portSame ? 'its run entry' : 'its port'}, ${firstDifference(theirs, portSame ? (runText ?? '') : content)})`)
    }
  }

  console.log(`term port-build --stage-check: step 2 ${same} same, ${differ} differ, ${failed} failed (stage1 output in ${relative(TERM, scratch)})`)

  if (differ > 0 || failed > 0) {
    process.exitCode = 1
  }
}

// run as a script; imported (test/call/port-prelude-once.ts reads `portContent`) it builds nothing
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
