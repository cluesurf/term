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
// one module's reads into another is made per module here (the resolver, the role reader, the walk memo) or attributed
// by the trace (port-trace.ts SOUNDNESS). The parse memo is the run's (THE RUN'S PARSE MEMO): it reads no file.
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
//   npx tsx task/port-build.ts --jobs 4   compile in 4 worker processes (THE JOBS). `--jobs 1` compiles in this process
//
// THE JOBS. No module's compile waits on another's: every port compiles with stage0 from `.tree` sources, no compile reads
// a port (the manifest's table holds no row under host/port), and decision 038 made every cache per module or attributed,
// so there is no dependency order to keep. What made the loop serial was its one process: one trace, one table, one
// stdout. So each module's turn is the same function in any process (compileTurn), and the three things that had an order
// are put back in plan order by this process, whichever worker finished first: the stdout lines, the rows of the table
// (port-trace.ts adopt), and the entries of the manifest. Output, stdout and manifest are then those of `--jobs 1`.
//
// Separate processes, never threads: the trace wraps `fs`, and stage0 holds module state. A worker is this script again
// with `--port-worker`, so the fingerprint, which covers this file, covers the worker. It takes no lock (it runs under
// this process's) and holds its own trace, whose rows come back with its turn. It does its write itself, straight after
// the write-time check (NEVER OLDER OUTPUT OVER NEWER), so no gap opens between the two. The skip is decided here before
// any compile starts, since it reads the manifest and needs no compiler. A compile that THROWS, or a worker that dies,
// stops the run and exits 1 with no manifest written, what a throw in one process does. `--stage-check`'s step 2 runs in
// workers the same way. TERM_PORT_BUILD_HOLD, port-race's hook, means one process: the race it holds is that process's

// THE UNITS (`--units`, spec-1339-separate-ports.md sections 1, 2 and 5, item term-self-host-001-1342, decision 162).
// Every port is an ENTRY of `term make`'s separate build: stage0's compileSeparate compiles it unit by unit, a unit
// being a strongly connected component of the module graph, against a store of unit answers keyed by content. Each
// module of every closure is emitted ONCE, to `host/unit/<slug>.ts` (the slug its deck name plus its path in the deck,
// make-plan's unitSlugOf), importing its siblings by `./<slug>`, with the native prelude ITS OWN emitted code docks
// (portContent with the module's `declare const` lines as what the shims are used in). The port's path,
// `deck/<d>/host/port/<path>.ts`, becomes an ENTRY SHIM re-exporting every public task, constant and type the old whole
// port exported, each from the unit that defines it (make-plan's entryShimText), so every importer keeps its path and its
// names. The `-run.ts` run entries and the printer keeper stay: a console's run entry imports its shim, and an entry
// whose closure holds the printer compiles with printerKeeper's text after its own.
//   A port module's unit is written by its own entry's compile (its keeper text is its own), a module no port names
// (the stdlib, deck/host, mill) by every compile that reaches it, and a module two compiles emit otherwise is a
// DISAGREE line and exit 1. A unit file no unit of a whole run wrote is removed (T-0425).
//   THE STORE IS PORT-BUILD'S OWN (lead, 2026-11-13 10:20Z): `.base/@term/code/port-unit/<namespace>/`, the namespace a
// hash of stage0's id and this script's fingerprint, and only the current namespace is kept. Never the machine store,
// where cache-store keeps two namespaces per kind and port units would evict, and be evicted by, `term make` and other
// clones. A moved fingerprint is a cold namespace, so a pin or an edit to this script compiles every unit once.
//   THE MANIFEST is schema 3 (item term-self-host-001-1343, spec-1339 section 6): the run's stage0 id, its fingerprint,
// one table of every observation the run's compiles made, a row per unit (its source, its interface, the interfaces it
// imported, its file) and a row per shim. THE FAST PATH: a run whose stage0, fingerprint, entries, outputs and table
// all still hold writes nothing and never loads stage0. Any other run hands every entry to the engine, which replays
// each unit whose key holds and compiles the rest: the engine is the early cutoff, port-build keeps none of its own.
// `--verify` reads the units: an entry is current only when every unit its closure reaches is, each recorded with the
// interface of each unit it loads. Decision 038's per-module key is no skip key here
//
//   npx tsx task/port-build.ts --units          build every port as units and shims
//   npx tsx task/port-build.ts --units --only dev/hmr   only those entries (their units must exist from a whole run)
//   npx tsx task/port-build.ts --units --check          write nothing, exit 1 when an output is missing or stale
//   npx tsx task/port-build.ts --units --stage-check    then step 2 through the working tree's compileSeparate
//   npx tsx task/port-build.ts --verify --manifest <path>   verify against that manifest (a test's altered copy)
//   npx tsx task/port-build.ts --units --reprint        this machine's print into a carried manifest, when all else holds

// FIRST, before the compiler loads: the trace must see every read a compiler module makes, including while it loads
import { adopt, beginModule, closeWindow, endModule, forgetOutside, observations, observe, openWindow, real, setRecording, sha, sightings, untraced, UNTRACKABLE } from './port-trace'
import traced, { writeSync } from 'node:fs'
import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { availableParallelism, totalmem } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ParseMemo, WalkMemo } from '@term/make/code/compile/load'
import { projectHome } from '@term/call/code/home'
import { buildValue, isLaunchOnly } from '@term/call/code/launch-only'
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
  // THE UNITS: the unit engine stage0 carries since item 1341 (spec-1339 section 3)
  toPascal: typeof import('@term/make/code/compile/typescript').toPascal
  projectRoleOf: typeof import('@term/call/code/role-of').projectRoleOf
  compileSeparate: typeof import('@term/make/code/compile/separate').compileSeparate
  CompileCache: typeof import('@term/make/code/compile/cache').CompileCache
  diskCacheStore: typeof import('@term/call/code/cache-store').diskCacheStore
  projectDeckOf: typeof import('@term/call/code/deck-of').projectDeckOf
  unitSlugOf: typeof import('@term/call/code/make-plan').unitSlugOf
  entryShimText: typeof import('@term/call/code/make-plan').entryShimText
}
// THE LINE LOCK (note/project/term/decision/002-make-line-lock.md): one port-build or make:line at a time, since this
// compiles with whatever compiler is half edited in the working tree. Under make:line the token it passes down says
// the lock is ours already. Loaded by its path from this file: task/term/line-lock.ts, beside this file's folder in the
// Term repository. A missing lock module is an ERROR, never a skip: with one `../` too few the path once named a file
// that never exists, so from 2026-10-23 to item term-self-host-001-0475 every port-build ran with no lock at all and
// nothing said so. test/call/port-build-skip.ts copies the lock module into its clone, so its runs lock their own clone
const LINE_LOCK = new URL('./term/line-lock.ts', import.meta.url)

