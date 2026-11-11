// The per-module native gate (stdlib-parity-0001): every non-shelved stdlib module, compiled with its closure for
// Rust, Swift and Kotlin, and built on the real toolchain. One line per module per backend; skips are named. The
// recorded counts are the parity baseline, and stdlib-parity-0007 drives the failures to zero.
//
//   pnpm term:native-gate                 all three backends
//   NG_ONLY=rust pnpm term:native-gate    one backend (rust | swift | kotlin)
//   NG_MATCH=color pnpm term:native-gate  only modules whose path contains the substring
//   pnpm term:native-gate --front         the front end only, no toolchain (seconds, not minutes)
//
// Stages per module: front (parse -> mill -> check -> simplify, in that backend's native env) and build (the
// toolchain). Rust builds as one cargo package with a bin per module (`cargo check --bins`, no codegen), Swift
// typechecks each file (`swiftc -typecheck`, pooled), Kotlin compiles in one batch (`kotlinc -d`, one JVM boot,
// a `package pN` per module) with failing files dropped and retried so one bad module cannot hide the rest.
// A module's `test` blocks are exercised on the node gate (`term test`), not here; that run is a named skip.
//
// This gate is minutes long on a cold toolchain cache and is NOT part of `pnpm term:test`.

import { execFileSync, execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import { join, relative, resolve as resolvePath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@term/make/code/parser/tree'
import { stdlibResolver } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { bindModules, stampModule } from '@term/make/code/check/bind-modules'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules, makeParseMemo, platformRefusals } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import type { Program, Statement } from '@term/make/code/compile/node'
import { DECIDED } from './native-decided'
import { TERM_ROOT } from './root'

type Env = 'rust' | 'swift' | 'kotlin'

const ROOT = TERM_ROOT
const TERM = TERM_ROOT
const SEED = join(TERM, 'deck/base')

const ENVS: Env[] = ['rust', 'swift', 'kotlin']
// `webview` is a cask PAGE's env (each task one command over the bridge, call/code/cask-generate.ts PAGE_ENVS), a
// JavaScript host like `browser`, never a native backend's
const OTHER_NATIVE: Record<Env, string[]> = {
  rust: ['node', 'browser', 'cloudflare', 'javascript', 'webview', 'kotlin', 'swift'],
  swift: ['node', 'browser', 'cloudflare', 'javascript', 'webview', 'kotlin', 'rust'],
  kotlin: ['node', 'browser', 'cloudflare', 'javascript', 'webview', 'rust', 'swift'],
}

// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
// and a relative path beside its importer
const stdlibOf = stdlibResolver()

const resolver = (path: string, from?: string): Source | undefined => {
  if (path.startsWith('@term/base')) {
    return stdlibOf?.(path, from ?? '')
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

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (name.endsWith('.tree')) {
      into.push(path)
    }
  }

  return into
}

// the modules whose closure needs the big-integer binds and has no swift case for them. EMPTY since 2026-10-05: the
// binds' swift case is native/swift/runtime/termbig.swift, a bignum over 32-bit limbs, and the four modules this held
// (decimal, float/128, float/big, integer/128) were skipped here for a gap that had already closed. The skip stays so
// a module that does need it again is named, not failed in silence
const SWIFT_BIGNUM_GAP = new Set<string>([])

const isDraft = (file: string, text: string): boolean => {
  if (/^(mark|note) draft$/m.test(text)) {
    return true
  }

  let dir = dirname(file)

  while (dir.startsWith(SEED)) {
    if (existsSync(join(dir, 'draft.tree'))) {
      return true
    }

    dir = dirname(dir)
  }

  return false
}

const have = (tool: string): boolean => {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

const readRuntime = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined

// the module's front end for one backend: the emitted source, or the failure
function front(
  file: string,
  env: Env,
): { source: string } | { fail: string } | { decided: string } {
  const text = readFileSync(file, 'utf8')

  try {
    const envResolver = withNativeEnv(env, resolver)
    // what each module imports, so a name two modules define binds per file as `compile` binds it
    const { sources, scope } = collectModules({ file, text }, envResolver)

    // a `{platform}` load this env answers with no file is refused AT THE LOAD, as `compile` refuses it
    // (compile/load.ts platformRefusals). Skipping that met it further on as a name nothing defines. A module absent
    // on this backend BY DECISION (native-decided.ts) is a named skip, not a failure
    const refusals = platformRefusals(sources, envResolver, env, makeParseMemo())
    const undecided = refusals.filter(
      d => !DECIDED[`${env}/${d.message.split(' has no ')[0]}`],
    )

    if (undecided.length) {
      return { fail: `load: ${undecided[0]?.message ?? ''}` }
    }

    if (refusals.length) {
      const absent = refusals[0]!.message.split(' has no ')[0]!

      return { decided: `${env}/${absent} is absent by decision: ${DECIDED[`${env}/${absent}`]!.slice(0, 120)}` }
    }
    const program: Program = []
    // the entry module's OWN top-level tasks: the shake roots, so each module builds its exports plus their
    // transitive callees, not every function of every module in its closure
    const ownNames = new Set<string>()

    for (const unit of sources) {
      const parsed = parse(unit)

      if (!parsed.ok) {
        return {
          fail: `parse: ${parsed.diagnostics[0]?.message ?? ''}`,
        }
      }

      const built = mill(expandTemplates(parsed.tree), unit.file)

      if (!built.ok) {
        return { fail: `mill: ${built.diagnostics[0]?.message ?? ''}` }
      }

      stampModule(built.program, unit.file)

      if (unit.file === file) {
        for (const s of built.program) {
          if (s.form === 'function') {
            ownNames.add(s.name)
          }
        }
      }

      program.push(...built.program)
    }

    // module scope, as `compileProgram` binds it (check/bind-modules.ts)
    const unbound = bindModules(program, scope, file)

    if (unbound.length) {
      return { fail: `scope: ${unbound[0]?.message ?? ''}` }
    }

    // RESOLVE'S DIAGNOSTICS COUNT TOO. They were discarded here, so a module calling a name that does not exist
    // reported `0 fail` from the front end: `unknown-name` comes from resolve, and only `check` was being read.
    // The full gate still caught it at the toolchain, one stage and several minutes later, pointing at emitted
    // code rather than at the `.tree` line that was wrong. `--front` did not catch it at all, which is worse,
    // because that is the mode you use while writing the module.
    const unresolved = resolveNames(program, file).filter(
      d => d.severity !== 'warning',
    )

    if (unresolved.length) {
      return { fail: `resolve: ${unresolved[0]?.message ?? ''}` }
    }

    // the types as written, before the checker fills an unwritten result with unit, as `compileProgram` records them
    // (node.ts `declared`): an emitter tells a written `like void` from no result by it
    for (const statement of program) {
      if (statement.form === 'function') {
        statement.declared = {
          params: statement.params.map(p => (p.type ? { type: structuredClone(p.type) } : {})),
          ...(statement.result ? { result: structuredClone(statement.result) } : {}),
        }
      }
    }

    const errors = check(program, file).filter(
      d => d.severity !== 'warning',
    )

    if (errors.length) {
      return { fail: `check: ${errors[0]?.message ?? ''}` }
    }

    resolveAsync(program)

    // a module of forms alone (no tasks) still emits its declarations; shake to its own tasks otherwise
    const simple = simplify(
      program,
      ownNames.size > 0
        ? ownNames
        : new Set(
            program
              .filter(
                (s): s is Extract<Statement, { form: 'function' }> =>
                  s.form === 'function',
              )
              .map(s => s.name),
          ),
    )
    const emitted =
      env === 'rust'
        ? emitRust(simple)
        : env === 'swift'
          ? emitSwift(simple)
          : emitKotlin(simple)
    const prelude = nativePrelude(simple, env, readRuntime)

    return {
      source:
        env === 'kotlin'
          ? hoistKotlinImports(`${prelude}\n${emitted}`)
          : `${prelude}\n${emitted}`,
    }
  } catch (error) {
    return { fail: `front: ${String(error).slice(0, 160)}` }
  }
}

// The dependency flags swift and kotlin need to see their standard stacks (NIOFileSystem / Hummingbird,
// kotlinx-coroutines / ktor). Rust needs none: cargo reads CARGO_TOML above.
//
// The per-language scripts own the resolving, and this only reads what they wrote. That way `pnpm term:swift deps`
// and the gate cannot disagree about which swift-nio the modules were checked against, and the fetch happens once
// into a cache that survives between runs rather than every gate run.
const NATIVE_SCRIPT: Record<string, string> = {
  swift: join(ROOT, 'deck/base/code/native/toolchain/swift.sh'),
  kotlin: join(ROOT, 'deck/base/code/native/toolchain/kotlin.sh'),
}

function nativeFlags(env: Env): string[] {
  const script = NATIVE_SCRIPT[env]

  if (!script) {
    return []
  }

  try {
    const out = execFileSync('bash', [script, 'flags'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    })

    // swift writes one argument per line, kotlin writes a single classpath string
    return env === 'kotlin'
      ? ['-classpath', out.trim()]
      : out.split('\n').filter(line => line.length > 0)
  } catch {
    console.log(
      `warn  ${env}: no dependency flags (run deck/base/code/native/toolchain/${env}.sh deps). Modules that import its standard stack will fail.`,
    )

    return []
  }
}

const only = process.env.NG_ONLY ?? ''
const match = process.env.NG_MATCH ?? ''
// The front end alone: parse, mill, check, simplify and emit, without handing anything to cargo, swiftc or
// kotlinc. That is where nearly every error while WRITING a native module is (a name that does not resolve, a
// type that does not fit, a shim that was not found), and it answers in seconds where the full gate takes
// minutes. The toolchain still has the last word: only the full run proves a module builds.
const frontOnly = process.argv.includes('--front')
const jobs = Math.max(1, Math.min(cpus().length - 1, 8))
const work = mkdtempSync(join(tmpdir(), 'term-native-gate-'))

type Result = { module: string; ok: boolean; why?: string }

async function pool<T>(
  items: T[],
  size: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const lanes = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++]!
        await run(item)
      }
    },
  )
  await Promise.all(lanes)
}

