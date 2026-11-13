// The cross-backend behavior gate for the standard library (base-v1-0001). Every stdlib test file is compiled for
// node, Rust, Swift and Kotlin, BUILT on the real toolchain, and RUN, and each `test` block's verdict is compared
// across the four. `term:native-gate` proves a module builds natively; this proves it gives the same answers.
//
//   pnpm term:base-gate                    every test file, every backend
//   BG_ONLY=rust pnpm term:base-gate       one backend beside node (rust | swift | kotlin)
//   BG_MATCH=deque pnpm term:base-gate     only files whose path contains the substring (several, comma-separated)
//
// How: the test preprocessor turns each `test <phrase>` block into a zero-argument boolean task. The gate appends
// ONE generated Term task, `gate-report`, that calls every test under a guard and returns a text of one letter per
// test: P (held), F (did not hold), E (raised). So the driver is written once, in Term, and each backend only has to
// print one call. A file whose test tasks are async gets an async report and an async driver.
//
// THE PROGRAM IS THE ONE `term make --build` SHIPS (decision item 1145): each native leg builds the file through
// compile(), tree-shake on, as `term test --env` builds it, emits it with the program's wake groups and its prelude
// read off the emitted code, and appends the main compile/native-main.ts writes for `gate-report` (Rust's
// `__term_block_on` on a 1 GiB stack thread, Kotlin's `termLoop`, Swift's thread and loop entry). Until then the gate
// milled, bound, checked and simplified by hand with no tree-shake and drove Rust with `#[tokio::main]`, so a form the
// prune drops, a shim waiting on a tokio waker, read ok here and failed in every built program (trap T-1143).
//
// Verdicts per file per backend: `ok` (every letter P), `diff` (the letters differ from node's: a parity bug),
// `fail` (letters agree with node but some are not P: the test itself is red everywhere), `build` (the toolchain
// refused the emitted code), `front` (the compiler refused the file for that backend), `skip` (named reason).