// the lock held for this process, which `--stage-check` frees before its step 2. Throws where the lock module is absent
async function holdLineLock(by: string): Promise<{ free: () => void } | undefined> {
  if (!untraced(() => existsSync(LINE_LOCK))) {
    throw new Error(
      `port-build: the line lock module is not at ${fileURLToPath(LINE_LOCK)}, so this run cannot take the lock and ` +
        'refuses to compile (decision 002, the make:line lock). Run port-build from its place in the Term ' +
        'repository, beside the task/term/ that holds line-lock.ts',
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

  const compiler = (await import(pathToFileURL(file).href)) as Compiler

  // THE UNITS need the engine a pin before item 1341 lacks
  if (process.argv.includes('--units')) {
    const lacking = ['compileSeparate', 'CompileCache', 'diskCacheStore', 'projectDeckOf', 'projectRoleOf', 'unitSlugOf', 'entryShimText', 'toPascal'].filter(
      name => typeof (compiler as unknown as Record<string, unknown>)[name] !== 'function',
    )

    if (lacking.length > 0) {
      throw new Error(`stage0 ${pin.id} exports no ${lacking.join(', ')}, which --units compiles with. Pin it again from this working tree: ${command}`)
    }
  }

  return { id: pin.id, compiler }
}

// `--units` loads it only when THE FAST PATH fails (unitsMain), and a units worker when it starts (portWorker)
let stage0 = process.argv.includes('--verify') || process.argv.includes('--units') ? undefined : await loadStage0()

// stage0 loaded now, with nothing it reads recorded: its id is the key of everything it compiles
async function stage0Loaded(): Promise<{ id: string; compiler: Compiler }> {
  if (stage0 === undefined) {
    setRecording(false)
    stage0 = await loadStage0()
  }

  return stage0
}

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
// Undefined when the module declares no hook; a task some route names that the port does not export is an error.
// `exports` answers whether the port exports a task by its camel name: a whole port's text by its `export function`
// lines, an entry shim's by the names it re-exports (THE UNITS)
function runEntry(name: string, exports: (camel: string) => boolean, program: Program, toCamel: Compiler['toCamel']): { text: string } | { missing: string[] } | undefined {
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
  const missing = [...tasks, ...own].filter(([, camel]) => !exports(camel)).map(([task]) => task)

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

// a whole port's text exports a task by an `export function` line
function exportsFunction(content: string): (camel: string) => boolean {
  return camel => new RegExp(`^export (async )?function ${camel}\\(`, 'm').test(content)
}

// the value names an entry shim re-exports (`export { a, b as c } from '...'`), its type lines left out (THE UNITS)
function shimValues(shim: string): Set<string> {
  const names = new Set<string>()

  for (const match of shim.matchAll(/^export \{ ([^}]*) \} from /gm)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()

      if (name) {
        names.add(name)
      }
    }
  }

  return names
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

// the printer's node-only face (decision 167 point 5, item term-self-host-001-1434): open-run, close-run and
// set-output read the caller's objects there, and printer.tree's own are typed, so the keeper drives the face. The
// face loads the printer, so it shares the port's one run. Neither file's own port takes the keeper
const PRINTER_INPUT = 'deck/call/code/work/output/printer-input.tree'

// is-run-open is one comparison, and the simplifier inlines it into every caller, so it is kept as a task of the
// module (port-printer-is-run-open, a root) and exported under the printer's name by printerExports. The return is
// spelled the way the module's own mode reads it
function printerKeeper(lean: boolean): string {
  return [
    '',
    '',
    '# written by task/port-build.ts, never in the source (decision term-cli-in-term-0240): the printer run tasks a',
    '# caller of this port drives',
    'load @term/call/work/output/printer-input',
    '  find open-run, name port-printer-open-run',
    '  find close-run, name port-printer-close-run',
    '  find set-output, name port-printer-set-output',
    '',
    'load @term/call/work/output/printer',
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
  if (name === PRINTER || name === PRINTER_INPUT) {
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

// the room one worker needs, from the heaviest measured (item term-self-host-001-1016), and the most workers worth starting
const JOB_MEMORY = 6 * 1024 ** 3
const MOST_JOBS = 8

// `--jobs <n>`, or as many as the machine has cores and memory to spare: four cores left for everything else, and no more
// workers than its memory holds
function jobCount(): number {
  const at = process.argv.indexOf('--jobs')

  if (process.env.TERM_PORT_BUILD_HOLD) {
    return 1
  }

  if (at < 0) {
    return Math.max(1, Math.min(MOST_JOBS, availableParallelism() - 4, Math.floor(totalmem() / JOB_MEMORY)))
  }

  const jobs = Number(process.argv[at + 1])

  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error(`port-build: --jobs takes a whole number above 0, not ${process.argv[at + 1]}`)
  }

  return jobs
}

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
// but the launch-only ones.
// Undefined when any of it cannot be read, and then nothing is skipped
//
// The variables that say only how port-build was started are left out: each of them in it made the same tree a full
// rebuild of every module from another route or terminal, reported as `0 built, N unchanged` (a release's port-build
// took 27 minutes so, item term-self-host-001-0453). The list, and why each is on it, is deck/call/code/launch-only.ts,
// which build-graph.tree's env-text reads too (item term-self-host-001-0476)

// The TERM_ variables that no compile port-build runs reads, so a value of one cannot change a byte it writes. Each in
// the print made the same tree a cold units namespace from another caller (item term-self-host-001-1368):
//   TERM_NATIVE_CACHE   where the native toolchains (gradle, the Rust and Swift kits) are fetched to. Read only at RUN
//                       time by native-build.ts, cask.ts, compose.ts, work/native/building.tree, work/compose and
//                       work/cask toolchain.tree, and the toolchain shell scripts, never by stage0's compile or the
//                       unit engine. The queue gives every check one (m3-trial.mjs runOne) and make:line none, so a
//                       check's port-build moved the print, emptied the units store and left the next make:line cold
//                       (1344's probe tmp/self-host/1344/store/m3-env.sh, l1343g)
// The queue's other check variables (TSX, LINE, TMPDIR) are no TERM_, SEED_ or NODE_ name, its TERM_DEPTH is removed
// and launch-only anyway, and its NODE_OPTIONS is a heap flag (buildValue). Port-build's own list, not launch-only.ts:
// that list says how a process was started, and this one says what a compile never reads
const NOT_READ_BY_A_COMPILE = new Set(['TERM_NATIVE_CACHE'])

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

    // the launch-only variables are left out: each says how this process was started, never what a compile writes.
    // So is the launch-only part of one, NODE_OPTIONS's heap sizes (buildValue, item term-self-host-001-1017), and so
    // are the variables no compile reads (NOT_READ_BY_A_COMPILE below)
    for (const name of Object.keys(process.env).sort()) {
      if (/^(TERM|SEED|NODE)_/.test(name) && !isLaunchOnly(name) && !NOT_READ_BY_A_COMPILE.has(name)) {
        const value = buildValue({ name, value: process.env[name] ?? '' })

        if (value !== undefined) {
          // THE UNITS: a path inside this tree (TERM_STDLIB) names the same input in every clone of it
          hash.update(`env ${name}=${units ? value.split(TERM).join('<root>') : value}\n`)
        }
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

    if (!units) {
      if (lock) {
        files.push(lock)
      }

      for (const file of files.sort()) {
        hash.update(`file ${file} ${sha(readFileSync(file))}\n`)
      }

      return hash.digest('hex')
    }

    // THE UNITS (trap T-1342): this script reaches call/code/home.ts, which imports the PORT home-ignore, and a run
    // that turns a whole port into a shim and its units moved its own fingerprint, so the run after it was cold. Every
    // input under a deck's host/port/ or under host/unit/ is OUTPUT of port-build: a port counts by its `.tree` source
    // (what it is made from), a unit file not at all. And every path is said relative to this tree, the lockfile by
    // its content alone, so a clone of the same content has the same print (THE FAST PATH after a carry, item 1327)
    hash.update(`lock ${lock ? sha(readFileSync(lock)) : 'none'}\n`)

    const said = new Set<string>()

    for (const file of files) {
      const at = relative(TERM, file).split(sep).join('/')
      const port = /^deck\/([^/]+)\/host\/port\/(.+)\.ts$/.exec(at)

      if (/^host\/unit\//.test(at) || /^deck\/[^/]+\/host\/unit\//.test(at)) {
        continue
      }

      if (port) {
        const source = join(TERM, 'deck', port[1]!, `${port[2]!.replace(/-run$/, '')}.tree`)

        said.add(`source ${relative(TERM, source).split(sep).join('/')} ${existsSync(source) ? sha(readFileSync(source)) : 'none'}`)
      } else {
        said.add(`file ${at} ${sha(readFileSync(file))}`)
      }
    }

    for (const line of [...said].sort()) {
      hash.update(`${line}\n`)
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
// `usedIn` (THE UNITS): the program is the docks of a whole closure, and a shim goes in only where the unit's own
// emitted code docks it, which it says by its `declare const <name>: any` lines (compile/native.ts nativePrelude)
export function portContent(
  program: Parameters<Compiler['nativePrelude']>[0],
  typescript: string,
  nativePrelude: Compiler['nativePrelude'] = stage0!.compiler.nativePrelude,
  usedIn?: string,
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
  }, usedIn)
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

// every file under a port deck's host/port/ (none when it is absent), untraced: port-build's own output
function portFiles(dir: string): string[] {
  const found: string[] = []
  const walk = (at: string): void => {
    for (const one of untraced(() => (existsSync(at) ? readdirSync(at, { withFileTypes: true }) : []))) {
      if (one.isDirectory()) {
        walk(join(at, one.name))
      } else {
        found.push(join(at, one.name))
      }
    }
  }

  walk(dir)
  return found.sort()
}

// whether a process of this id is running (a temp file `<file>.<pid>` whose writer is gone is left over)
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
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

// ONE MODULE'S TURN, in whichever process compiles it. `lines` are its stdout, printed in plan order. `tally` is the
// count it adds to, `left` that it was reached and left unwritten and whether by a failure, `entry` the manifest entry of
// the output now on disk, `keys` its observations (from a worker, `rows`, `drifted` and `untrackable` carry them in their
// place, port-trace.ts adopt). `carried`: the module was skipped, and this is its old entry
type Turn = {
  tally: 'built' | 'unchanged' | 'stale' | 'failed' | 'moved'
  lines: string[]
  left?: boolean
  entry?: Entry
  keys?: string[]
  rows?: [string, string][]
  drifted?: boolean
  untrackable?: boolean
  carried?: Entry
}

// a module gone or shelved since the run began
function goneTurn(name: string): Turn {
  return { tally: 'moved', left: false, lines: [`  MOVED ${name}  (removed or shelved since this run began: run port-build again)`] }
}

// THE RUN'S PARSE MEMO (term-self-host-001-1097). Every port inlines its reached load closure, so each of a run's
// compiles parsed the same stdlib and compiler modules again, once per port that loads them. One parse memo now serves
// every compile this process makes, one per compiler (stage0, or under --stage-check step 2 the working tree's). It is
// keyed by a file and its exact text (compile/loading-parses.tree parse-remembered answers a kept parse only for the
// very text it was made from), and parsing reads nothing from the disk: the text comes from the resolver, which is still
// made per compile, so every file a module's compile reaches is still READ in that module's own trace (decision 038), and
// a hit only spares the parse of a text already read. The walk memo stays per module: a kept walk re-resolves only the
// loads that resolved, so the lookups that answered nothing would drop out of the next module's key
const RUN_PARSE_CAP = 16384
const runParses = new Map<Compiler['makeParseMemo'], ParseMemo>()

function runParseMemo(makeParseMemo: Compiler['makeParseMemo']): ParseMemo {
  let memo = runParses.get(makeParseMemo)

  if (memo === undefined) {
    memo = makeParseMemo(RUN_PARSE_CAP)
    runParses.set(makeParseMemo, memo)
  }

  return memo
}

// compile one module, and write its port when it changed
function compileTurn(root: string, file: string, print: string | undefined): Turn {
  const { compile, collectModules, makeParseMemo, projectResolver, projectLeanOf, toCamel } = stage0!.compiler
  const lines: string[] = []
  const name = relative(TERM, file)
  // the text NOW, not as the plan read it: a full run reaches its last module minutes after it planned
  let text = sourceOf(file)

  if (text === undefined) {
    return goneTurn(name)
  }

  let textHash = sha(text)
  const outPath = portPath(root, file)
  const runPath = outPath.replace(/\.ts$/, '-run.ts')

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
    // one parse per module text for the whole run (THE RUN'S PARSE MEMO) and one walk per module of the closure,
    // both shared by the printer's walk and the compile
    const parsed = runParseMemo(makeParseMemo)
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

    lines.push(`  again ${name}  (${relative(TERM, changed)} changed while it compiled)`)

    const now = sourceOf(file)

    if (now === undefined) {
      break
    }

    text = now
    textHash = sha(text)
  }

  if (changed !== undefined) {
    const keys = endModule()

    lines.push(`  MOVED ${name}  (${relative(TERM, changed)} changed while it compiled, ${ATTEMPTS} times: its port is left as it was, run port-build again)`)
    return { tally: 'moved', left: false, lines, keys }
  }

  if (!result.ok) {
    const keys = endModule()

    lines.push(`  FAIL  ${name}`)

    for (const d of result.diagnostics.slice(0, 3)) {
      lines.push(`        ${d.name}: ${d.message}`)
    }

    return { tally: 'failed', left: true, lines, keys }
  }

  const content = printerExports(portContent(result.program, result.typescript))
  // only the CLI's own consoles get a run entry: a hook module elsewhere (deck/test/code/fixture/hunt-cli.tree, a
  // test fixture whose hooks name tasks it never defines) is a library like any other port
  const run = basename(root) === 'call' ? runEntry(name, exportsFunction(content), result.program, toCamel) : undefined
  // the module's key ends with its prelude's reads
  const keys = endModule()

  if (run && 'missing' in run) {
    lines.push(`  FAIL  ${name}`)
    lines.push(`        run-entry: the port exports no task for ${run.missing.join(', ')}, which a hook names`)
    return { tally: 'failed', left: true, lines, keys }
  }

  // the key of this output: the observations of its own compile (decision 038). `reads` is filled from `keys`
  // when the manifest is written, as rows of its table
  const entry: Entry | undefined =
    print === undefined ? undefined : { text: textHash, fingerprint: print, out: sha(content), reads: [], ...(run ? { run: sha(run.text) } : {}) }
  const existing = untraced(() => (existsSync(outPath) ? readFileSync(outPath, 'utf8') : undefined))
  const existingRun = run ? untraced(() => (existsSync(runPath) ? readFileSync(runPath, 'utf8') : undefined)) : undefined

  if (existing === content && existingRun === run?.text) {
    return { tally: 'unchanged', lines, keys, entry }
  }

  if (check) {
    lines.push(`  STALE ${name}`)
    return { tally: 'stale', lines, keys }
  }

  untraced(() => {
    mkdirSync(join(outPath, '..'), { recursive: true })
    writeFileSync(outPath, content)

    if (run) {
      writeFileSync(runPath, run.text)
    }
  })

  lines.push(`  built ${relative(TERM, outPath)}`)
  return { tally: 'built', lines, keys, entry }
}

// THE UNITS: where the units go, and the store of unit answers port-build keeps for itself
const UNIT_DIR = join(TERM, 'host', 'unit')
const UNIT_STORE = projectHome(TERM, 'port-unit')
// `--stage-check`'s step 2 compiles with the working tree's engine, against a store of its own, never stage0's
const STAGE_UNIT_STORE = projectHome(TERM, 'port-unit-stage1')
const units = process.argv.includes('--units')

// THE MANIFEST, SCHEMA 3 (spec-1339 section 6, item term-self-host-001-1343). `stage0` and `fingerprint` key the whole
// run. `table` is every observation the WHOLE run's compiles made (port-trace.ts), the key of THE FAST PATH, or the one
// row that never holds after a run that saw a file move, failed or chose entries. One row per emitted file: a unit by
// its slug (`sources`: the byte hash of its module's `.tree` as the run read it, `interface`: the engine's surface hash
// of the unit as its importers see it, `imports`: that hash of each unit its module LOADS, by the load graph, since a
// bind's inlined text or an erased type import leaves no import in the file, `out`: its file's hash), and an
// entry shim by its path (`module` its source, `unit` its own unit, `text` the hash of the text it compiled, `out`, `run`
// its run entry's hash). A schema 2 manifest is read as none, so the first --units run asks the engine
const UNITS_SCHEMA = 3

type UnitRow = { sources: Record<string, string>; interface: string; imports: Record<string, string>; out: string }
type ShimRow = { module: string; unit: string; text: string; out: string; run?: string; failed?: true }
type UnitsManifest = { schema: number; stage0: string; fingerprint: string; table: [string, string][]; units: Record<string, UnitRow>; shims: Record<string, ShimRow> }

function readUnitsManifest(path: string): UnitsManifest | undefined {
  try {
    const manifest = JSON.parse(untraced(() => readFileSync(path, 'utf8'))) as UnitsManifest

    if (manifest.schema !== UNITS_SCHEMA || !Array.isArray(manifest.table) || typeof manifest.units !== 'object' || typeof manifest.shims !== 'object') {
      return undefined
    }

    return manifest
  } catch {
    return undefined
  }
}

// one module a turn emitted: its slug and path under the root, its unit file's hash, whether this turn wrote it and
// whether it is the entry's own, its interface hash as this compile's unit memo holds it ('' when no answer matched),
// the units its module loads, and under --check whether the file on disk differs
type UnitModule = { slug: string; module: string; out: string; wrote: boolean; own: boolean; face: string; imports: string[]; stale?: boolean }

// one entry's turn under --units. `rows` are its compile's observations, `untrackable` that they cannot key a skip.
// `built` the engine's units built (by id), `reused` the count it replayed, `unmatched` modules with no interface found
type UnitsTurn = {
  tally: 'built' | 'unchanged' | 'failed' | 'moved' | 'stale'
  lines: string[]
  unit?: string
  text?: string
  shim?: string
  run?: string
  modules?: UnitModule[]
  built?: string[]
  reused?: number
  unmatched?: number
  rows?: [string, string][]
  untrackable?: boolean
}

// what one process keeps across the entries it compiles: the compiler (stage0, or stage1 in --stage-check's step 2),
// the store, the unit answers of the run, the readers per deck, every port entry (whose own compile alone writes its
// unit), and the interface hashes found so far in the unit memo
type UnitWork = {
  c: Compiler
  store: string
  cache: InstanceType<Compiler['CompileCache']>
  memo: Map<string, unknown>
  deckOf: ReturnType<Compiler['projectDeckOf']>
  readers: Map<string, { resolve: ReturnType<Compiler['projectResolver']>; leanOf: ReturnType<Compiler['projectLeanOf']>; roleOf: ReturnType<Compiler['projectRoleOf']> }>
  ports: Set<string>
  faces: Map<string, Map<string, Set<string>>>
  indexed: Set<unknown>
}

let unitWork: UnitWork | undefined

// THE STORE IS NO INPUT: its entries are keyed by content the trace already holds, and its own reads and writes (a
// write open marks a trace untrackable) are kept out of every observation
function untracedStore<S extends object>(store: S): S {
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown

      return typeof value === 'function' ? (...args: unknown[]) => untraced(() => (value as (...a: unknown[]) => unknown).apply(target, args)) : value
    },
  })
}

function unitWorkOf(c: Compiler, store: string): UnitWork {
  if (unitWork?.store === store && unitWork.c === c) {
    return unitWork
  }

  unitWork = {
    c,
    store,
    cache: new c.CompileCache(untracedStore(c.diskCacheStore(store, 'port-build'))),
    memo: new Map(),
    deckOf: c.projectDeckOf(),
    readers: new Map(),
    ports: new Set(portPlan(undefined).flatMap(({ files }) => files.map(({ file }) => file))),
    faces: new Map(),
    indexed: new Set(),
  }

  return unitWork
}

// a module's unit name: its deck's name and its path in the deck, flattened (make-plan unitSlugOf)
function unitSlug(work: UnitWork, module: string): string {
  const deck = work.deckOf(module)

  return work.c.unitSlugOf(deck ? `${deck.name}/${relative(deck.root, module)}` : relative(TERM, module))
}

// THE INTERFACE OF AN EMITTED MODULE. The engine hands back no unit's interface hash, but every unit answer of the
// process sits in its unit memo (separate-units.tree `unit-answer`: the build's files with their emits, and its
// `interface-hash`), so a module's emit is found there by its code. Indexed once per answer
type MemoAnswer = { build?: { form?: string; value?: { files?: { file?: string; emit?: { code?: unknown } }[]; interfaceHash?: unknown } } }

function indexFaces(work: UnitWork): void {
  for (const answer of work.memo.values()) {
    if (work.indexed.has(answer)) {
      continue
    }

    work.indexed.add(answer)

    const build = (answer as MemoAnswer | undefined)?.build

    if (build?.form !== 'some' || typeof build.value?.interfaceHash !== 'string') {
      continue
    }

    for (const { file, emit } of build.value.files ?? []) {
      if (typeof file !== 'string' || typeof emit?.code !== 'string') {
        continue
      }

      const byCode = work.faces.get(file) ?? new Map<string, Set<string>>()
      const faces = byCode.get(emit.code) ?? new Set<string>()

      faces.add(build.value.interfaceHash)
      byCode.set(emit.code, faces)
      work.faces.set(file, byCode)
    }
  }
}

// a file written only when its bytes change, through a temporary name, so a reader never sees half of it
function writeChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) {
    return false
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.${process.pid}`, text)
  real.renameSync(`${path}.${process.pid}`, path)
  return true
}

// one entry through the engine, with the printer keeper where its closure holds the printer. `edges` are the load
// graph of the entry's closure (the walk the compile shares), each module's direct loads: what a unit depends on,
// which its emitted imports do not say (a bind's text is inlined, a type import is erased)
function compileEntry(work: UnitWork, root: string, file: string, text: string): { result: ReturnType<Compiler['compileSeparate']>; edges: Map<string, string[]> } {
  const c = work.c
  const name = relative(TERM, file)
  const readers = work.readers.get(root) ?? { resolve: c.projectResolver(root), leanOf: c.projectLeanOf(root), roleOf: c.projectRoleOf(root) }

  work.readers.set(root, readers)

  const parsed = runParseMemo(c.makeParseMemo)
  const walked: WalkMemo = new Map()
  const collected = c.collectModules({ file, text }, readers.resolve, parsed, undefined, walked)
  const keep = name !== PRINTER && name !== PRINTER_INPUT && collected.sources.some(unit => unit.file.endsWith(`/${PRINTER}`))

  const result = c.compileSeparate(
    { file, text: keep ? `${text}${printerKeeper(readers.leanOf(file) === true)}` : text },
    {
      resolve: readers.resolve,
      cache: work.cache,
      modules: module => `./${unitSlug(work, module)}`,
      roleOf: readers.roleOf,
      leanOf: readers.leanOf,
      deckOf: work.deckOf,
      parsed,
      units: work.memo,
      walked: new Map(),
      // a console's run entry reads its routes off the entry's docks and the stubs' parameter names
      keepProgram: basename(root) === 'call',
    },
  )
  // the keeper's text loads the printer and its face, which sits beside it
  const printer = keep ? collected.sources.find(unit => unit.file.endsWith(`/${PRINTER}`))?.file : undefined
  const edges = new Map(collected.edges)

  if (printer !== undefined) {
    const face = join(dirname(printer), basename(PRINTER_INPUT))

    edges.set(file, [...new Set([...(edges.get(file) ?? []), printer, face])])
  }

  return { result, edges }
}

type Compiled = Extract<ReturnType<Compiler['compileSeparate']>, { ok: true }>

// a unit's file: the native prelude its own emitted code docks, then its code (the entry's own with the printer's
// is-run-open export)
function unitContent(c: Compiler, result: Compiled, code: string, own: boolean): string {
  return portContent(
    result.natives as Program,
    own ? printerExports(code) : code,
    c.nativePrelude,
    code
      .split('\n')
      .filter(line => /^declare const [A-Za-z_$][\w$]*\s*:/.test(line))
      .join('\n'),
  )
}

// an entry's shim and, for a console, its run entry
function shimOf(work: UnitWork, root: string, file: string, result: Compiled): { shimPath: string; shim: string; run?: { text: string } | { missing: string[] } } {
  const c = work.c
  const shimPath = portPath(root, file)
  const unitOf = (module: string): string => {
    const path = relative(dirname(shimPath), join(UNIT_DIR, unitSlug(work, module))).split(sep).join('/')

    return path.startsWith('./') || path.startsWith('../') ? path : `./${path}`
  }
  const shim = c.entryShimText(result.exports, c.toCamel, c.toPascal, unitOf)
  const values = shimValues(shim)
  const run = basename(root) === 'call' ? runEntry(relative(TERM, file), camel => values.has(camel), [...(result.surface ?? []), ...result.docks] as Program, c.toCamel) : undefined

  return { shimPath, shim, ...(run ? { run } : {}) }
}

// ONE ENTRY'S TURN under --units, in whichever process compiles it. Its compile is traced (THE FAST PATH's table), and
// THE WRITE-TIME CHECK holds as for a whole port: the entry's text and every module of its closure are read again once
// it is done, and one that changed compiles the entry again from fresh readers, at most ATTEMPTS times
function unitsTurn(root: string, file: string, store: string): UnitsTurn {
  const work = unitWorkOf(stage0!.compiler, store)
  const c = work.c
  const name = relative(TERM, file)
  let text = sourceOf(file)

  if (text === undefined) {
    return goneTurn(name) as UnitsTurn
  }

  const lines: string[] = []
  let result!: ReturnType<Compiler['compileSeparate']>
  let edges!: Map<string, string[]>
  let keys!: string[]
  let changed: string | undefined
  let untrackable = false

  for (let attempt = 1; ; attempt++) {
    // a second attempt reads every file afresh, so its window holds the closure as this compile read it
    if (attempt > 1) {
      openWindow()
    }

    beginModule()
    setRecording(true)

    let gone = false

    try {
      // THE ENTRY'S OWN TEXT THROUGH THE TRACE: the engine is handed the text, never reads it, so a port no other
      // module loads would be in no row of the table and an edit to it would leave the fast path holding
      // (item 1343, clone l1343e: deck/make/code/check/hold-walk.tree)
      const own = (() => {
        try {
          return traced.readFileSync(file, 'utf8')
        } catch {
          return undefined
        }
      })()

      if (own === undefined || shelvedText(own)) {
        gone = true
      } else {
        text = own
        ;({ result, edges } = compileEntry(work, root, file, text))
      }
    } finally {
      setRecording(false)
    }

    if (gone) {
      endModule()
      return goneTurn(name) as UnitsTurn
    }

    const read = attempt > 1 ? closeWindow() : undefined

    keys = endModule()
    untrackable ||= keys.includes(UNTRACKABLE) || attempt > 1
    changed = sourceOf(file) === text ? undefined : file

    if (changed === undefined && result.ok) {
      for (const module of result.modules.keys()) {
        const first = read ? read.get(module) : sightings([`read\0${module}`]).rows[0]?.[1]

        if (first !== undefined && observe('read', module) !== first) {
          changed = module
          break
        }
      }
    }

    if (changed === undefined || attempt === ATTEMPTS) {
      break
    }

    lines.push(`  again ${name}  (${relative(TERM, changed)} changed while it compiled)`)
    work.readers.clear()

    const now = sourceOf(file)

    if (now === undefined) {
      return goneTurn(name) as UnitsTurn
    }

    text = now
  }

  let { rows } = sightings(keys)

  if (changed !== undefined) {
    lines.push(`  MOVED ${name}  (${relative(TERM, changed)} changed while it compiled, ${ATTEMPTS} times: its port is left as it was, run port-build again)`)
    return { tally: 'moved', lines, rows, untrackable: true }
  }

  if (!result.ok) {
    return { tally: 'failed', lines: [...lines, `  FAIL  ${name}`, ...result.diagnostics.slice(0, 3).map(d => `        ${d.name}: ${d.message}`)], rows, untrackable }
  }

  indexFaces(work)

  // each unit's text, its native prelude's reads of the runtime shims traced too: they are inputs of the file
  beginModule()
  setRecording(true)

  let contents: string[]

  try {
    contents = [...result.modules].map(([module, emit]) => unitContent(c, result, emit.code, module === file))
  } finally {
    setRecording(false)
  }

  const preludeKeys = endModule()

  untrackable ||= preludeKeys.includes(UNTRACKABLE)
  rows = sightings([...new Set([...keys, ...preludeKeys])]).rows

  const modules: UnitModule[] = []
  let wrote = false
  let stale = false
  let unmatched = 0
  let at = 0

  for (const [module, emit] of result.modules) {
    const slug = unitSlug(work, module)
    const own = module === file
    const content = contents[at++]!
    const path = join(UNIT_DIR, `${slug}.ts`)
    // a port's unit is its own entry's to write (the keeper text is its own), or anyone's while it is missing
    const mine = own || !work.ports.has(module) || !existsSync(path)
    const changed = !check && mine && writeChanged(path, content)
    const differs = check && mine && !(existsSync(path) && readFileSync(path, 'utf8') === content)
    const faces = work.faces.get(module)?.get(emit.code)

    if (faces === undefined) {
      unmatched++
    }

    wrote ||= changed && own
    stale ||= differs
    modules.push({
      slug,
      module: relative(TERM, module),
      out: sha(content),
      wrote: changed,
      own,
      face: faces === undefined ? '' : [...faces].sort().join(','),
      imports: [...new Set((edges.get(module) ?? []).map(dep => unitSlug(work, dep)))].filter(dep => dep !== slug).sort(),
      ...(differs ? { stale: true } : {}),
    })
  }

  const { shimPath, shim, run } = shimOf(work, root, file, result)

  if (run && 'missing' in run) {
    return { tally: 'failed', lines: [...lines, `  FAIL  ${name}`, `        run-entry: the shim exports no task for ${run.missing.join(', ')}, which a hook names`], rows, untrackable }
  }

  const runPath = shimPath.replace(/\.ts$/, '-run.ts')

  if (check) {
    const held = (path: string, want: string): boolean => existsSync(path) && readFileSync(path, 'utf8') === want

    if (!held(shimPath, shim) || (run && !held(runPath, run.text))) {
      stale = true
      lines.push(`  STALE ${relative(TERM, shimPath)}`)
    }
  } else {
    wrote = writeChanged(shimPath, shim) || wrote

    if (run) {
      wrote = writeChanged(runPath, run.text) || wrote
    }

    if (wrote) {
      lines.push(`  built ${relative(TERM, shimPath)}`)
    }
  }

  return {
    tally: stale ? 'stale' : wrote ? 'built' : 'unchanged',
    lines,
    unit: unitSlug(work, file),
    text: sha(text),
    shim: sha(shim),
    ...(run ? { run: sha(run.text) } : {}),
    modules,
    built: result.built,
    reused: result.reused.length,
    unmatched,
    rows,
    untrackable,
  }
}

// a path the table never keys: port-build's own outputs and stores, whose content is a function of the rest
function outputPath(path: string): boolean {
  return [UNIT_DIR, UNIT_STORE, STAGE_UNIT_STORE, projectHome(TERM, 'port-build.json')].some(dir => path === dir || path.startsWith(`${dir}${sep}`)) || /[\\/]host[\\/]port[\\/]/.test(path)
}

// THE FAST PATH (spec-1339 section 6): the same stage0 and fingerprint, the same entries, every output on disk the one
// the last run wrote, and every observation the last run's compiles made still seeing the same thing. Then nothing is
// compiled and the engine is never loaded. The answer says why not, the first reason found, cheapest checks first
function fastPath(previous: UnitsManifest | undefined, plan: { root: string; files: { file: string; text: string }[] }[], stage0Id: string, print: string): string | undefined {
  if (previous === undefined) {
    return 'no schema 3 manifest'
  }

  if (full) {
    return '--full'
  }

  if (previous.stage0 !== stage0Id) {
    return `stage0 is ${stage0Id.slice(0, 8)}, the last run's ${previous.stage0.slice(0, 8)}`
  }

  if (previous.fingerprint !== print) {
    return 'the fingerprint moved'
  }

  const hashOf = (path: string): string | undefined => untraced(() => (existsSync(path) ? sha(readFileSync(path)) : undefined))
  const chosen = new Set<string>()

  for (const { root, files } of plan) {
    for (const { file } of files) {
      const shimPath = portPath(root, file)
      const key = relative(TERM, shimPath)
      const row = previous.shims[key]

      chosen.add(key)

      if (row === undefined || row.failed || row.module !== relative(TERM, file)) {
        return `${relative(TERM, file)} has no good row`
      }

      if (hashOf(shimPath) !== row.out || (row.run !== undefined && hashOf(shimPath.replace(/\.ts$/, '-run.ts')) !== row.run)) {
        return `${key} is not what the last run wrote`
      }
    }
  }

  if (only === undefined && Object.keys(previous.shims).some(key => !chosen.has(key))) {
    return 'a port was removed or shelved'
  }

  // a file under a port deck's host/port/ the last run did not write (a shelved port's shim from before the removal
  // existed, item 1370, or one carried in): the engine's whole run removes it
  if (only === undefined) {
    const wrote = new Set(Object.entries(previous.shims).flatMap(([key, row]) => (row.run === undefined ? [key] : [key, key.replace(/\.ts$/, '-run.ts')])))
    const stray = Object.keys(DECKS)
      .flatMap(deck => portFiles(join(TERM, 'deck', deck, 'host', 'port')))
      .find(path => !wrote.has(relative(TERM, path)))

    if (stray !== undefined) {
      return `${relative(TERM, stray)} is no output of the last run`
    }
  }

  for (const [slug, row] of Object.entries(previous.units)) {
    if (hashOf(join(UNIT_DIR, `${slug}.ts`)) !== row.out) {
      return `host/unit/${slug}.ts is not what the last run wrote`
    }
  }

  if (only === undefined && existsSync(UNIT_DIR)) {
    const stray = readdirSync(UNIT_DIR).find(entry => !previous.units[entry.replace(/\.ts$/, '')] || !entry.endsWith('.ts'))

    if (stray !== undefined) {
      return `host/unit/${stray} is no unit of the last run`
    }
  }

  for (const [key, saw] of previous.table) {
    if (key === UNTRACKABLE) {
      return 'the last run cannot key a skip (it saw a file move, failed, or chose entries)'
    }

    const cut = key.indexOf('\0')

    if (observe(key.slice(0, cut), key.slice(cut + 1)) !== saw) {
      return `${key.slice(0, cut)} ${relative(TERM, key.slice(cut + 1))} moved`
    }
  }

  return undefined
}