const CARGO_TOML = `[package]
name = "term-native-gate"
version = "0.1.0"
edition = "2021"

[dependencies]
regex = "1"
sha2 = "0.10"
md-5 = "0.10"
hmac = "0.12"
base64 = "0.22"
hex = "0.4"
uuid = { version = "1", features = ["v4"] }
rand = "0.8"
aes-gcm = "0.10"
ed25519-dalek = { version = "2", features = ["rand_core"] }
x25519-dalek = { version = "2", features = ["static_secrets"] }
url = "2"
chrono = "0.4"
chrono-tz = "0.10"
signal-hook = "0.3"
libc = "0.2"
# "blocking": the http shim's request is reqwest's blocking client handed back to the loop (decision 001)
reqwest = { version = "0.12", features = ["rustls-tls", "blocking"] }
serde_json = "1"
# "full", matching deck/base/code/native/rust/Cargo.toml and the two test harnesses. A DIFFERENT feature set is a
# different build of tokio, and everything here shares one CARGO_TARGET_DIR, so a narrower list here does not save
# a build, it adds one.
tokio = { version = "1", features = ["full"] }
unicode-normalization = "0.1"
num-bigint = "0.4"
unicode-segmentation = "1"
tokio-tungstenite = "0.24"
# the websocket shim's blocking client over a std TcpStream (item 1154), the same version tokio-tungstenite builds
tungstenite = "0.24"
futures-util = "0.3"
hyper = { version = "1", features = ["server", "client", "http1", "http2"] }
hyper-util = { version = "0.1", features = ["tokio", "server", "server-auto", "service"] }
http-body-util = "0.1"
bytes = "1"
tokio-rustls = "0.26"
rustls-pemfile = "2"
notify = "7"
`