import { execFileSync, execFile, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { parse } from '@term/make/code/parser/tree'
import { resolvePackagePath, stdlibResolver } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { compile } from '@term/make/code/compile/compile'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { entryOf, nativeMain } from '@term/make/code/compile/native-main'
import { expandTemplates } from '@term/make/code/compile/template'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { preprocessTests } from '@term/call/code/test-preprocess'
import { projectLeanOf } from '@term/call/code/role-of'
import { TERM_ROOT } from './root'

type Native = 'rust' | 'swift' | 'kotlin'
type Verdict = 'ok' | 'diff' | 'fail' | 'build' | 'front' | 'skip'

const ROOT = TERM_ROOT
const TERM = TERM_ROOT
const BASE = join(TERM, 'deck/base')
// @term/test's own Term tests, the tests of the self-hosting ports written as `.tree` (note/project/term/self-host/archive/port-log.md)
const TOOLS = join(TERM, 'deck/test')
// @term/make's Term tests, of the compiler modules ported to Term
const MAKE = join(TERM, 'deck/make')
const TEST_DIRS = [join(BASE, 'test'), join(TERM, 'test/tree'), join(TOOLS, 'test'), join(MAKE, 'test')]

// THE RUN IS THE ONE `term test` GIVES A FILE (item 1240). `term test` runs a package's tests with the package root as
// the working folder (report-running.tree spawns its child with `cwd: root`), so a suite names its fixtures from there
// (deck/test/test/corpus.tree reads `test/corpus-fixture`, deck/make/test/kotlin-bare-error.tree `./code`). The gate ran
// every leg from the Term root, and each such read found nothing: corpus.tree failed 3 of 4 on all five legs. Each file
// now runs in the root of the package that owns its test folder, on every leg
const PACKAGE_OF: [string, string][] = [
  [join(BASE, 'test'), BASE],
  [join(TERM, 'test/tree'), TERM],
  [join(TOOLS, 'test'), TOOLS],
  [join(MAKE, 'test'), MAKE],
]

const packageOf = (file: string): string => PACKAGE_OF.find(([dir]) => file.startsWith(`${dir}/`))?.[1] ?? TERM

// and the two variables `term test` hands each child (report-running.tree `spawn-reported`, decision 111): the program
// the runner is and its script, which deck/test/code/self.tree runs to start `term` on a fixture project. Without them
// self.tree raised on its first read, 5 of 5 on every leg. The native legs inherit them from this process
const SELF_ENTRY = join(TERM, 'host/line.js')
process.env.TERM_TEST_SELF ??= process.execPath
process.env.TERM_TEST_SELF_ENTRY ??= SELF_ENTRY

// whether a file is read LEAN, asked of the role.tree of the package it sits in, as `term make` and `term test` ask it:
// @term/test and @term/make read their code and tests lean, the stdlib reads nothing lean. A lean file read as
// longhand mills wrong
const leanOfPackage = new Map([BASE, TOOLS, MAKE].map(root => [root, projectLeanOf(root)]))

const leanOf = (file: string): boolean => {
  for (const [root, lean] of leanOfPackage) {
    if (file.startsWith(`${root}/`)) {
      return lean(file)
    }
  }

  return false
}
const NATIVES: Native[] = ['rust', 'swift', 'kotlin']
// test files whose subject the page has and node does not (the origin-private file system, raw sockets, child
// processes, the host's core count and platform names), so the browser leg cannot run them here. Each is a named skip,
// never a pass. test/machine.tree: @term/base/machine answers node:os facts (count-cores, read-platform,
// read-architecture) for the parallel walk's pool, and a page has no os module, so it has no binding (T048, item 0026).
// deck/test/test/corpus.tree lists a folder's files (@term/base/file/directory has no browser native), and
// deck/test/test/self.tree starts `term` as a child process (item 1240)
const BROWSER_GAP = [
  'test/file/',
  'test/tree/file.tree',
  'tcp.tree',
  'udp.tree',
  'process-run',
  'edge-os.tree',
  'test/find/',
  'test/machine.tree',
  'deck/test/test/corpus.tree',
  'deck/test/test/self.tree',
]
// a file one native target cannot answer, each a named skip there with its reason, never a pass (D025, item 0190)
const NATIVE_FILE_GAP: { env: Native; file: string; reason: string }[] = [
  // @term/base/find reaches its driver through native/node/find/send only; the native hosts come with the OS backends
  // (note/project/term/find, spec section 2)
  ...(['rust', 'swift', 'kotlin'] as Native[]).map(env => ({
    env,
    file: 'deck/base/test/find/find.tree',
    reason: 'find has a node driver host only so far (native/node/find/send), the native hosts are a later item',
  })),
  // one DispatchSource kqueue source on the watched path (note/project/term/stdlib/native-async-file-and-server.md)
  {
    env: 'swift',
    file: 'deck/base/test/file/watch.tree',
    reason: 'watch.swift reports the directory, not the file, and ignores deep (D026)',
  },
]
const REPORT = 'gate-report'

// a test module runs in this process, and one that opens a socket can raise on it long after its test returned (a
// peer resetting a connection). That error belongs to the module, not to the gate, so it is reported and the run
// goes on, rather than ending with every verdict unprinted
process.on('uncaughtException', error => console.log(`note   a test module raised outside its test: ${String(error).slice(0, 160)}`))
process.on('unhandledRejection', error => console.log(`note   a test module rejected outside its test: ${String(error).slice(0, 160)}`))

// NO RUN ENDS WITHOUT A VERDICT (trap T-1161). `doing` names what runs now, `reported` is set once the tally is out.
// A test whose await nothing will ever answer (a read after its input closed) leaves no timer or handle: the loop
// drained, node quit with exit 0, and the gate printed neither the file's verdict nor the tally, so a hung test read as
// a pass. Each end before the report is now a named failure with a code that is never 0.
let doing = 'starting'
let reported = false
let told = false
const endBeforeReport = (why: string): void => {
  if (!told) {
    told = true
    console.log(`fail   gate    ${doing}  ${why}, before any verdict or tally`)
  }
}
// the loop drained with the run unfinished: nothing is left that could answer the await the run is on
process.on('beforeExit', () => {
  if (!reported) {
    endBeforeReport('the run stopped with nothing left to wait on (an await that never settles)')
    process.exit(2)
  }
})
// any other end: a test module or a shim that called process.exit (with 0 or any code), or an exit nobody named.
// The code the exit asked for is replaced, since node takes process.exitCode as set here
process.on('exit', code => {
  if (!reported) {
    endBeforeReport(`the process exited (code ${code})`)
    process.exitCode = 2
  }
})
// a stop asked from outside (a timeout's kill, ^C): named, and the conventional 128 + signal code
for (const [signal, number] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]] as const) {
  process.on(signal, () => {
    endBeforeReport(`the gate was stopped by ${signal}`)
    reported = true
    process.exit(128 + number)
  })
}
// how long one file's run may take, on every leg (a node test in this process, a native program): BG_RUN_SECONDS, 60
const RUN_MS = Number(process.env.BG_RUN_SECONDS ?? 60) * 1000