// `--units --reprint` (item 1367's copy-back, asked of 1368 to 1370): THIS machine's fingerprint into a manifest another
// machine wrote, compiling nothing and never loading stage0. The fingerprint hashes the node version, and the M3's node
// (v22.14.0) is not this Mac's, so a manifest the queue carries back from the M3 holds a print this Mac never computes,
// and the first `make:port` here read 'the fingerprint moved' and built every unit cold. The reprint is written only
// when EVERY other key of the fast path holds here (stage0, the entries, every shim, run entry and unit file the
// manifest names, no stray output, every row of the table), so the built files are exactly what this Mac's fast path
// would accept but for the node version. Anything else is refused, exit 1, nothing written. Never with --only, --check
// or --full. Prints `PRINT <hex>`, this machine's fingerprint, either way
const reprint = process.argv.includes('--reprint')

function reprintUnits(plan: { root: string; files: { file: string; text: string }[] }[], previous: UnitsManifest | undefined, manifestPath: string, stage0Id: string, print: string): void {
  console.log(`PRINT ${print}`)

  const refuse = (why: string): void => {
    console.log(`term port-build --units --reprint: REFUSED, ${why}; nothing written`)
    process.exitCode = 1
  }

  if (only !== undefined || check || full) {
    return refuse('--reprint takes no --only, --check or --full')
  }

  if (previous === undefined) {
    return refuse('no schema 3 manifest')
  }

  const why = fastPath(previous, plan, stage0Id, previous.fingerprint)

  if (why !== undefined) {
    return refuse(`a key other than the fingerprint moved: ${why}`)
  }

  if (previous.fingerprint === print) {
    console.log(`term port-build --units --reprint: the manifest already holds this print ${print.slice(0, 12)}, nothing written`)
    return
  }

  writeFileSync(`${manifestPath}.${process.pid}`, JSON.stringify({ ...previous, fingerprint: print } satisfies UnitsManifest))
  real.renameSync(`${manifestPath}.${process.pid}`, manifestPath)
  console.log(
    `term port-build --units --reprint: fingerprint ${previous.fingerprint.slice(0, 12)} to ${print.slice(0, 12)}, every other key holds ` +
      `(${previous.table.length} observations, ${Object.keys(previous.units).length} units, ${Object.keys(previous.shims).length} shims), the engine not loaded`,
  )
}