async function runRust(modules: [string, string][]): Promise<Result[]> {
  const results: Result[] = []
  const proj = join(work, 'rust')
  mkdirSync(join(proj, 'src', 'bin'), { recursive: true })
  writeFileSync(join(proj, 'Cargo.toml'), CARGO_TOML)
  writeFileSync(join(proj, 'src', 'main.rs'), 'fn main() {}\n')

  const bins = new Map<string, string>()

  for (const [module, source] of modules) {
    const bin = `m_${module.replace(/[^a-z0-9]+/g, '_')}`
    bins.set(bin, module)
    writeFileSync(
      join(proj, 'src', 'bin', `${bin}.rs`),
      `#![allow(dead_code, unused_variables, unused_mut, unused_imports, non_snake_case)]\n${source}\nfn main() {}\n`,
    )
  }

  const env = {
    ...process.env,
    CARGO_TARGET_DIR: join(tmpdir(), 'seed-rust-runtime', 'target'),
  }

  // one `cargo check` over every bin; when it fails, ask per bin so each module gets its own verdict
  const checkAll = (): boolean => {
    try {
      execFileSync('cargo', ['check', '--bins', '--quiet'], {
        cwd: proj,
        stdio: 'pipe',
        env,
      })

      return true
    } catch {
      return false
    }
  }

  if (checkAll()) {
    for (const module of bins.values()) {
      results.push({ module, ok: true })
    }

    return results
  }

  await pool([...bins.entries()], jobs, async ([bin, module]) => {
    await new Promise<void>(done => {
      execFile(
        'cargo',
        ['check', '--bin', bin, '--quiet'],
        { cwd: proj, env, maxBuffer: 16 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            const first =
              String(stderr)
                .split('\n')
                .find(l => /^error/.test(l)) ?? 'build failed'
            results.push({ module, ok: false, why: first.slice(0, 160) })
          } else {
            results.push({ module, ok: true })
          }

          done()
        },
      )
    })
  })

  return results
}