const only = process.env.BG_ONLY ?? ''
const match = process.env.BG_MATCH ?? ''
const jobs = Math.max(1, Math.min(cpus().length - 1, 8))
const work = mkdtempSync(join(tmpdir(), 'term-base-gate-'))
// BG_KEEP=1 prints where the emitted sources are, to read a build failure whole
if (process.env.BG_KEEP) {
  console.log(`note   sources kept in ${work}`)
}

// ---------------------------------------------------------------- sources

// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts), the
// repository's other `@term/<name>` packages by the same rule, and a relative path beside its importer
const stdlibOf = stdlibResolver()

const resolver = (path: string, from?: string): Source | undefined => {
  if (path.startsWith('@term/base')) {
    return stdlibOf?.(path, from ?? '')
  }

  // another package of this repository, `deck/<name>`, by the same package path rule. A load the gate could not
  // reach loaded nothing in silence, and the file failed at its first `make` of a form from that package
  // (`make big names no form`) rather than at the load (2026-10-04)
  const pack = /^@term\/([^/]+)(?:\/(.*))?$/.exec(path)

  if (pack) {
    const dir = join(TERM, 'deck', pack[1]!)
    const file = existsSync(dir) ? resolvePackagePath({ dir, rest: pack[2] ?? '' }).file : undefined

    return file ? { file, text: readFileSync(file, 'utf8') } : undefined
  }

  if (!path.startsWith('.') || !from) {
    return undefined
  }

  const base = resolvePath(dirname(from), path)

  for (const file of [`${base}.tree`, join(base, 'base.tree')]) {
    if (existsSync(file)) {
      return { file, text: readFileSync(file, 'utf8') }
    }
  }

  return undefined
}

const readRuntime = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined

function walk(dir: string, into: string[] = []): string[] {
  if (!existsSync(dir)) {
    return into
  }

  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    // the folders `term test` never enters (walk-folder in deck/call/code/work/testing/test-command.tree): `.base` and
    // `node_modules` whole, and a folder with its own deck.tree, a fixture project a suite runs or reads, not tests of
    // this package (decisions 104 and 107). The gate walked into them: self-fixture/test/probe.tree ran as a suite of
    // its own and failed (its tests read what self.tree's child is started with), and a dangling pnpm link under
    // self-fixture/.base crashed the walk (T-1075, item 1241)
    if (name === '.base' || name === 'node_modules') {
      continue
    }

    if (statSync(path).isDirectory()) {
      if (!existsSync(join(path, 'draft.tree')) && !existsSync(join(path, 'deck.tree'))) {
        walk(path, into)
      }
    } else if (name.endsWith('.tree')) {
      into.push(path)
    }
  }

  return into
}

// ---------------------------------------------------------------- the generated report task

type Prepared = { text: string; names: string[]; labels: string[]; isAsync: boolean }

// the test tasks of the entry file, in source order, and whether any of them is async
function prepare(file: string): Prepared | { skip: string } {
  const source = readFileSync(file, 'utf8')

  if (/^(mark|note) draft\s*$/m.test(source)) {
    return { skip: 'shelved' }
  }

  const { text, labels } = preprocessTests(source)
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return { skip: `parse: ${parsed.diagnostics[0]?.message ?? ''}` }
  }

  const built = mill(expandTemplates(parsed.tree), file, undefined, leanOf(file))

  if (!built.ok) {
    return { skip: `mill: ${built.diagnostics[0]?.message ?? ''}` }
  }

  const tests = built.program.filter(
    node =>
      node.form === 'function' &&
      node.params.length === 0 &&
      node.result?.kind === 'boolean',
  ) as { name: string; async?: boolean }[]

  if (tests.length === 0) {
    return { skip: 'no runnable tests (proofs only)' }
  }

  const isAsync = tests.some(t => t.async)
  const lines = [`task ${REPORT}`, '  like text']

  if (isAsync) {
    lines.push('  note async')
  }

  lines.push('  save out, text <>')

  for (const t of tests) {
    lines.push(
      '  fork',
      '    mark unsafe',
      '    fork test',
      '      hook test',
      `        call ${t.name}`,
      ...(t.async ? ['          wait true'] : []),
      '      hook hold',
      '        save out, text <{{out}}P>',
      '      hook miss',
      '        save out, text <{{out}}F>',
      '  halt take',
      '    take problem',
      '    save out, text <{{out}}E>',
    )
  }

  lines.push('  send back, read out')

  return {
    text: `${text}\n\n${lines.join('\n')}\n`,
    names: tests.map(t => t.name),
    labels: tests.map(t => labels.get(t.name) ?? t.name),
    isAsync,
  }
}

// ---------------------------------------------------------------- node