// THE UNITS, the whole run: THE FAST PATH, or every chosen entry to the engine, longest closure first, then the manifest,
// the summary and the removal of unit files no unit wrote. Under --check nothing is written and a differing output is
// STALE. Under --stage-check, step 2 follows (stageTwoUnits)
async function unitsMain(plan: { root: string; files: { file: string; text: string }[] }[], print: string | undefined, stage0Id: string | undefined, lock: { free: () => void } | undefined, jobs: number): Promise<void> {
  if (print === undefined || stage0Id === undefined) {
    throw new Error('port-build --units: no stage0 pin or no compiler fingerprint, so no store namespace: refusing to compile')
  }

  // nothing port-build observed before this, loading included, is a key: stage0 and the fingerprint are
  setRecording(false)
  forgetOutside()

  const started = Date.now()
  const manifestPath = projectHome(TERM, 'port-build.json')
  const previous = readUnitsManifest(manifestPath)

  if (reprint) {
    reprintUnits(plan, previous, manifestPath, stage0Id, print)
    return
  }

  const entries = plan.reduce((sum, one) => sum + one.files.length, 0)
  const why = fastPath(previous, plan, stage0Id, print)

  if (why === undefined) {
    console.log(
      `term port-build --units: fast path, ${entries} entries and ${Object.keys(previous!.units).length} units current, ${previous!.table.length} observations hold, ` +
        `the engine not loaded, ${((Date.now() - started) / 1000).toFixed(1)} s`,
    )
    console.log(`term port-build: 0 built, ${entries} unchanged, 0 failed`)

    if (stageCheck && !check) {
      await stageTwoUnits(plan, lock, jobs)
    }

    return
  }

  console.log(`  fast path: no, ${why}`)

  const { id } = await stage0Loaded()
  const namespace = sha(`stage0 ${id}\nport-build ${print}`).slice(0, 32)
  const store = join(UNIT_STORE, namespace)
  let dropped = 0

  // only the current namespace is kept: one that is not is a stage0 or a port-build nobody runs here any more
  for (const old of existsSync(UNIT_STORE) ? readdirSync(UNIT_STORE) : []) {
    if (old !== namespace && !check) {
      traced.rmSync(join(UNIT_STORE, old), { recursive: true, force: true })
      dropped++
    }
  }

  console.log(`  units store ${relative(TERM, store)}${existsSync(store) ? '' : ' (new)'}${dropped > 0 ? `, ${dropped} old namespace(s) removed` : ''}`)

  const order = plan.flatMap(({ root, files }) => files.map(({ file }) => ({ root, file, name: relative(TERM, file) })))
  const turns: (UnitsTurn | undefined)[] = []
  const counts = { built: 0, unchanged: 0, failed: 0, moved: 0, stale: 0 }
  const fresh: Record<string, ShimRow> = {}
  const failed = new Set<string>()
  // every unit text a compile made, by slug: its module, the texts and who made each, whether written, the entry's own
  // text, the interfaces importers saw and the entry's own, and the units its module loads
  type Seen = { module: string; outs: Map<string, string[]>; written: boolean; own?: string; faces: Set<string>; ownFace?: string; imports?: string[]; ownImports?: string[] }
  const seen = new Map<string, Seen>()
  const staleUnits = new Set<string>()
  // THE RUN'S TABLE: every observation of every compile, each with what it saw; `drift` once two saw one apart, or a
  // compile could not be traced
  const runTable = new Map<string, string>()
  let drift = false
  const engineBuilt: string[] = []
  let reused = 0
  let unmatched = 0
  let taken = 0

  const take = (at: number, turn: UnitsTurn): void => {
    const { name, root, file } = order[at]!

    turn.lines.forEach(line => console.log(line))
    counts[turn.tally]++
    drift ||= turn.untrackable === true

    for (const [key, saw] of turn.rows ?? []) {
      const held = runTable.get(key)

      if (held === undefined) {
        runTable.set(key, saw)
      } else if (held !== saw) {
        drift = true
      }
    }

    if (turn.tally === 'failed' || turn.tally === 'moved') {
      failed.add(relative(TERM, portPath(root, file)))
    }

    if (turn.shim !== undefined && turn.unit !== undefined) {
      fresh[relative(TERM, portPath(root, file))] = { module: name, unit: turn.unit, text: turn.text!, out: turn.shim, ...(turn.run ? { run: turn.run } : {}) }
    }

    for (const one of turn.modules ?? []) {
      const it: Seen = seen.get(one.slug) ?? { module: one.module, outs: new Map(), written: false, faces: new Set() }
      const by = it.outs.get(one.out) ?? []

      by.push(name)
      it.outs.set(one.out, by)
      it.written ||= one.wrote

      if (one.own) {
        it.own = one.out
        it.ownFace = one.face
        it.ownImports = one.imports
      } else {
        it.faces.add(one.face)
        it.imports ??= one.imports
      }

      if (one.stale) {
        staleUnits.add(one.slug)
      }

      seen.set(one.slug, it)
    }

    // `--explain`: each unit the engine built for this entry, by its id
    for (const id of explain ? (turn.built ?? []) : []) {
      console.log(`  unit built ${id}  (for ${name})`)
    }

    engineBuilt.push(...(turn.built ?? []))
    reused += turn.reused ?? 0
    unmatched += turn.unmatched ?? 0
  }

  const arrive = (at: number, turn: UnitsTurn): void => {
    turns[at] = turn

    for (; turns[taken]; taken++) {
      take(taken, turns[taken]!)
      turns[taken] = undefined
    }
  }

  // LONGEST FIRST, by the number of units the last manifest says the entry's closure holds (none known: the biggest)
  const closure = new Map<string, number>()
  const sizeOf = (slug: string): number => {
    let size = closure.get(slug)

    if (size === undefined) {
      const reached = new Set<string>([slug])
      const queue = [slug]

      while (queue.length > 0) {
        for (const dep of Object.keys(previous?.units[queue.pop()!]?.imports ?? {})) {
          if (!reached.has(dep)) {
            reached.add(dep)
            queue.push(dep)
          }
        }
      }

      size = reached.size
      closure.set(slug, size)
    }

    return size
  }
  const size = (at: number): number => {
    const row = previous?.shims[relative(TERM, portPath(order[at]!.root, order[at]!.file))]

    return row === undefined ? Number.MAX_SAFE_INTEGER : sizeOf(row.unit)
  }
  const all = order.map((_, at) => at)

  if (jobs === 1 || all.length < 2) {
    for (const at of all) {
      arrive(at, unitsTurn(order[at]!.root, order[at]!.file, store))
    }
  } else {
    const sizes = new Map(all.map(at => [at, size(at)]))
    const longestFirst = [...all].sort((a, b) => sizes.get(b)! - sizes.get(a)! || a - b)

    await fanOut<UnitsTurn>(
      jobs,
      [],
      longestFirst.map(at => ({ at, name: order[at]!.name, job: { root: order[at]!.root, file: order[at]!.file, store, units: true } })),
      arrive,
    )
  }

  // A MODULE TWO COMPILES EMIT OTHERWISE: one no port names must read the same from every entry; a port's own text may
  // differ from another entry's emit only by its keeper, so it is counted, never refused
  let disagree = 0
  let keeperOnly = 0
  const ports = new Set(order.map(({ name }) => name))

  for (const [slug, one] of seen) {
    if (one.outs.size < 2) {
      continue
    }

    if (ports.has(one.module) && one.own !== undefined) {
      keeperOnly++
      continue
    }

    disagree++
    console.log(`  DISAGREE host/unit/${slug}.ts  (${one.module}: ${one.outs.size} texts, ${[...one.outs.values()].map(by => `${by.length} from ${by[0]}`).join('; ')})`)
  }

  for (const slug of [...staleUnits].sort()) {
    console.log(`  STALE host/unit/${slug}.ts`)
  }

  // the unit files no unit of this run wrote or made: a shelved, moved or deleted module (T-0425). Only after a whole
  // run that left nothing failed or moved, and never under --only or --check
  const whole = only === undefined && counts.failed === 0 && counts.moved === 0
  let removed = 0

  if (whole && !check && existsSync(UNIT_DIR)) {
    for (const entry of readdirSync(UNIT_DIR)) {
      if (!seen.has(entry.replace(/\.ts$/, '')) || !entry.endsWith('.ts')) {
        traced.rmSync(join(UNIT_DIR, entry), { force: true })
        removed++
      }
    }
  }

  // the entry shims and run entries no entry of this run wrote, by the same rule (item term-self-host-001-1370): a
  // shelved or deleted port's shim under a port deck's host/port/ kept importing a unit file the lines above removed.
  // A file there is port-build's output and nothing else (portPath), so one that is no current shim, and no current
  // shim's `-run.ts`, has no source. Also a `<file>.<pid>` temp file left by a process killed between its write and its
  // rename (writeChanged), whose process is gone
  const removedShims: string[] = []

  if (whole && !check) {
    const keep = new Set<string>()

    for (const [key, row] of Object.entries(fresh)) {
      keep.add(key)

      if (row.run !== undefined) {
        keep.add(key.replace(/\.ts$/, '-run.ts'))
      }
    }

    for (const deck of Object.keys(DECKS)) {
      for (const path of portFiles(join(TERM, 'deck', deck, 'host', 'port'))) {
        const key = relative(TERM, path)
        const temp = /\.ts\.(\d+)$/.exec(path)

        if (temp ? !alive(Number(temp[1])) : path.endsWith('.ts') && !keep.has(key)) {
          traced.rmSync(path, { force: true })
          removedShims.push(key)
        }
      }
    }

    for (const key of removedShims) {
      console.log(`  removed ${key}  (no entry of this run wrote it)`)
    }
  }

  // the interface of a unit as its importers saw it (a port's own entry adds its keeper, which no importer sees), and
  // its imports as its written file has them
  const faceOf = (one: Seen): string => (one.faces.size > 0 ? [...one.faces].sort().join(';') : (one.ownFace ?? ''))
  const unitRows: Record<string, UnitRow> = whole ? {} : { ...(previous?.units ?? {}) }
  let largest = { slug: '', bytes: 0 }
  let foreign = 0

  for (const [slug, one] of seen) {
    const path = join(UNIT_DIR, `${slug}.ts`)
    const bytes = existsSync(path) ? readFileSync(path) : undefined

    if (bytes === undefined) {
      continue
    }

    // a name no unit of this run (or, not whole, of the last) has is not a unit: it is counted and left out
    const named = (ports.has(one.module) && one.ownImports) || one.imports || one.ownImports || []
    const imports = named.filter(dep => seen.has(dep) || (!whole && previous?.units[dep] !== undefined))

    foreign += named.length - imports.length

    const source = runTable.get(`read\0${join(TERM, one.module)}`)

    unitRows[slug] = {
      sources: { [one.module]: source ?? sha(readFileSync(join(TERM, one.module))) },
      interface: faceOf(one),
      imports: Object.fromEntries(imports.map(dep => [dep, seen.has(dep) ? faceOf(seen.get(dep)!) : (unitRows[dep]?.interface ?? '')])),
      out: sha(bytes),
    }

    if (bytes.length > largest.bytes) {
      largest = { slug, bytes: bytes.length }
    }
  }

  // the shims: this run's, and where it was not whole, the last run's for the entries it did not reach, a failed or
  // moved one marked failed
  const shimRows: Record<string, ShimRow> = {}

  for (const [key, row] of Object.entries(previous?.shims ?? {})) {
    if (failed.has(key)) {
      shimRows[key] = { ...row, failed: true }
    } else if (!whole && fresh[key] === undefined) {
      shimRows[key] = row
    }
  }

  Object.assign(shimRows, fresh)

  const table: [string, string][] = drift || !whole ? [[UNTRACKABLE, 'never']] : [...runTable].filter(([key]) => !outputPath(key.slice(key.indexOf('\0') + 1)))

  if (!check) {
    try {
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeFileSync(
        `${manifestPath}.${process.pid}`,
        JSON.stringify({ schema: UNITS_SCHEMA, stage0: id, fingerprint: print, table, units: unitRows, shims: shimRows } satisfies UnitsManifest),
      )
      real.renameSync(`${manifestPath}.${process.pid}`, manifestPath)
    } catch {
      // a manifest that cannot be written only means the next run asks the engine and --verify reads less
    }
  }

  const distinct = new Set(engineBuilt).size
  const written = [...seen.values()].filter(one => one.written).length

  console.log(
    `term port-build --units: ${order.length} entries in ${Math.round((Date.now() - started) / 1000)} s, ${seen.size} units (${written} written, ${removed} removed, ${removedShims.length} port files removed, largest host/unit/${largest.slug}.ts ${largest.bytes} bytes), ` +
      `engine ${engineBuilt.length} unit builds (${distinct} distinct units) and ${reused} replays, ${keeperOnly} port units whose own text differs from another entry's emit, ${disagree} disagree, ` +
      `${unmatched} emits with no interface found, ${foreign} loads naming no unit, table ${table[0]?.[0] === UNTRACKABLE ? 'never holds' : `${table.length} rows`}`,
  )
  console.log(
    `term port-build: ${counts.built} built, ${counts.unchanged} unchanged${check ? `, ${counts.stale} stale` : ''}, ${counts.failed} failed${counts.moved > 0 ? `, ${counts.moved} moved` : ''}`,
  )

  if (counts.failed > 0 || counts.moved > 0 || counts.stale > 0 || disagree > 0 || staleUnits.size > 0) {
    process.exitCode = 1
  }

  if (stageCheck && !check) {
    if (process.exitCode === 1) {
      console.log('term port-build --stage-check: step 2 not run, step 1 did not build every port')
      return
    }

    await stageTwoUnits(plan, lock, jobs)
  }
}

