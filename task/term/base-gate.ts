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
import { bindModules, stampModule } from '@term/make/code/check/bind-modules'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates, collectTemplates } from '@term/make/code/compile/template'
import type { Template } from '@term/make/code/compile/template'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import type { Program } from '@term/make/code/compile/node'
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
// read-architecture) for the parallel walk's pool, and a page has no os module, so it has no binding (T048, item 0026)
const BROWSER_GAP = ['test/file/', 'test/tree/file.tree', 'tcp.tree', 'udp.tree', 'process-run', 'edge-os.tree', 'test/find/', 'test/machine.tree']
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

    if (statSync(path).isDirectory()) {
      if (!existsSync(join(path, 'draft.tree'))) {
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

  try {
    const report = import(pathToFileURL(out).href).then(mod => (mod as Record<string, () => unknown>).gateReport!())

    return await Promise.race([report.then(String), timeout])
  } catch (error) {
    return { fail: `run: ${String(error).slice(0, 160)}` }
  } finally {
    clearTimeout(timer)
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

function front(file: string, text: string, env: Native): { source: string; call: string } | { fail: string } | { skip: string } {
  try {
    // what each module imports, so a name two modules define binds per file as `compile` binds it
    const { sources, scope } = collectModules({ file, text }, withNativeEnv(env, resolver))
    const unshimmed = missingShim(sources, env)

    if (unshimmed) {
      return { skip: `the ${unshimmed} binding has a node runtime and no ${env} one` }
    }
    const program: Program = []
    const trees: { file: string; tree: Extract<ReturnType<typeof parse>, { ok: true }> }[] = []

    for (const unit of sources) {
      const parsed = parse(unit)

      if (!parsed.ok) {
        return { fail: `parse ${relative(TERM, unit.file)}: ${parsed.diagnostics[0]?.message ?? ''}` }
      }

      trees.push({ file: unit.file, tree: parsed })
    }

    // every module's templates first, as `compile` collects them, so a `fuse` expands a template another file defines
    // (`integer/32` instantiates the one in `integer/n`)
    const templates = new Map<string, Template>()

    for (const { tree } of trees) {
      for (const [name, template] of collectTemplates(tree.tree)) {
        templates.set(name, template)
      }
    }

    for (const { file: unitFile, tree: parsed } of trees) {
      const unit = { file: unitFile }
      const built = mill(expandTemplates(parsed.tree, templates), unit.file, undefined, leanOf(unit.file))

      if (!built.ok) {
        return { fail: `mill ${relative(TERM, unit.file)}: ${built.diagnostics[0]?.message ?? ''}` }
      }

      stampModule(built.program, unit.file)
      program.push(...built.program)
    }

    // module scope, as `compileProgram` binds it (check/bind-modules.ts)
    const unbound = bindModules(program, scope, file)

    if (unbound.length) {
      return { fail: `scope: ${unbound[0]?.message ?? ''}` }
    }

    const unresolved = resolveNames(program, file).filter(d => d.severity !== 'warning')

    if (unresolved.length) {
      return { fail: `resolve: ${unresolved[0]?.message ?? ''}` }
    }

    const errors = check(program, file).filter(d => d.severity !== 'warning')

    if (errors.length) {
      const first = errors[0]
      const at = first ? ` (${relative(TERM, first.span.file ?? first.file)}:${first.span.start.line + 1})` : ''

      return { fail: `check: ${first?.message ?? ''}${at}` }
    }

    resolveAsync(program)

    // BG_NO_SIMPLIFY=1 emits the program as checked, to tell a simplifier defect from an emitter one
    const simple = process.env.BG_NO_SIMPLIFY ? program : simplify(program, new Set([REPORT]))
    const emitted = env === 'rust' ? emitRust(simple) : env === 'swift' ? emitSwift(simple) : emitKotlin(simple)
    const prelude = nativePrelude(simple, env, readRuntime)
    const call = env === 'rust' ? 'gate_report' : 'gateReport'

    if (!new RegExp(`\\b${call}\\b`).test(emitted)) {
      return { fail: `emit: no ${call} in the emitted source` }
    }

    return { source: `${prelude}\n${emitted}`, call }
  } catch (error) {
    return { fail: `front: ${String(error).slice(0, 200)}` }
  }
}

// ---------------------------------------------------------------- toolchains

type Job = { key: string; source: string; call: string; isAsync: boolean }
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
    const value = job.isAsync ? `${job.call}().await` : `${job.call}()`
    const raising = new RegExp(`fn ${job.call}\\(\\)[^{]*-> std::result::Result`).test(job.source)
    const shown = raising ? `${value}.unwrap_or_else(|e| e.to_string())` : value
    const main = job.isAsync
      ? `#[tokio::main]\nasync fn main() { print!("{}", ${shown}); }\n`
      : `fn main() { print!("{}", ${shown}); }\n`
    writeFileSync(
      join(proj, 'src', 'bin', `${bin}.rs`),
      `#![allow(warnings)]\n${job.source}\n${main}`,
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

    const ran = spawnSync(join(env.CARGO_TARGET_DIR, 'debug', bin), [], { encoding: 'utf8', timeout: RUN_MS })
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
    const raising = /func gateReport\(\)[^{]*throws/.test(job.source)
    const value = `${raising ? 'try ' : ''}${job.isAsync ? 'await ' : ''}gateReport()`
    const driver = raising
      ? `do { print(${value}, terminator: "") } catch { print("\\(error)", terminator: "") }\n`
      : `print(${value}, terminator: "")\n`
    writeFileSync(file, `${job.source}\n${driver}`)

    await new Promise<void>(done => {
      execFile('swiftc', [...flags, '-o', exe, file], { maxBuffer: 64 * 1024 * 1024 }, (error, _o, stderr) => {
        if (error) {
          outcomes.push({ key: job.key, fail: `build: ${firstError(String(stderr), /error:/)}` })
        } else {
          const ran = spawnSync(exe, [], { encoding: 'utf8', timeout: RUN_MS })
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
    // a program that waits (`termSleep`) posts its wake-ups to `termLoop`, which only `termLoop.block` drains:
    // `runBlocking` never runs them, so a test that sleeps hung to the 60 s timeout (exit 143)
    const driver = job.isAsync
      ? job.source.includes('object termLoop')
        ? `fun main() { print(termLoop.block { gateReport() }) }\n`
        : `fun main() { print(kotlinx.coroutines.runBlocking { gateReport() }) }\n`
      : `fun main() { print(gateReport()) }\n`
    // imports hoisted first and the package line put above them: Kotlin wants `package` before any `import`
    writeFileSync(file, `package p${index}\n\n${hoistKotlinImports(`${job.source}\n${driver}`)}`)
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

      batch.push({ key: rel, source: built.source, call: built.call, isAsync: row.prep.isAsync })
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