// the JavaScript legs: `node` with node's natives, and `browser` with the page's natives run under node's web globals
// (performance, atob, TextEncoder, crypto.subtle, fetch). A capability the page has and node lacks (OPFS) is a
// named skip, not a pass.
async function runNode(file: string, prep: Prepared, env: 'node' | 'browser' = 'node'): Promise<string | { fail: string }> {
  const result = compile({ file, text: prep.text }, { resolve: withNativeEnv(env, resolver), env, leanOf })

  if (!result.ok) {
    return { fail: `front: ${result.diagnostics[0]?.message ?? ''}` }
  }

  const prelude = nativePrelude(result.program, env, readRuntime)
  const js = transformSync(`${prelude}\n${result.typescript}`, { loader: 'ts', format: 'esm' }).code
  const out = join(work, `node-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(out, js)

  // a test that waits on something that never comes (a socket nobody answers, a read after its input closed) must not
  // hold the gate: each file gets RUN_MS, and a file that overruns is a named failure rather than waited on. The timer
  // is NOT unref'd: an unref'd one let the loop drain under an await nothing answers, and node quit with exit 0 and no
  // verdict (T-1161). The module's own top-level work races it too, since a load that never settles hangs the same way
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ fail: string }>(done => {
    timer = setTimeout(() => done({ fail: `run: no answer within ${RUN_MS / 1000}s (an await that never settles)` }), RUN_MS)
  })

  // in the package root, as `term test` runs it (PACKAGE_OF). The legs run one file at a time, so the folder is this
  // file's for the whole run, and the gate's own folder comes back after it
  const home = process.cwd()
  process.chdir(packageOf(file))

  try {
    const report = import(pathToFileURL(out).href).then(mod => (mod as Record<string, () => unknown>).gateReport!())

    return await Promise.race([report.then(String), timeout])
  } catch (error) {
    return { fail: `run: ${String(error).slice(0, 160)}` }
  } finally {
    clearTimeout(timer)
    process.chdir(home)
  }
}

// a native program's end that is not a clean exit, named: the run timed out and was killed, was killed by a signal,
// could not start, or exited non-zero. spawnSync gives status null for the first two, which once read "exit null"
function runFail(ran: ReturnType<typeof spawnSync>): string {
  const stderr = firstError(String(ran.stderr ?? ''), /./)
  const error = ran.error as NodeJS.ErrnoException | undefined

  if (error?.code === 'ETIMEDOUT') {
    return `run: no answer within ${RUN_MS / 1000}s, killed (${ran.signal ?? 'SIGTERM'}) ${stderr}`
  }

  if (ran.signal) {
    return `run: killed by ${ran.signal} ${stderr}`
  }

  if (error) {
    return `run: could not start: ${String(error).slice(0, 160)}`
  }

  return `run: exit ${ran.status} ${stderr}`
}

// ---------------------------------------------------------------- native front end

// a global a module docks that has a node runtime shim (`runtime/<name>.ts` beside the module) and none for this backend:
// its tests cannot run there, and are a named skip, not a build failure. The SMT binding is the first (smt-text, the
// solver reached through z3-solver on node, 2026-10-05). A name with no shim at all (`console`) is the host's own
const SHIM_EXTENSION: Record<Native, string> = { rust: 'rs', swift: 'swift', kotlin: 'kt' }

function missingShim(sources: Source[], env: Native): string | undefined {
  for (const unit of sources) {
    for (const docked of unit.text.matchAll(/<global:([a-z0-9-]+)>/g)) {
      const name = docked[1]!
      const dir = join(dirname(unit.file), 'runtime')

      if (existsSync(join(dir, `${name}.ts`)) && !existsSync(join(dir, `${name}.${SHIM_EXTENSION[env]}`))) {
        return name
      }
    }
  }

  return undefined
}

// a module of the closure that docks a compiler file by its TypeScript source path (`dock load` / `load
// <@term/make/code/compile/compile>`): deck/test's compiler-fuzzing, compiler-type-shape, cross-emission and
// diagnostic-gap test the TypeScript compiler as a node module. No emitted program imports a compiler file (decision
// 135), so a native or page build has nothing to bind: the native emitters wrote the specifier as an import (rust
// `use @term`, swift `import @term`, kotlin `import @term`) and the toolchain refused it. A named skip, never a pass,
// until the compiler is a Term library the program loads (item 1242)
function compilerDock(sources: Source[]): string | undefined {
  for (const unit of sources) {
    const docked = /^\s*load <(@term\/make\/[^>]+)>/m.exec(unit.text)

    if (docked) {
      return `${relative(TERM, unit.file)} docks the TypeScript compiler file ${docked[1]}, which only node runs (decision 135)`
    }
  }

  return undefined
}

// the program, its prelude and its main, as `term test --env` and `term make --build` build one
// (deck/call/code/work/testing/native-testing.tree `run-native-test-file`, deck/call/code/native-build.ts)
function front(file: string, text: string, env: Native): { source: string; main: string } | { fail: string } | { skip: string } {
  try {
    const resolve = withNativeEnv(env, resolver)
    // the closure's sources, read only for the shim check below: compile() walks the closure itself
    const { sources } = collectModules({ file, text }, resolve)
    const unshimmed = missingShim(sources, env)

    if (unshimmed) {
      return { skip: `the ${unshimmed} binding has a node runtime and no ${env} one` }
    }

    const compiler = compilerDock(sources)

    if (compiler) {
      return { skip: compiler }
    }

    // the build of record: compile() with tree-shake on, as every built program is (decision item 1145). BG_NO_SIMPLIFY=1
    // emits the program unsimplified, to tell a simplifier defect from an emitter one
    const result = compile(
      { file, text },
      { resolve, env, leanOf, treeShake: true, ...(process.env.BG_NO_SIMPLIFY ? { optimize: false } : {}) },
    )

    if (!result.ok) {
      const first = result.diagnostics.find(d => d.severity !== 'warning') ?? result.diagnostics[0]
      const where = first?.span?.file ?? first?.file
      const at = first && where ? ` (${relative(TERM, where)}:${first.span.start.line + 1})` : ''

      return { fail: `compile: ${first?.message ?? ''}${at}` }
    }

    const options = { wake: result.wake }
    const emitted =
      env === 'rust'
        ? emitRust(result.program, options)
        : env === 'swift'
          ? emitSwift(result.program, options)
          : emitKotlin(result.program, options)
    // the shims the emitted code names, as term test reads them
    const prelude = nativePrelude(result.program, env, readRuntime, emitted)
    const source = `${prelude}\n${emitted}`
    const entry = entryOf(env, source, REPORT)

    if (!entry) {
      return { fail: `emit: no ${REPORT} taking nothing in the emitted source` }
    }

    return { source, main: nativeMain(env, source, entry) }
  } catch (error) {
    return { fail: `front: ${String(error).slice(0, 200)}` }
  }
}

// ---------------------------------------------------------------- toolchains

// `main` is compile/native-main.ts's main for `gate-report`, the one `term make --build` appends
// `cwd` is the package root the program runs in, as the node leg runs (PACKAGE_OF)
type Job = { key: string; source: string; main: string; cwd: string }
type Outcome = { key: string; out?: string; fail?: string }

const firstError = (text: string, pattern: RegExp): string =>
  (text.split('\n').find(l => pattern.test(l)) ?? text.split('\n')[0] ?? 'build failed').slice(0, 200)

const NATIVE_SCRIPT: Record<string, string> = {
  swift: join(ROOT, 'deck/base/code/native/toolchain/swift.sh'),
  kotlin: join(ROOT, 'deck/base/code/native/toolchain/kotlin.sh'),
}

function nativeFlags(env: Native): string[] {
  const script = NATIVE_SCRIPT[env]

  if (!script) {
    return []
  }

  try {
    const out = execFileSync('bash', [script, 'flags'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    return env === 'kotlin' ? ['-classpath', out.trim()] : out.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const have = (tool: string): boolean => {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        await run(items[next++]!)
      }
    }),
  )
}

const CARGO_TOML = readFileSync(join(ROOT, 'task/term/native-gate.ts'), 'utf8')
  .match(/const CARGO_TOML = `([\s\S]*?)`/)![1]!
  .replace('term-native-gate', 'term-base-gate')

async function runRust(batch: Job[]): Promise<Outcome[]> {
  const proj = join(work, 'rust')
  mkdirSync(join(proj, 'src', 'bin'), { recursive: true })
  writeFileSync(join(proj, 'Cargo.toml'), CARGO_TOML)
  writeFileSync(join(proj, 'src', 'main.rs'), 'fn main() {}\n')

  const bins = new Map<string, Job>()

  for (const job of batch) {
    const bin = `g_${job.key.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`
    bins.set(bin, job)
    // the program's own main: an async entry on `__term_block_on`, never a tokio runtime, on a 1 GiB stack thread
    writeFileSync(
      join(proj, 'src', 'bin', `${bin}.rs`),
      `#![allow(warnings)]\n${job.source}\n${job.main}\n`,
    )
  }

  const env = { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), 'seed-rust-runtime', 'target') }
  const failed = new Map<string, string>()

  try {
    execFileSync('cargo', ['build', '--bins', '--quiet'], { cwd: proj, stdio: 'pipe', env, maxBuffer: 64 * 1024 * 1024 })
  } catch {
    // one at a time, so each failure is its own
    await pool([...bins.keys()], jobs, async bin => {
      await new Promise<void>(done => {
        execFile('cargo', ['build', '--bin', bin, '--quiet'], { cwd: proj, env, maxBuffer: 64 * 1024 * 1024 }, (error, _o, stderr) => {
          if (error) {
            failed.set(bin, firstError(String(stderr), /^error/))
          }

          done()
        })
      })
    })
  }

  const outcomes: Outcome[] = []

  for (const [bin, job] of bins) {
    if (failed.has(bin)) {
      outcomes.push({ key: job.key, fail: `build: ${failed.get(bin)}` })
      continue
    }

    const ran = spawnSync(join(env.CARGO_TARGET_DIR, 'debug', bin), [], { encoding: 'utf8', timeout: RUN_MS, cwd: job.cwd })
    outcomes.push(
      ran.status === 0
        ? { key: job.key, out: lastLine(ran.stdout) }
        : { key: job.key, fail: runFail(ran) },
    )
  }

  return outcomes
}