// one entry's turn in --stage-check's step 2 under --units: the files step 1 would write for it, each with its hash
type StageUnitsTurn = { tally: 'same' | 'failed' | 'gone'; lines: string[]; files: [string, string][] }

// the entry compiled with the working tree's engine (stage1), each file step 1 would write for it written under
// tmp/self-host/stage-check/
function stageUnitsTurn(c: Compiler, root: string, file: string, store: string): StageUnitsTurn {
  const work = unitWorkOf(c, store)
  const name = relative(TERM, file)
  const text = sourceOf(file)

  if (text === undefined) {
    return { tally: 'gone', lines: [], files: [] }
  }

  const { result } = compileEntry(work, root, file, text)

  if (!result.ok) {
    return { tally: 'failed', lines: [`  FAIL   ${name}  (stage1 cannot compile it: ${result.diagnostics[0]?.name ?? ''} ${result.diagnostics[0]?.message ?? ''})`], files: [] }
  }

  const files: [string, string][] = []
  const put = (path: string, content: string): void => {
    const at = relative(TERM, path)
    const scratch = join(STAGE_SCRATCH, at)

    mkdirSync(dirname(scratch), { recursive: true })
    writeFileSync(scratch, content)
    files.push([at, sha(content)])
  }

  for (const [module, emit] of result.modules) {
    const own = module === file

    if (own || !work.ports.has(module)) {
      put(join(UNIT_DIR, `${unitSlug(work, module)}.ts`), unitContent(c, result, emit.code, own))
    }
  }

  const { shimPath, shim, run } = shimOf(work, root, file, result)

  put(shimPath, shim)

  if (run && 'text' in run) {
    put(shimPath.replace(/\.ts$/, '-run.ts'), run.text)
  }

  return { tally: 'same', lines: [], files }
}