async function runSwift(modules: [string, string][]): Promise<Result[]> {
  const results: Result[] = []
  const dir = join(work, 'swift')
  mkdirSync(dir, { recursive: true })

  const flags = nativeFlags('swift')

  await pool(modules, jobs, async ([module, source]) => {
    const file = join(dir, `${module.replace(/[^a-z0-9]+/g, '_')}.swift`)
    writeFileSync(file, source)
    await new Promise<void>(done => {
      execFile(
        'swiftc',
        ['-typecheck', ...flags, file],
        { maxBuffer: 16 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            const first =
              String(stderr)
                .split('\n')
                .find(l => /error:/.test(l)) ?? 'build failed'
            results.push({ module, ok: false, why: first.slice(0, 160) })
          } else {
            results.push({ module, ok: true })
          }

          done()
        },
      )
    })
  })

  return results
}

async function runKotlin(modules: [string, string][]): Promise<Result[]> {
  const results: Result[] = []
  const dir = join(work, 'kotlin')
  mkdirSync(dir, { recursive: true })

  const files = new Map<string, string>() // file path -> module
  modules.forEach(([module, source], index) => {
    const file = join(dir, `m${index}.kt`)
    files.set(file, module)
    writeFileSync(file, `package p${index}\n\n${source}`)
  })

  // batch compile; drop the files kotlinc names and retry, so one bad module cannot hide the rest
  let alive = [...files.keys()]
  const failedWhy = new Map<string, string>()
  const flags = nativeFlags('kotlin')

  for (let round = 0; alive.length > 0 && round < 12; round++) {
    try {
      execFileSync(
        'kotlinc',
        // one JVM holds every module's AST at once (each carries its own prelude), and kotlinc's default heap ran out
        // on the full run, failing every module with an error that names no file
        ['-J-Xmx12g', ...alive, ...flags, '-d', join(dir, 'classes')],
        { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 },
      )
      break
    } catch (error) {
      const stderr = String(
        (error as { stderr?: Buffer }).stderr ?? error,
      )
      const bad = new Set<string>()

      for (const line of stderr.split('\n')) {
        const m = /^(.*\.kt):\d+:\d+: error: (.*)$/.exec(line)

        if (m && files.has(m[1]!) && !failedWhy.has(m[1]!)) {
          bad.add(m[1]!)
          failedWhy.set(m[1]!, m[2]!.slice(0, 160))
        }
      }

      if (bad.size === 0) {
        // an error naming no file: fail everything still alive rather than looping
        for (const file of alive) {
          failedWhy.set(file, stderr.split('\n')[0]?.slice(0, 160) ?? 'build failed')
        }

        alive = []
        break
      }

      alive = alive.filter(f => !bad.has(f))
    }
  }

  for (const [file, module] of files) {
    const why = failedWhy.get(file)
    results.push(why ? { module, ok: false, why } : { module, ok: true })
  }

  return results
}