async function runSwift(batch: Job[]): Promise<Outcome[]> {
  const dir = join(work, 'swift')
  mkdirSync(dir, { recursive: true })
  const flags = nativeFlags('swift')
  const outcomes: Outcome[] = []

  await pool(batch, jobs, async job => {
    const base = job.key.replace(/[^a-z0-9]+/gi, '_')
    const file = join(dir, `${base}.swift`)
    const exe = join(dir, base)
    // as deck/call/code/native-build.ts writes a Swift program: Foundation, the source, the program's own main
    writeFileSync(file, `import Foundation\n${job.source}\n${job.main}\n`)

    await new Promise<void>(done => {
      execFile('swiftc', [...flags, '-o', exe, file], { maxBuffer: 64 * 1024 * 1024 }, (error, _o, stderr) => {
        if (error) {
          outcomes.push({ key: job.key, fail: `build: ${firstError(String(stderr), /error:/)}` })
        } else {
          const ran = spawnSync(exe, [], { encoding: 'utf8', timeout: RUN_MS, cwd: job.cwd })
          outcomes.push(
            ran.status === 0
              ? { key: job.key, out: lastLine(ran.stdout) }
              : { key: job.key, fail: runFail(ran) },
          )
        }

        done()
      })
    })
  })

  return outcomes
}