// STEP 2 of `--stage-check` under --units (decision 030 section 1, 036, spec-1339 section 7 step 4): every chosen entry
// compiled again through the working tree's compileSeparate, which resolves to the shims and units step 1 wrote
// (stage1), and every file step 1 writes for it held byte for byte against step 1's. Step 1's files are hashed while the
// lock is held, then the lock is freed. Its store is its own, namespaced by step 1's output, only the current kept
async function stageTwoUnits(plan: { root: string; files: { file: string; text: string }[] }[], lock: { free: () => void } | undefined, jobs: number): Promise<void> {
  setRecording(false)

  const step1 = new Map<string, string>()
  const hashOf = (path: string): void => {
    if (existsSync(path)) {
      step1.set(relative(TERM, path), sha(readFileSync(path)))
    }
  }

  for (const entry of existsSync(UNIT_DIR) ? readdirSync(UNIT_DIR).sort() : []) {
    hashOf(join(UNIT_DIR, entry))
  }

  const order: { root: string; file: string }[] = []

  for (const { root, files } of plan) {
    for (const { file } of files) {
      const shimPath = portPath(root, file)

      hashOf(shimPath)
      hashOf(shimPath.replace(/\.ts$/, '-run.ts'))
      order.push({ root, file })
    }
  }

  lock?.free()

  const namespace = sha([...step1].map(([path, hash]) => `${path} ${hash}`).join('\n')).slice(0, 32)
  const store = join(STAGE_UNIT_STORE, namespace)

  for (const old of existsSync(STAGE_UNIT_STORE) ? readdirSync(STAGE_UNIT_STORE) : []) {
    if (old !== namespace) {
      traced.rmSync(join(STAGE_UNIT_STORE, old), { recursive: true, force: true })
    }
  }

  const counts = { failed: 0, gone: 0 }
  const made = new Map<string, Set<string>>()
  const turns: (StageUnitsTurn | undefined)[] = []
  let taken = 0

  const arrive = (at: number, turn: StageUnitsTurn): void => {
    turns[at] = turn

    for (; turns[taken]; taken++) {
      const one = turns[taken]!

      one.lines.forEach(line => console.log(line))

      if (one.tally !== 'same') {
        counts[one.tally]++
      }

      for (const [path, hash] of one.files) {
        made.set(path, (made.get(path) ?? new Set()).add(hash))
      }

      turns[taken] = undefined
    }
  }

  if (jobs === 1 || order.length < 2) {
    const c = await workingCompiler()

    order.forEach(({ root, file }, at) => arrive(at, stageUnitsTurn(c, root, file, store)))
  } else {
    await fanOut<StageUnitsTurn>(
      jobs,
      ['--stage-two'],
      order.map(({ root, file }, at) => ({ at, name: relative(TERM, file), job: { root, file, store, units: true } })),
      arrive,
    )
  }

  let same = 0
  let differ = 0

  for (const [path, hashes] of [...made].sort(([a], [b]) => a.localeCompare(b))) {
    const theirs = step1.get(path)

    if (hashes.size === 1 && theirs !== undefined && hashes.has(theirs)) {
      same++
      continue
    }

    differ++

    const before = existsSync(join(TERM, path)) ? readFileSync(join(TERM, path), 'utf8') : ''
    const after = readFileSync(join(STAGE_SCRATCH, path), 'utf8')

    console.log(`  DIFFER ${path}  (${hashes.size > 1 ? `stage1 emits it ${hashes.size} ways, ` : ''}${firstDifference(before, after)})`)
  }

  console.log(
    `term port-build --stage-check: step 2 ${same} same, ${differ} differ, ${counts.failed} failed (units and shims, stage1 output in ${relative(TERM, STAGE_SCRATCH)})`,
  )

  if (differ > 0 || counts.failed > 0) {
    process.exitCode = 1
  }
}