async function main(): Promise<void> {
  const all = walk(join(SEED, 'code'))
  let shelved = 0
  const summary: string[] = []
  let sawFail = false

  for (const env of ENVS) {
    if (only && only !== env) {
      continue
    }

    const tool =
      env === 'rust' ? 'cargo' : env === 'swift' ? 'swiftc' : 'kotlinc'

    if (!have(tool)) {
      console.log(`skip  ${env}: ${tool} not installed`)
      summary.push(`${env}: skipped (${tool} not installed)`)
      continue
    }

    const fronts: [string, string][] = []
    const frontFails: Result[] = []
    shelved = 0

    for (const file of all) {
      const rel = relative(SEED, file)

      if (match && !rel.includes(match)) {
        continue
      }

      // another platform's impls are not this backend's to build
      if (
        OTHER_NATIVE[env].some(other =>
          rel.startsWith(`code/native/${other}/`),
        ) ||
        OTHER_NATIVE[env].some(other => rel === `code/native/${other}.tree`)
      ) {
        continue
      }

      const text = readFileSync(file, 'utf8')

      if (isDraft(file, text)) {
        shelved++
        continue
      }

      // the kernel's proof modules (`test refl` theorem blocks) check at compile time on the node kernel and
      // have no native lowering: a named skip, counted with the shelved
      if (rel.startsWith('code/proof/')) {
        shelved++
        continue
      }

      // swift's standard library has no arbitrary-precision integer, so the big-integer binds (and every
      // module whose closure needs them) have no swift case to render: a NAMED platform gap, not a failure.
      // Closing it means a swift bignum implementation (a project), recorded in note/project/term/stdlib/stdlib-gaps.md.
      if (env === 'swift' && SWIFT_BIGNUM_GAP.has(rel)) {
        console.log(`gap   swift  ${rel}  no arbitrary-precision integer in the swift standard library`)
        shelved++
        continue
      }

      const built = front(file, env)

      if ('fail' in built) {
        frontFails.push({ module: rel, ok: false, why: built.fail })
      } else if ('decided' in built) {
        console.log(`decided  ${env}  ${rel}  ${built.decided}`)
        shelved++
      } else {
        fronts.push([rel, built.source])
      }
    }

    const built = frontOnly
      ? fronts.map(([module]) => ({ module, ok: true }))
      : env === 'rust'
        ? await runRust(fronts)
        : env === 'swift'
          ? await runSwift(fronts)
          : await runKotlin(fronts)

    const results = [...frontFails, ...built].sort((a, b) =>
      a.module.localeCompare(b.module),
    )
    const pass = results.filter(r => r.ok).length
    const fail = results.length - pass

    for (const r of results) {
      if (!r.ok) {
        console.log(`FAIL  ${env}  ${r.module}  ${r.why}`)
      }
    }

    console.log(
      frontOnly
        ? `${env}: ${pass} front, ${fail} fail, ${shelved} shelved (--front: the toolchain was not run)`
        : `${env}: ${pass} build, ${fail} fail, ${shelved} shelved (skipped); test blocks run on the node gate (term test), a named skip here`,
    )
    summary.push(
      `${env}: ${pass} ${frontOnly ? 'front' : 'build'}, ${fail} fail, ${shelved} shelved`,
    )

    if (fail > 0) {
      sawFail = true
    }
  }

  console.log(`\nnative-gate: ${summary.join(' | ')}`)

  if (sawFail) {
    process.exitCode = 1
  }
}

main()