async function runKotlin(batch: Job[]): Promise<Outcome[]> {
  const dir = join(work, 'kotlin')
  mkdirSync(dir, { recursive: true })
  const flags = nativeFlags('kotlin')
  const files = new Map<string, Job>()
  const facade = new Map<string, string>()

  batch.forEach((job, index) => {
    const file = join(dir, `m${index}.kt`)
    files.set(file, job)
    facade.set(file, `p${index}.M${index}Kt`)
    // the program's own main (an async entry on `termLoop`, on a 1 GiB stack thread). Imports hoisted first and the
    // package line put above them: Kotlin wants `package` before any `import`
    writeFileSync(file, `package p${index}\n\n${hoistKotlinImports(`${job.source}\n${job.main}\n`)}`)
  })

  const failed = new Map<string, string>()
  // the files compiled in groups, each into its own jar. One `kotlinc` over every test file outgrew the compiler's
  // default heap as the stdlib grew, and then every file failed with an OutOfMemoryError that said nothing about any
  // of them (2026-10-04, 78 of 78); a group of KOTLIN_GROUP keeps the heap bounded and the builds still batched
  const group = Number(process.env.KOTLIN_GROUP ?? 16)
  const all = [...files.keys()]
  const jarOf = new Map<string, string>()

  for (let start = 0; start < all.length; start += group) {
    let alive = all.slice(start, start + group)
    const jar = join(dir, `gate-${start / group}.jar`)
    alive.forEach(file => jarOf.set(file, jar))

    for (let round = 0; alive.length > 0 && round < 16; round++) {
      try {
        execFileSync('kotlinc', [...alive, ...flags, '-include-runtime', '-d', jar], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
        break
      } catch (error) {
        const stderr = String((error as { stderr?: Buffer }).stderr ?? error)
        const bad = new Set<string>()

        for (const line of stderr.split('\n')) {
          const m = /^(.*\.kt):\d+:\d+: error: (.*)$/.exec(line)

          if (m && files.has(m[1]!) && !failed.has(m[1]!)) {
            bad.add(m[1]!)
            failed.set(m[1]!, m[2]!.slice(0, 200))
          }
        }

        if (bad.size === 0) {
          for (const file of alive) {
            failed.set(file, firstError(stderr, /error/))
          }

          alive = []
          break
        }

        alive = alive.filter(f => !bad.has(f))
      }
    }
  }

  const outcomes: Outcome[] = []

  for (const [file, job] of files) {
    if (failed.has(file)) {
      outcomes.push({ key: job.key, fail: `build: ${failed.get(file)}` })
      continue
    }

    const classpath = [jarOf.get(file)!, ...(flags[1] ? [flags[1]] : [])].join(':')
    // native access, as deck/call's native-build.ts grants it: the process runner spawns through java.lang.foreign
    const ran = spawnSync('java', ['--enable-native-access=ALL-UNNAMED', '-cp', classpath, facade.get(file)!], {
      encoding: 'utf8',
      timeout: RUN_MS,
      cwd: job.cwd,
    })
    outcomes.push(
      ran.status === 0
        ? { key: job.key, out: lastLine(ran.stdout) }
        : { key: job.key, fail: runFail(ran) },
    )
  }

  return outcomes
}

// ---------------------------------------------------------------- main

// the letters are the last line: a test may log to stdout before the report prints
function lastLine(stdout: string): string {
  return stdout.trim().split('\n').pop() ?? ''
}

function verdictOf(letters: string, node: string): Verdict {
  if (letters !== node) {
    return 'diff'
  }

  return /^P+$/.test(letters) ? 'ok' : 'fail'
}

// name the tests a backend disagrees on, or that fail, by their labels
function explain(prep: Prepared, letters: string, node: string): string {
  const names: string[] = []

  for (let i = 0; i < prep.labels.length; i++) {
    const got = letters[i] ?? '?'
    const want = node[i] ?? '?'

    if (got !== 'P' || got !== want) {
      names.push(`${got}${got === want ? '' : `/node ${want}`} ${prep.labels[i]}`)
    }
  }

  return names.slice(0, 4).join(' | ')
}

async function main(): Promise<void> {
  // BG_MATCH may name several substrings, comma-separated, so two chosen files can run in one process: a defect that
  // shows only when one file is built after another (state left behind) is found by pairing them
  const matches = match.split(',').filter(Boolean)
  const files = TEST_DIRS.flatMap(dir => walk(dir)).filter(f => !matches.length || matches.some(m => relative(TERM, f).includes(m)))
  const backends = NATIVES.filter(env => !only || only === env)
  const tools: Record<Native, boolean> = {
    rust: have('cargo'),
    swift: have('swiftc'),
    kotlin: have('kotlinc') && have('java'),
  }

  type Row = { file: string; prep?: Prepared; node?: string; skip?: string; nodeFail?: string }
  const rows: Row[] = []

  for (const file of files) {
    const prep = prepare(file)

    if ('skip' in prep) {
      rows.push({ file, skip: prep.skip })
      continue
    }

    doing = `node    ${relative(TERM, file)}`
    const node = await runNode(file, prep)
    rows.push(typeof node === 'string' ? { file, prep, node } : { file, prep, nodeFail: node.fail })
    console.log(`.      node    ${relative(TERM, file)}  ${typeof node === 'string' ? node : node.fail}`)
  }

  const tally: Record<string, Record<Verdict, number>> = {}
  const lines: string[] = []
  const bump = (env: string, v: Verdict): void => {
    tally[env] ??= { ok: 0, diff: 0, fail: 0, build: 0, front: 0, skip: 0 }
    tally[env]![v]++
  }

  for (const row of rows) {
    const rel = relative(TERM, row.file)

    if (row.skip) {
      bump('node', 'skip')
      lines.push(`skip   node    ${rel}  ${row.skip}`)
      continue
    }

    if (row.nodeFail) {
      bump('node', 'front')
      lines.push(`front  node    ${rel}  ${row.nodeFail}`)
      continue
    }

    const v: Verdict = /^P+$/.test(row.node!) ? 'ok' : 'fail'
    bump('node', v)

    if (v !== 'ok') {
      lines.push(`fail   node    ${rel}  ${explain(row.prep!, row.node!, row.node!)}`)
    }
  }

  // the browser leg, run here under node's web globals
  if (!only || only === 'browser') {
    for (const row of rows) {
      if (!row.prep || row.nodeFail) {
        continue
      }

      const rel = relative(TERM, row.file)

      if (BROWSER_GAP.some(gap => rel.includes(gap))) {
        bump('browser', 'skip')
        lines.push(`skip   browser ${rel}  needs a page capability node does not have`)
        continue
      }

      // a compiler file docked by its source path: its binds have a node case only (cross-emission's
      // `cross-no-resolve` read SEED_UNSUPPORTED_BIND_cross_no_resolve on the page), as on the natives
      // (a closure the reader refuses is runNode's to name, as before)
      let compiler: string | undefined

      try {
        compiler = compilerDock(collectModules({ file: row.file, text: row.prep.text }, withNativeEnv('browser', resolver)).sources)
      } catch {
        compiler = undefined
      }

      if (compiler) {
        bump('browser', 'skip')
        lines.push(`skip   browser ${rel}  ${compiler}`)
        continue
      }

      doing = `browser ${rel}`
      const got = await runNode(row.file, row.prep, 'browser')

      if (typeof got !== 'string') {
        bump('browser', 'front')
        lines.push(`front  browser ${rel}  ${got.fail}`)
        continue
      }

      const v = verdictOf(got, row.node!)
      bump('browser', v)

      if (v !== 'ok') {
        lines.push(`${v.padEnd(5)}  browser ${rel}  ${explain(row.prep, got, row.node!)}`)
      }
    }
  }

  for (const env of backends) {
    doing = `${env.padEnd(6)}  the ${env} legs`

    if (!tools[env]) {
      lines.push(`skip   ${env}  toolchain not installed`)
      continue
    }

    const batch: Job[] = []

    for (const row of rows) {
      if (!row.prep || row.nodeFail) {
        continue
      }

      const rel = relative(TERM, row.file)
      const gap = NATIVE_FILE_GAP.find(entry => entry.env === env && rel === entry.file)

      if (gap) {
        bump(env, 'skip')
        lines.push(`skip   ${env.padEnd(6)}  ${rel}  ${gap.reason}`)
        continue
      }

      const built = front(row.file, row.prep.text, env)

      if ('skip' in built) {
        bump(env, 'skip')
        lines.push(`skip   ${env.padEnd(6)}  ${rel}  ${built.skip}`)
        continue
      }

      if ('fail' in built) {
        bump(env, 'front')
        lines.push(`front  ${env.padEnd(6)}  ${rel}  ${built.fail}`)
        continue
      }

      batch.push({ key: rel, source: built.source, main: built.main, cwd: packageOf(row.file) })
    }

    const outcomes = env === 'rust' ? await runRust(batch) : env === 'swift' ? await runSwift(batch) : await runKotlin(batch)

    for (const outcome of outcomes.sort((a, b) => a.key.localeCompare(b.key))) {
      const row = rows.find(r => relative(TERM, r.file) === outcome.key)!

      if (outcome.fail) {
        bump(env, 'build')
        lines.push(`build  ${env.padEnd(6)}  ${outcome.key}  ${outcome.fail}`)
        continue
      }

      const v = verdictOf(outcome.out!, row.node!)
      bump(env, v)

      if (v !== 'ok') {
        lines.push(`${v.padEnd(5)}  ${env.padEnd(6)}  ${outcome.key}  ${explain(row.prep!, outcome.out!, row.node!)}`)
      }
    }
  }

  for (const line of lines) {
    console.log(line)
  }

  const summary = Object.entries(tally)
    .map(([env, t]) => `${env}: ${t.ok} ok, ${t.diff} diff, ${t.fail} fail, ${t.build} build, ${t.front} front, ${t.skip} skip`)
    .join(' | ')
  console.log(`\nbase-gate (${rows.length} files): ${summary}`)

  // a file with no verdict on a leg it ran is red: every row gives node a verdict above, and every native job one
  // outcome, so a row missing from the tally means the gate lost it
  const counted = Object.values(tally.node ?? {}).reduce((sum, n) => sum + n, 0)
  // and a run of no file proved nothing (a BG_MATCH that names no file): red, never a pass by silence
  const lost = counted !== rows.length || rows.length === 0

  if (rows.length === 0) {
    console.log(`fail   gate    no test file matched${match ? ` BG_MATCH=${match}` : ''}`)
  } else if (lost) {
    console.log(`fail   gate    node verdicts ${counted} for ${rows.length} files`)
  }

  const red = lost || Object.values(tally).some(t => t.diff + t.fail + t.build + t.front > 0)
  reported = true

  // exit outright: a test module that opened a server or a timer would otherwise keep the process alive. The exit waits
  // for standard output to take the tally, so a pipe never loses it
  process.stdout.write('', () => process.exit(red ? 1 : 0))
}

// the gate's own failure is never a pass: without this, an error in the gate (a compiler module that threw while
// emitting) reached the stray-error handler above, was printed as a test module's, and the run ended at 0
main().catch(error => {
  console.log(`gate   crashed: ${String(error).slice(0, 400)}`)
  console.log(`fail   gate    ${doing}  crashed, before any verdict or tally`)
  told = true
  reported = true
  process.exit(2)
})