// `--verify` of a schema 3 manifest, compiler-free and sound (spec-1339 section 6): an entry is current when its shim and
// run entry are the ones the last build wrote from its source as it is now, and every unit its closure reaches is
// current: its file the one written, its module's `.tree` the one read, and each unit it loads recorded with the
// interface it was built against. A unit whose own source changed makes every entry reaching it stale, since whether
// its interface moved is the compiler's to say
function verifyUnits(plan: { root: string; files: { file: string; text: string }[] }[], manifest: UnitsManifest): void {
  const hashOf = (path: string): string | undefined => untraced(() => (existsSync(path) ? sha(readFileSync(path)) : undefined))
  const own = new Map<string, string | undefined>()
  const ownProblem = (slug: string): string | undefined => {
    if (own.has(slug)) {
      return own.get(slug)
    }

    const row = manifest.units[slug]
    let problem: string | undefined

    if (row === undefined) {
      problem = `no build has recorded host/unit/${slug}.ts`
    } else if (hashOf(join(UNIT_DIR, `${slug}.ts`)) !== row.out) {
      problem = `host/unit/${slug}.ts is not the one the last build wrote`
    } else {
      for (const [file, hash] of Object.entries(row.sources)) {
        if (hashOf(join(TERM, file)) !== hash || sourceOf(join(TERM, file)) === undefined) {
          problem = `${file} changed after host/unit/${slug}.ts was built`
          break
        }
      }

      for (const [dep, face] of problem === undefined ? Object.entries(row.imports) : []) {
        const theirs = manifest.units[dep]

        if (theirs === undefined) {
          problem = `host/unit/${slug}.ts imports host/unit/${dep}.ts, which no build has recorded`
          break
        }

        if (theirs.interface !== face) {
          problem = `host/unit/${slug}.ts was built against another interface of host/unit/${dep}.ts`
          break
        }
      }
    }

    own.set(slug, problem)
    return problem
  }
  // the first unit of the closure that is not current, breadth first from the entry's own
  const closureProblem = (slug: string): string | undefined => {
    const reached = new Set([slug])
    const queue = [slug]

    for (let at = 0; at < queue.length; at++) {
      const problem = ownProblem(queue[at]!)

      if (problem !== undefined) {
        return problem
      }

      for (const dep of Object.keys(manifest.units[queue[at]!]!.imports)) {
        if (!reached.has(dep)) {
          reached.add(dep)
          queue.push(dep)
        }
      }
    }

    return undefined
  }
  let good = 0
  let bad = 0

  for (const { root, files } of plan) {
    for (const { file, text } of files) {
      const name = relative(TERM, file)
      const shimPath = portPath(root, file)
      const row = manifest.shims[relative(TERM, shimPath)]
      const out = hashOf(shimPath)
      const problem =
        row === undefined
          ? 'no build has recorded it: run port-build'
          : row.failed
            ? 'its last build failed: run port-build to see why'
            : out === undefined
              ? 'its port is missing'
              : row.text !== sha(text)
                ? 'its source changed after its port was built'
                : row.out !== out
                  ? 'its port is not the one the last build wrote'
                  : row.run !== undefined && hashOf(shimPath.replace(/\.ts$/, '-run.ts')) !== row.run
                    ? 'its run entry is not the one the last build wrote'
                    : closureProblem(row.unit)

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

// THE JOBS: `work` handed out to at most `count` workers, each `arrive`d by its place as it finishes. The promise settles
// when every worker has gone. A thrown compile or a worker that ends with work in hand rejects it, and every worker stops
function fanOut<Answer>(count: number, flags: string[], work: { at: number; name: string; job: unknown }[], arrive: (at: number, answer: Answer) => void): Promise<void> {
  type Reply = { ready?: true; answer?: Answer; thrown?: string }

  return new Promise((done, fail) => {
    const running = new Map<ChildProcess, { at: number; name: string } | undefined>()
    let next = 0
    let failure: Error | undefined

    const stop = (): void => {
      for (const child of running.keys()) {
        child.kill('SIGKILL')
      }
    }
    const stopped = (): void => {
      stop()
      process.exit(130)
    }
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

    process.on('exit', stop)
    signals.forEach(signal => process.once(signal, stopped))

    const stopFor = (error: Error): void => {
      failure ??= error
      stop()
    }

    const give = (child: ChildProcess): void => {
      const item = work[next]

      if (!item) {
        running.set(child, undefined)
        child.disconnect()
        return
      }

      next++
      running.set(child, item)
      child.send(item.job as object)
    }

    for (let index = 0; index < Math.min(count, work.length); index++) {
      const child = fork(process.argv[1]!, [...process.argv.slice(2), ...flags, '--port-worker'], { execArgv: process.execArgv })

      running.set(child, undefined)
      child.on('message', (reply: Reply) => {
        if (failure) {
          return
        }

        if (reply.thrown !== undefined) {
          stopFor(new Error(`port-build: ${running.get(child)?.name} threw in a worker\n${reply.thrown}`))
        } else if (reply.answer !== undefined) {
          arrive(running.get(child)!.at, reply.answer)
          give(child)
        } else if (reply.ready) {
          give(child)
        }
      })
      child.on('error', stopFor)
      child.on('exit', (code, signal) => {
        const held = running.get(child)

        running.delete(child)

        // a worker leaves with exit 0 once told there is no more work, and in no other way
        if (held !== undefined || next < work.length || code !== 0) {
          stopFor(new Error(`port-build: a worker ended (${signal ?? `exit ${code}`})${held ? ` compiling ${held.name}` : ''}`))
        }

        if (running.size === 0) {
          process.off('exit', stop)
          signals.forEach(one => process.off(one, stopped))

          if (failure) {
            fail(failure)
          } else {
            done()
          }
        }
      })
    }
  })
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

// every port module of DECKS, by deck, each with its text, `mark draft` files left out; `filter` keeps only the modules
// whose path holds it
function portPlan(filter: string | undefined): { root: string; files: { file: string; text: string }[] }[] {
  const plan: { root: string; files: { file: string; text: string }[] }[] = []

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

      if (filter === undefined || relative(TERM, file).includes(filter)) {
        chosen.push({ file, text })
      }
    }

    if (chosen.length > 0) {
      plan.push({ root, files: chosen })
    }
  }

  return plan
}

async function main(): Promise<void> {
  // `moved`: modules left unwritten because their sources kept changing while they compiled (THE WRITE-TIME CHECK)
  const counts = { built: 0, unchanged: 0, stale: 0, failed: 0, moved: 0 }
  const jobs = jobCount()

  // port-build's own bookkeeping is no part of any module's trace. `settle` in home.ts reaches `fs` itself
  setRecording(false)

  // `--verify` writes nothing, so it waits for no one
  const lock = verify ? undefined : await holdLineLock(`port-build${only === undefined ? '' : ` --only ${only}`}`)

  // `--manifest <path>` (with --verify only): read that manifest, a test's altered copy
  const manifestAt = process.argv.indexOf('--manifest')
  const manifestPath = verify && manifestAt >= 0 ? resolve(process.argv[manifestAt + 1]!) : projectHome(TERM, 'port-build.json')
  // under --units stage0 is not loaded yet (THE FAST PATH), and its pin names it
  const stage0Id = stage0?.id ?? (units && !verify ? readPin()?.id : undefined)
  const print = stage0Id === undefined ? undefined : await fingerprint(stage0Id)
  // the last manifest, whose entries this run keeps where it writes none of its own; under `--full` none is skipped
  const previous = print === undefined || units ? undefined : readManifest(manifestPath)
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
  const plan = portPlan(only)
  const every = new Set(portPlan(undefined).flatMap(({ files }) => files.map(({ file }) => relative(TERM, file))))

  if (verify) {
    setRecording(false)

    // a schema 3 manifest is verified through its units, whatever flags this run has
    const unitsManifest = readUnitsManifest(manifestPath)

    if (unitsManifest) {
      verifyUnits(plan, unitsManifest)
    } else {
      verifyPorts(plan, readManifest(manifestPath))
    }

    return
  }

  if (units) {
    await unitsMain(plan, print, stage0Id, lock, jobs)
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

  // the keys of each module written this run (decision 038), turned into rows of the manifest's table when it is written
  const freshKeys = new Map<string, string[]>()

  // every module's place in the plan, and its turn taken in that order, whichever finished first (THE JOBS)
  const order = plan.flatMap(({ root, files }) => files.map(({ file }) => ({ root, file, name: relative(TERM, file) })))
  const turns: (Turn | undefined)[] = []
  let taken = 0

  const take = (name: string, turn: Turn): void => {
    const keys = turn.rows ? adopt(turn.rows, turn.drifted === true, turn.untrackable === true) : turn.keys

    for (const line of turn.lines) {
      console.log(line)
    }

    counts[turn.tally]++

    if (turn.left !== undefined) {
      left.set(name, turn.left)
    }

    if (turn.carried) {
      carried[name] = turn.carried
    }

    if (turn.entry) {
      fresh[name] = turn.entry
      freshKeys.set(name, keys!)
    }
  }

  const arrive = (at: number, turn: Turn): void => {
    turns[at] = turn
    done++
    tell()

    for (; turns[taken]; taken++) {
      take(order[taken]!.name, turns[taken]!)
      turns[taken] = undefined
    }
  }

  tell()

  // THE SKIP, for every module before any compiles: the same compiler, the same text, every observation the compile that
  // wrote it made still seeing the same thing, and that output on disk now
  const compiles: number[] = []

  for (const [at, { root, file, name }] of order.entries()) {
    const text = sourceOf(file)

    if (text === undefined) {
      arrive(at, goneTurn(name))
      continue
    }

    const outPath = portPath(root, file)
    const runPath = outPath.replace(/\.ts$/, '-run.ts')
    const last = old?.modules[name]

    if (
      last &&
      last.fingerprint === print &&
      last.text === sha(text) &&
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
      arrive(at, { tally: 'unchanged', carried: last, lines: explain ? [`  skip  ${name}`] : [] })
    } else {
      compiles.push(at)
    }
  }

  if (jobs === 1 || compiles.length < 2) {
    for (const at of compiles) {
      arrive(at, compileTurn(order[at]!.root, order[at]!.file, print))
    }
  } else {
    // LONGEST FIRST (term-self-host-001-1097): the workers take the biggest closures first, so the run does not end on
    // one worker compiling the console's whole closure while the others idle. A module's size is the number of
    // observations its last build made (a module with no entry counts as the biggest). Only the order work is handed out
    // changes: each turn is still taken in plan order (THE JOBS), so output, stdout and manifest are as they were
    const size = (at: number): number => {
      const reads = previous?.modules[order[at]!.name]?.reads
      return reads === undefined ? Number.MAX_SAFE_INTEGER : reads.reduce((sum, [from, to]) => sum + to - from, 0)
    }
    const sizes = new Map(compiles.map(at => [at, size(at)]))
    const longestFirst = [...compiles].sort((a, b) => sizes.get(b)! - sizes.get(a)! || a - b)

    await fanOut<Turn>(
      jobs,
      [],
      longestFirst.map(at => {
        const { root, file, name } = order[at]!

        return { at, name, job: { root, file, print } }
      }),
      arrive,
    )
  }

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
    `term port-build: ${counts.built} built, ${counts.unchanged} unchanged${check ? `, ${counts.stale} stale` : ''}, ${counts.failed} failed${counts.moved > 0 ? `, ${counts.moved} moved` : ''}`,
  )

  if (counts.failed > 0 || counts.stale > 0 || counts.moved > 0) {
    process.exitCode = 1
  }

  if (stageCheck && !check) {
    if (process.exitCode === 1) {
      console.log('term port-build --stage-check: step 2 not run, step 1 did not build every port')
      return
    }

    await stageTwo(plan, lock, jobs)
  }
}

const stageCheck = process.argv.includes('--stage-check')

// where step 2 writes
const STAGE_SCRATCH = join(TERM, 'tmp', 'self-host', 'stage-check')

// one module's turn in step 2, in whichever process compiles it. `gone`: its source went since the run began
type StageTurn = { tally: 'same' | 'differ' | 'failed' | 'gone'; lines: string[] }

// the working tree's modules, by specifiers esbuild cannot follow, so the fingerprint never reaches them
async function workingCompiler(): Promise<Compiler> {
  const working: Record<string, unknown> = {}

  for (const specifier of Object.keys(STAGE0_SOURCES)) {
    Object.assign(working, (await import(specifier)) as Record<string, unknown>)
  }

  return working as Compiler
}

// the first line where two texts differ, 1-based, with both lines
function firstDifference(a: string, b: string): string {
  const left = a.split('\n')
  const right = b.split('\n')

  for (let line = 0; line < Math.max(left.length, right.length); line++) {
    if (left[line] !== right[line]) {
      return `line ${line + 1}\n          stage0: ${(left[line] ?? '<end>').slice(0, 160)}\n          stage1: ${(right[line] ?? '<end>').slice(0, 160)}`
    }
  }

  return 'no line differs (a byte at the end)'
}

// step 2 keeps one resolver and one role reader per deck
const stageReaders = new Map<string, { resolve: ReturnType<Compiler['projectResolver']>; leanOf: ReturnType<Compiler['projectLeanOf']> }>()

function stageTurn(c: Compiler, root: string, file: string, one: { out?: string; run?: string }): StageTurn {
  const readers = stageReaders.get(root) ?? { resolve: c.projectResolver(root), leanOf: c.projectLeanOf(root) }
  const { resolve, leanOf } = readers

  stageReaders.set(root, readers)

  const name = relative(TERM, file)
  const text = sourceOf(file)

  if (text === undefined) {
    return { tally: 'gone', lines: [] }
  }

  const parsed = runParseMemo(c.makeParseMemo)
  const walked: WalkMemo = new Map()
  const keep = holdsPrinter(name, { file, text }, resolve, parsed, walked, c.collectModules)
  const result = c.compile({ file, text: keep ? `${text}${printerKeeper(leanOf(file) === true)}` : text }, { resolve, leanOf, library: true, parsed, walked })

  if (!result.ok) {
    return {
      tally: 'failed',
      lines: [`  FAIL   ${name}  (stage1 cannot compile it: ${result.diagnostics[0]?.name ?? ''} ${result.diagnostics[0]?.message ?? ''})`],
    }
  }

  const content = printerExports(portContent(result.program, result.typescript, c.nativePrelude))
  const run = basename(root) === 'call' ? runEntry(name, exportsFunction(content), result.program, c.toCamel) : undefined
  const runText = run && 'text' in run ? run.text : undefined
  const outPath = join(STAGE_SCRATCH, relative(TERM, portPath(root, file)))

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)

  if (runText !== undefined) {
    writeFileSync(outPath.replace(/\.ts$/, '-run.ts'), runText)
  }

  const portSame = one.out === sha(content)
  const runSame = one.run === (runText === undefined ? undefined : sha(runText))

  if (portSame && runSame) {
    return { tally: 'same', lines: [] }
  }

  const stagePath = portPath(root, file)
  const which = portSame ? stagePath.replace(/\.ts$/, '-run.ts') : stagePath
  const theirs = existsSync(which) ? readFileSync(which, 'utf8') : ''

  return {
    tally: 'differ',
    lines: [`  DIFFER ${name}  (${portSame ? 'its run entry' : 'its port'}, ${firstDifference(theirs, portSame ? (runText ?? '') : content)})`],
  }
}

// STEP 2 of `--stage-check` (decision 030 §1, 036): every chosen module compiled again with the working tree's
// compiler, which resolves to the ports step 1 just wrote (stage1), into `tmp/self-host/stage-check/`, and held byte
// for byte against step 1's port and run entry. The ports on disk are hashed while the lock is still held, then the
// lock is freed: step 2 writes only its scratch folder, and what it compares against is in memory
async function stageTwo(plan: { root: string; files: { file: string; text: string }[] }[], lock: { free: () => void } | undefined, jobs: number): Promise<void> {
  setRecording(false)

  const hashOf = (path: string): string | undefined => (existsSync(path) ? sha(readFileSync(path)) : undefined)
  const order: { root: string; file: string; one: { out?: string; run?: string } }[] = []

  for (const { root, files } of plan) {
    for (const { file } of files) {
      const outPath = portPath(root, file)
      order.push({ root, file, one: { out: hashOf(outPath), run: hashOf(outPath.replace(/\.ts$/, '-run.ts')) } })
    }
  }

  lock?.free()

  const counts = { same: 0, differ: 0, failed: 0, gone: 0 }
  const turns: (StageTurn | undefined)[] = []
  let taken = 0

  const arrive = (at: number, turn: StageTurn): void => {
    turns[at] = turn

    for (; turns[taken]; taken++) {
      counts[turns[taken]!.tally]++
      turns[taken]!.lines.forEach(line => console.log(line))
      turns[taken] = undefined
    }
  }

  if (jobs === 1 || order.length < 2) {
    const c = await workingCompiler()

    order.forEach(({ root, file, one }, at) => arrive(at, stageTurn(c, root, file, one)))
  } else {
    await fanOut<StageTurn>(
      jobs,
      ['--stage-two'],
      order.map(({ root, file, one }, at) => ({ at, name: relative(TERM, file), job: { root, file, one } })),
      arrive,
    )
  }

  console.log(`term port-build --stage-check: step 2 ${counts.same} same, ${counts.differ} differ, ${counts.failed} failed (stage1 output in ${relative(TERM, STAGE_SCRATCH)})`)

  if (counts.differ > 0 || counts.failed > 0) {
    process.exitCode = 1
  }
}

// a worker of THE JOBS: one job at a time from the process that started it, one answer back, until that process
// disconnects. What it observed while it loaded is that process's to file, so only its modules' own keys go back
async function portWorker(): Promise<void> {
  const two = process.argv.includes('--stage-two')

  // THE UNITS: stage0 waits for the first job's process, which is this one
  if (units && !two) {
    await stage0Loaded()
  }

  forgetOutside()

  if (two || units) {
    setRecording(false)
  }

  const c = two ? await workingCompiler() : undefined
  const send = (reply: object): void => {
    process.send!(reply)
  }

  process.on('disconnect', () => process.exit(0))
  process.on('message', (job: { root: string; file: string; print?: string; one?: { out?: string; run?: string }; store?: string; units?: true }) => {
    try {
      // THE UNITS: each turn traces its own compile, and step 2 of --stage-check compiles with stage1
      if (job.units) {
        send({ answer: c ? stageUnitsTurn(c, job.root, job.file, job.store!) : unitsTurn(job.root, job.file, job.store!) })
        return
      }

      if (c) {
        send({ answer: stageTurn(c, job.root, job.file, job.one!) })
        return
      }

      const { keys, ...turn } = compileTurn(job.root, job.file, job.print)

      send({ answer: keys ? { ...turn, ...sightings(keys), drifted: keys.includes(UNTRACKABLE) } : turn })
    } catch (error) {
      send({ thrown: (error as Error).stack ?? String(error) })
    }
  })
  send({ ready: true })
}

// run as a script; imported (test/call/port-prelude-once.ts reads `portContent`) it builds nothing
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await (process.argv.includes('--port-worker') ? portWorker() : main())
}
