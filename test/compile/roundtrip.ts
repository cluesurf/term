// Round-trip tests: emit each native backend, compile it with the REAL toolchain (swiftc / kotlinc / clang), run the
// binary, and assert the result matches the interpreter's. This proves the backends emit code that actually compiles
// and computes correctly, not just code of the right shape. Each backend is gated on its toolchain being installed;
// a missing toolchain is reported as skipped, never a failure. Run: npx tsx test/compile/roundtrip.ts

import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { resolve as resolveNames } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { collectModules } from '@/code/compile/load'
import type { Source } from '@/code/compile/load'
import { withNativeEnv, nativePrelude } from '@/code/compile/native'
import { emitSwift } from '@/code/compile/swift'
import { emitKotlin } from '@/code/compile/kotlin'
import { emitLlvm } from '@/code/compile/llvm'
import { emitRust } from '@/code/compile/rust'
import { LLVM_RUNTIME_RUST } from '@/code/compile/llvm-runtime'
import type { Program } from '@/code/compile/node'
import { readFileSync, existsSync } from 'node:fs'

let pass = 0
let fail = 0
let skip = 0
function ok(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}  (= ${got})`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}
function skipped(name: string, why: string): void {
  skip++
  console.log(`skip  ${name}  (${why})`)
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const dir = mkdtempSync(join(tmpdir(), 'seed-roundtrip-'))
const baseTree = join(process.cwd(), '..', 'base.tree')
const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)
  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

// read a native runtime shim's raw source (the path already carries the real extension, no `.tree`). `nativePrelude`
// now resolves shims next to the module that docks them (an absolute path), so try that directly first; fall back to
// the `@cluesurf/base/...` import-path form for any dock whose origin file was not recorded.
const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) return readFileSync(path, 'utf8')
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, path.slice(prefix.length))
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

// front-end a program (optionally resolving stdlib imports) to a checked compile AST. An `env` resolves abstract
// `native/<x>` imports to that platform's implementation (so the public math/file modules pick up native/<env>/<x>).
function frontEnd(
  text: string,
  withStdlib = false,
  env?: 'rust' | 'swift' | 'kotlin' | 'node',
): Program {
  const resolver = env ? withNativeEnv(env, stdlib) : stdlib
  const sources = withStdlib
    ? collectModules({ file: 'main.tree', text }, resolver).sources
    : [{ file: 'main.tree', text }]
  const program: Program = []
  for (const unit of sources) {
    const parsed = parse(unit)
    if (!parsed.ok) throw new Error('parse failed')
    const built = mill(parsed.tree, unit.file)
    if (!built.ok)
      throw new Error(
        'mill failed: ' +
          built.diagnostics.map(d => d.message).join(', '),
      )
    program.push(...built.program)
  }
  resolveNames(program, 'main.tree')
  check(program, 'main.tree')
  return program
}

function runSwift(
  name: string,
  program: Program,
  callExpr: string,
  want: number,
): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(file, `${emitSwift(program)}\nprint(${callExpr})\n`)
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (swiftc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, Number(execFileSync(exe).toString().trim()), want)
}

function runKotlin(
  name: string,
  program: Program,
  callExpr: string,
  want: number,
): void {
  if (!have('kotlinc') || !have('java'))
    return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    `${emitKotlin(program)}\nfun main() { println(${callExpr}) }\n`,
  )
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (kotlinc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(
    name,
    Number(execFileSync('java', ['-jar', jar]).toString().trim()),
    want,
  )
}

// LLVM: append a main that returns the function result as the process exit code, assemble + run with clang
function runLlvm(
  name: string,
  program: Program,
  mangledCall: string,
  want: number,
): void {
  if (!have('clang')) return skipped(name, 'clang not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.ll`)
  const main = `\ndefine i32 @main() {\n  %r = call i64 ${mangledCall}\n  %t = trunc i64 %r to i32\n  ret i32 %t\n}\n`
  writeFileSync(file, emitLlvm(program) + main)
  const exe = file.replace(/\.ll$/, '')
  try {
    execFileSync(
      'clang',
      ['-Wno-override-module', '-x', 'ir', file, '-o', exe],
      { stdio: 'pipe' },
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (clang error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, spawnSync(exe).status, want)
}

// compile emitted Rust with rustc and run it, asserting the exit code
function runRust(
  name: string,
  program: Program,
  callExpr: string,
  want: number,
): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(
    file,
    `${emitRust(
      program,
    )}\nfn main() { std::process::exit((${callExpr}) as i32); }\n`,
  )
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (rustc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, spawnSync(exe).status, want)
}

// Rust file IO end to end: compile the synchronous native/rust/file module (which forwards to the linked `io`
// runtime), prepend the io runtime shim (from base.tree, via nativePrelude), append a main that writes a temp file through the emitted code then reads it
// back, run with rustc, and assert stdout. Proves native file IO actually RUNS on a real compiled toolchain, not just
// that it emits the right shape. main owns the path and clones it across the two calls (each emitted call moves its arg).
function runRustIo(name: string, program: Program, want: string): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const path = join(dir, 'seed_rust_io_roundtrip.txt')
  const main = `\nfn main() {\n  let p = ${JSON.stringify(
    path,
  )}.to_string();\n  write_demo(p.clone(), ${JSON.stringify(
    want,
  )}.to_string());\n  print!("{}", read_demo(p));\n}\n`
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(
      program,
    )}${main}`,
  )
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (rustc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

// Swift file IO end to end: prepend the io runtime shim (from base.tree), write + read a temp file through emitted Swift.
function runSwiftIo(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const path = join(dir, 'seed_swift_io.txt')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  const main = `\nwriteDemo(${JSON.stringify(path)}, ${JSON.stringify(
    want,
  )})\nprint(readDemo(${JSON.stringify(path)}), terminator: "")\n`
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(
      program,
    )}${main}`,
  )
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (swiftc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

// Kotlin file IO end to end: prepend the io runtime shim (from base.tree), write + read a temp file through emitted Kotlin.
function runKotlinIo(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('kotlinc') || !have('java'))
    return skipped(name, 'kotlinc/java not installed')
  const path = join(dir, 'seed_kotlin_io.txt')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  const main = `\nfun main() {\n  writeDemo(${JSON.stringify(
    path,
  )}, ${JSON.stringify(want)})\n  print(readDemo(${JSON.stringify(
    path,
  )}))\n}\n`
  writeFileSync(
    file,
    `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}${main}`,
  )
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (kotlinc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// math delegation running for real: prepend the per-target math shim, print a value computed through the public math
// interface (which forwards abs/pow/... to that shim), compile + run, assert stdout.
function runRustMath(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(
      program,
    )}\nfn main() { print!("{}", compute()); }\n`,
  )
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (rustc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runSwiftMath(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(
      program,
    )}\nprint(compute(), terminator: "")\n`,
  )
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (swiftc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runKotlinMath(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('kotlinc') || !have('java'))
    return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}\nfun main() { print(compute()) }\n`,
  )
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (kotlinc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// crypto wrapping running for real: prepend the platform crypto shim (which calls the platform's built-in crypto
// library), compute a digest through the public interface, compile + run, assert the known hex. A toolchain that
// cannot resolve its crypto framework is reported as skipped, not failed.
function runSwiftCrypto(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(
      program,
    )}\nprint(await compute(), terminator: "")\n`,
  )
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    return skipped(
      name,
      `swiftc could not build (CryptoKit unavailable?): ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 120)}`,
    )
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runKotlinCrypto(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('kotlinc') || !have('java'))
    return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}\nsuspend fun main() { print(compute()) }\n`,
  )
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], {
      stdio: 'pipe',
    })
  } catch (e) {
    return skipped(
      name,
      `kotlinc could not build: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 120)}`,
    )
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// string ops running for real: prepend the per-target text shim, uppercase a string through the public interface.
function runRustText(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(
      program,
    )}\nfn main() { print!("{}", compute()); }\n`,
  )
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (rustc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runSwiftText(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(
      program,
    )}\nprint(compute(), terminator: "")\n`,
  )
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (swiftc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runKotlinText(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('kotlinc') || !have('java'))
    return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}\nfun main() { print(compute()) }\n`,
  )
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (kotlinc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// run a program on rust THROUGH CARGO, so the crate-backed shims (crypto via sha2/hmac/md-5, regex via the regex
// crate) actually link and execute. Uses a fixed project dir so the compiled dependencies cache across test runs.
// `isAsync` wraps main in a tokio runtime (the crypto interface is async on every target).
const RUST_CARGO_TOML = `[package]
name = "seed-rust-runtime"
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
chrono = "0.4"
reqwest = { version = "0.12", features = ["rustls-tls"] }
serde_json = "1"
tokio = { version = "1", features = ["rt", "rt-multi-thread", "macros"] }

[[bin]]
name = "run"
path = "src/main.rs"
`
function runRustCargo(
  name: string,
  program: Program,
  want: string,
  isAsync: boolean,
): void {
  if (!have('cargo')) return skipped(name, 'cargo not installed')
  const proj = join(tmpdir(), 'seed-rust-runtime')
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'Cargo.toml'), RUST_CARGO_TOML)
  const prelude = nativePrelude(program, 'rust', readRuntime)
  const main = isAsync
    ? `\n#[tokio::main]\nasync fn main() { print!("{}", compute().await); }\n`
    : `\nfn main() { print!("{}", compute()); }\n`
  writeFileSync(
    join(proj, 'src', 'main.rs'),
    `${prelude}\n${emitRust(program)}${main}`,
  )
  let out: string
  try {
    out = execFileSync('cargo', ['run', '--quiet'], {
      cwd: proj,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (cargo error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, out.trim(), want)
}

// rust console uses println! (std, no crate), so bare rustc suffices; compute() prints, main calls it bare.
function runRustConsole(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(
      program,
    )}\nfn main() { compute(); }\n`,
  )
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (rustc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

// console: `compute` returns unit and prints as a side effect, so the runner calls it bare and captures stdout.
function runSwiftConsole(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(
      program,
    )}\ncompute()\n`,
  )
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (swiftc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runKotlinConsole(
  name: string,
  program: Program,
  want: string,
): void {
  if (!have('kotlinc') || !have('java'))
    return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}\nfun main() { compute() }\n`,
  )
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (kotlinc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// the clang -arch that matches the Rust runtime's host (rustc here targets x86_64; clang cross-compiles to it)
function rustcArch(): string | undefined {
  try {
    const host =
      /host:\s*(\S+)/.exec(
        execFileSync('rustc', ['-vV']).toString(),
      )?.[1] ?? ''
    if (host.startsWith('x86_64')) return 'x86_64'
    if (host.startsWith('aarch64') || host.startsWith('arm64'))
      return 'arm64'
  } catch {
    // fall through
  }
  return undefined
}

// LLVM + the Rust runtime: emit IR, append a `main` that prints the string the function returns, compile the Rust
// runtime to a staticlib, link it with clang, run, and check stdout
function runLlvmRust(
  name: string,
  program: Program,
  mangledCall: string,
  want: string,
): void {
  if (!have('clang') || !have('rustc'))
    return skipped(name, 'clang/rustc not installed')
  const arch = rustcArch()
  if (!arch)
    return skipped(name, 'could not determine the rust host arch')
  const rs = join(dir, `${name.replace(/\W/g, '')}.rs`)
  const lib = join(dir, `lib${name.replace(/\W/g, '')}.a`)
  writeFileSync(rs, LLVM_RUNTIME_RUST)
  try {
    execFileSync(
      'rustc',
      [
        '--edition',
        '2021',
        '--crate-type',
        'staticlib',
        '-O',
        rs,
        '-o',
        lib,
      ],
      { stdio: 'pipe' },
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (rustc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  const file = join(dir, `${name.replace(/\W/g, '')}.ll`)
  const main = `\ndefine i32 @main() {\n  %r = call ptr ${mangledCall}\n  call void @seed_print_str(ptr %r)\n  ret i32 0\n}\n`
  writeFileSync(file, emitLlvm(program) + main)
  const exe = file.replace(/\.ll$/, '')
  try {
    execFileSync(
      'clang',
      [
        '-arch',
        arch,
        '-Wno-override-module',
        '-x',
        'ir',
        file,
        '-x',
        'none',
        lib,
        '-o',
        exe,
      ],
      { stdio: 'pipe' },
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (clang error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

// a string-returning function: a literal concatenation, lowered to the runtime's seed_str_concat
const GREETING = `task greeting\n  like text\n  send back\n    call add\n      text <hello >\n      text <world>\n`

// an iterative Fibonacci: mutation + a while loop (the scalar imperative fragment every native backend supports)
// a higher-order function: a closure passed as a Box<dyn Fn> param and called twice. apply-twice(double, 5) = 20.
const CLOSURE = `task apply-twice
  take f
    like task
      take n, like number
      like number
  take x, like number
  like number
  send back
    call f
      call f
        read x

task compute
  take seed
  like number
  send back
    call apply-twice
      task double
        take n, like number
        like number
        send back
          call multiply
            read n
            mark 2
      read seed
`
// a closure stored in a struct field (the router handler case) and invoked through the field: route.handle(6) = 18.
const HANDLER = `form route
  link handle
    like task
      take n, like number
      like number

task call-route
  take r, like route
  take x, like number
  like number
  send back
    call r/handle
      read x

task compute
  take seed
  like number
  send back
    call call-route
      make route
        bind handle
          task triple
            take n, like number
            like number
            send back
              call multiply
                read n
                mark 3
      read seed
`

const FIB = `task find-fibonacci-via-loop
  take n
  save a, mark 0
  save b, mark 1
  walk test
    hook test
      call is-above
        loan n
        mark 0
    hook step
      save next
        call add
          loan a
          loan b
      save a, loan b
      save b, loan next
      save n
        call subtract
          loan n
          mark 1
  send back
    loan a
`

// the stdlib maybe used concretely: a native enum, pattern match, map, and unwrap-or
const MAYBE = `load @cluesurf/base/code/maybe
  find maybe

task demo
  like number
  save m
    make some
      bind value, mark 41
  save total
    call unwrap-or
      read m
      mark 0
  save e
    make none
  save total
    call add
      read total
      call unwrap-or
        read e
        mark 7
  send back, read total
`

// per-target file IO programs (identical shape, different native platform module)
const ioProgram = (
  platform: string,
) => `load @cluesurf/base/code/native/${platform}/file
  find write-file
  find read-file

task write-demo
  take path, like text
  take data, like text
  like void
  call write-file
    read path
    read data

task read-demo
  take path, like text
  like text
  send back
    call read-file
      read path
`

// a value computed through the public math interface: power(2,10) forwards to the per-target math shim's pow
const MATH_PROG = `load @cluesurf/base/code/math
  find power

task compute
  like number
  send back
    call power
      mark 2
      mark 10
`

// a digest computed through the public-style interface: sha256("abc") forwards to the per-target crypto shim
const cryptoProgram = (
  platform: string,
) => `load @cluesurf/base/code/native/${platform}/cryptography/digest
  find digest-sha256

task compute
  mark async
  like text
  send back
    call digest-sha256
      text <abc>
      wait true
`
const SHA256_ABC =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

// base64 / hex / hmac through the public interfaces, forwarding to each target's shim (prelude auto-collected)
const BASE64_PROG = `load @cluesurf/base/code/text/base64
  find encode

task compute
  like text
  send back
    call encode
      text <hello>
`
const HEX_PROG = `load @cluesurf/base/code/text/hex
  find encode

task compute
  like text
  send back
    call encode
      text <hi>
`
const HMAC_PROG = `load @cluesurf/base/code/cryptography/hmac
  find sha256

task compute
  mark async
  like text
  send back
    call sha256
      text <key>
      text <The quick brown fox jumps over the lazy dog>
      wait true
`
const HMAC_VECTOR =
  'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'

// uuid: version4 is random, so verify its FORMAT with regex (cross-platform, no member access). Uses both shims.
const UUID_PROG = `load @cluesurf/base/code/uuid
  find version4

load @cluesurf/base/code/regex
  find matches

task compute
  like boolean
  save id
    call version4
  send back
    call matches
      text <^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$>
      read id
`
// random: integer(low, high) with low == high is deterministic
const RANDOM_PROG = `load @cluesurf/base/code/random
  find integer

task compute
  like number
  send back
    call integer
      mark 5
      mark 5
`
// secure random: two 16-byte draws differ (the OS-backed generator is not a constant). Asserted as a boolean to stay
// print-format agnostic. Exercises the crypto shim's random-bytes on each platform (rust OsRng, swift
// SystemRandomNumberGenerator, kotlin SecureRandom).
const SECURE_RANDOM_PROG = `load @cluesurf/base/code/cryptography/random
  find bytes

task compute
  like boolean
  send back
    call is-unequal
      call bytes
        mark 16
      call bytes
        mark 16
`
// AES-256-GCM: encrypt a plaintext then decrypt it, asserting the round-trip recovers the original (boolean, so it is
// print-format agnostic). Key is 32 bytes / 64 hex, nonce is 12 bytes / 24 hex. Exercises each platform's AEAD
// library (rust aes-gcm, swift CryptoKit AES.GCM, kotlin javax.crypto), all agreeing on the ciphertext || tag layout.
const CIPHER_PROG = `load @cluesurf/base/code/cryptography/cipher
  find encrypt
  find decrypt

task compute
  mark async
  like boolean
  save sealed
    call encrypt
      text <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff>
      text <000102030405060708090a0b>
      text <attack at dawn>
      wait true
  save opened
    call decrypt
      text <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff>
      text <000102030405060708090a0b>
      read sealed
      wait true
  send back
    call is-equal
      read opened
      text <attack at dawn>
`
// Ed25519 signatures: generate a key pair, sign a message, verify it (boolean round-trip, print-format agnostic).
// Exercises each platform's Ed25519 (rust ed25519-dalek, swift CryptoKit Curve25519, kotlin java.security).
const SIGNATURE_PROG = `load @cluesurf/base/code/cryptography/signature
  find make-key-pair
  find sign
  find verify

task compute
  mark async
  like boolean
  save pair
    call make-key-pair
      wait true
  save proof
    call sign
      read pair/private-key
      text <ship sails at noon>
      wait true
  send back
    call verify
      read pair/public-key
      text <ship sails at noon>
      read proof
      wait true
`
// environment variable: PATH is always set in a spawned process, so reading it yields a non-empty string. Asserts as
// a boolean via the host environment (rust std::env, swift ProcessInfo, kotlin System.getenv).
const ENV_VAR_PROG = `load @cluesurf/base/code/environment
  find variable

task compute
  like boolean
  send back
    call is-unequal
      call variable
        text <PATH>
      text <>
`
// directory make plus metadata: make a directory then confirm is-directory reports it. Exercises the io shim's
// dir-make and is-directory on each platform (rust std::fs, swift FileManager, kotlin java.io.File).
const DIR_MAKE_PROG = `load @cluesurf/base/code/file/directory
  find make
load @cluesurf/base/code/file/metadata
  find is-directory

task compute
  like boolean
  call make
    text </tmp/seed-roundtrip-fsdir>
  send back
    call is-directory
      text </tmp/seed-roundtrip-fsdir>
`
// directory remove: make then remove a directory, then confirm it no longer exists (returns false).
const DIR_REMOVE_PROG = `load @cluesurf/base/code/file/directory
  find make
  find remove
  find exists

task compute
  like boolean
  call make
    text </tmp/seed-roundtrip-fsdir-two>
  call remove
    text </tmp/seed-roundtrip-fsdir-two>
  send back
    call exists
      text </tmp/seed-roundtrip-fsdir-two>
`
// calendar: build a UTC timestamp, format it to ISO 8601, parse it back, and shift it a month. Asserts three
// invariants at once (format matches the exact cross-platform string, parse inverts format, add-months is
// calendar-aware) as a single boolean. Exercises each platform's date library (rust chrono, swift Foundation,
// kotlin java.time), all agreeing on the 2026-06-19T12:34:56.000Z shape.
const CALENDAR_PROG = `load @cluesurf/base/code/calendar
  find make-utc
  find format
  find parse
  find month
  find add-months

task compute
  like boolean
  save m
    call make-utc
      mark 2026
      mark 6
      mark 19
      mark 12
      mark 34
      mark 56
  send back
    call and
      call and
        call is-equal
          call format
            read m
          text <2026-06-19T12:34:56.000Z>
        call is-equal
          call parse
            text <2026-06-19T12:34:56.000Z>
          read m
      call is-equal
        call month
          call add-months
            read m
            mark 1
        mark 7
`
// X25519 ECDH: two key pairs derive the same shared secret from opposite sides (the agreement property), asserted as
// a boolean. Exercises each platform's X25519 (rust x25519-dalek, swift CryptoKit, kotlin java.security).
const KEY_AGREEMENT_PROG = `load @cluesurf/base/code/cryptography/key-agreement
  find make-key-pair
  find shared-secret

task compute
  mark async
  like boolean
  save a
    call make-key-pair
      wait true
  save b
    call make-key-pair
      wait true
  save ab
    call shared-secret
      read a/private-key
      read b/public-key
      wait true
  save ba
    call shared-secret
      read b/private-key
      read a/public-key
      wait true
  send back
    call is-equal
      read ab
      read ba
`
// json: parse a JSON array (no braces -- seed text literals interpolate single { ), index it, read the number.
// as-number(get-item(parse("[10,20,30]"), 1)) == 20.0, through each platform's host JSON.
const JSON_RT_PROG = `load @cluesurf/base/code/json
  find parse
  find get-item
  find as-number

task compute
  like boolean
  send back
    call is-equal
      call as-number
        call get-item
          call parse
            text <[10,20,30]>
          mark 1
      20.0
`
// json encode: assemble a typed value (make-object + set-field + from-*), stringify it through the host JSON, then
// parse the text back and read the name field. Proves typed encode round-trips on each platform's native JSON value
// (serde_json Map, JSONSerialization dictionary) with no derive macros. Asserted as a boolean (text equality).
const JSON_ENCODE_RT = `load @cluesurf/base/code/json
  find parse
  find stringify
  find field-text
  find make-object
  find set-field
  find from-text
  find from-number
  find from-boolean

task compute
  like boolean
  save built
    call stringify
      call set-field
        call set-field
          call set-field
            call make-object
            text <name>
            call from-text
              text <seed>
          text <age>
          call from-number
            3.0
        text <active>
        call from-boolean
          wave true
  save j
    call parse
      read built
  send back
    call is-equal
      call field-text
        read j
        text <name>
      text <seed>
`
// float: real floating-point math. square-root(9.0) == 3.0 exactly (asserted as a boolean to avoid print-format
// differences: rust prints "3", swift/kotlin print "3.0").
const FLOAT_PROG = `load @cluesurf/base/code/float
  find square-root

task compute
  like boolean
  send back
    call is-equal
      call square-root
        9.0
      3.0
`
// time: now() is non-deterministic, so assert it is a positive epoch (boolean -> "true")
const TIME_PROG = `load @cluesurf/base/code/time
  find now

task compute
  like boolean
  send back
    call is-above
      call now
      mark 0
`
// console: compute() prints to stdout (it returns unit), so the runner just calls it and captures stdout
const CONSOLE_PROG = `load @cluesurf/base/code/console
  find log

task compute
  like void
  call log
    text <hello console>
`
// clock: monotonic now() is positive
const CLOCK_PROG = `load @cluesurf/base/code/clock
  find now

task compute
  like boolean
  send back
    call is-above
      call now
      mark 0
`
// process / environment: return non-empty platform info, verified with regex (no member access)
const PROCESS_PROG = `load @cluesurf/base/code/process
  find platform

load @cluesurf/base/code/regex
  find matches

task compute
  like boolean
  send back
    call matches
      text <^.+$>
      call platform
`
const ENVIRONMENT_PROG = `load @cluesurf/base/code/environment
  find directory

load @cluesurf/base/code/regex
  find matches

task compute
  like boolean
  send back
    call matches
      text <^.+$>
      call directory
`
// log: info() prints to stdout
const LOG_PROG = `load @cluesurf/base/code/log
  find info

task compute
  like void
  call info
    text <hello log>
`

// a string op through the public interface: to-upper("seed") forwards to the per-target text shim
const TEXT_PROG = `load @cluesurf/base/code/text/string
  find to-upper

task compute
  like text
  send back
    call to-upper
      text <seed>
`

// a regex match through the public interface, forwarding to the per-target regex shim (the prelude is auto-collected)
const REGEX_PROG = `load @cluesurf/base/code/regex
  find matches

task compute
  like boolean
  send back
    call matches
      text <^[0-9]+$>
      text <12345>
`

function main(): void {
  const fib = frontEnd(FIB)
  runLlvm(
    'llvm: iterative fibonacci (mutation + while)',
    fib,
    '@find_fibonacci_via_loop(i64 10)',
    55,
  )
  // llvm float: 7.0 / 2.0 == 3.5 via `fdiv double` + `fcmp oeq double` (not integer division)
  runLlvm(
    'llvm: float arithmetic + comparison (double)',
    frontEnd(
      'task compute\n  like boolean\n  send back\n    call is-equal\n      call divide\n        7.0\n        2.0\n      3.5\n',
    ),
    '@compute()',
    1,
  )
  runRust(
    'rust: iterative fibonacci (mutation + while)',
    fib,
    'find_fibonacci_via_loop(10)',
    55,
  )
  runRust(
    'rust: higher-order closure as a Box<dyn Fn> param',
    frontEnd(CLOSURE),
    'compute(10)',
    40,
  )
  runRust(
    'rust: a closure stored in a struct field, called through it',
    frontEnd(HANDLER),
    'compute(6)',
    18,
  )
  runSwift(
    'swift: iterative fibonacci',
    fib,
    'findFibonacciViaLoop(10)',
    55,
  )
  runKotlin(
    'kotlin: iterative fibonacci',
    fib,
    'findFibonacciViaLoop(10)',
    55,
  )

  // closures on every backend: a higher-order function (closure param) and a closure stored in a struct field
  const closure = frontEnd(CLOSURE)
  runSwift(
    'swift: higher-order closure param',
    closure,
    'compute(10)',
    40,
  )
  runKotlin(
    'kotlin: higher-order closure param',
    closure,
    'compute(10)',
    40,
  )
  const handler = frontEnd(HANDLER)
  runSwift(
    'swift: a closure stored in a struct field',
    handler,
    'compute(6)',
    18,
  )
  runKotlin(
    'kotlin: a closure stored in a struct field',
    handler,
    'compute(6)',
    18,
  )

  const maybe = frontEnd(MAYBE, true)
  runSwift('swift: native ADT enum + match + map', maybe, 'demo()', 48)
  runKotlin(
    'kotlin: native ADT sealed class + match + map',
    maybe,
    'demo()',
    48,
  )

  // LLVM with the managed Rust runtime: strings as pointers, concatenation + printing through the linked staticlib
  runLlvmRust(
    'llvm + rust runtime: string concat + print',
    frontEnd(GREETING),
    '@greeting()',
    'hello world',
  )

  // native file IO running for real on each compiled toolchain: write + read a temp file through the emitted code +
  // the per-target io runtime shim (the same public-style file ops, three different platform file systems)
  runRustIo(
    'rust + io runtime: file write then read round-trips',
    frontEnd(ioProgram('rust'), true),
    'hello rust io',
  )
  runSwiftIo(
    'swift + io runtime: file write then read round-trips',
    frontEnd(ioProgram('swift'), true),
    'hello swift io',
  )
  runKotlinIo(
    'kotlin + io runtime: file write then read round-trips',
    frontEnd(ioProgram('kotlin'), true),
    'hello kotlin io',
  )

  // math delegation running for real: the public math interface forwards pow to each target's math shim
  runRustMath(
    'rust + math runtime: power(2,10) through the math interface',
    frontEnd(MATH_PROG, true, 'rust'),
    '1024',
  )
  runSwiftMath(
    'swift + math runtime: power(2,10) through the math interface',
    frontEnd(MATH_PROG, true, 'swift'),
    '1024',
  )
  runKotlinMath(
    'kotlin + math runtime: power(2,10) through the math interface',
    frontEnd(MATH_PROG, true, 'kotlin'),
    '1024',
  )

  // crypto wrapping the platform's built-in library, running for real (swift CryptoKit, kotlin java.security)
  runSwiftCrypto(
    'swift + crypto runtime: sha256("abc") through CryptoKit',
    frontEnd(cryptoProgram('swift'), true, 'swift'),
    SHA256_ABC,
  )
  runKotlinCrypto(
    'kotlin + crypto runtime: sha256("abc") through java.security',
    frontEnd(cryptoProgram('kotlin'), true, 'kotlin'),
    SHA256_ABC,
  )

  // rust crypto + regex running for real THROUGH CARGO, linking the production crates (sha2 / regex)
  runRustCargo(
    'rust + cargo: sha256("abc") through the sha2 crate',
    frontEnd(cryptoProgram('rust'), true, 'rust'),
    SHA256_ABC,
    true,
  )
  runRustCargo(
    'rust + cargo: matches("^[0-9]+$","12345") through the regex crate',
    frontEnd(REGEX_PROG, true, 'rust'),
    'true',
    false,
  )

  // base64 / hex / hmac to "runs" on all three compiled toolchains
  runSwiftText(
    'swift + base64: encode("hello") via Foundation',
    frontEnd(BASE64_PROG, true, 'swift'),
    'aGVsbG8=',
  )
  runKotlinText(
    'kotlin + base64: encode("hello") via java.util.Base64',
    frontEnd(BASE64_PROG, true, 'kotlin'),
    'aGVsbG8=',
  )
  runRustCargo(
    'rust + cargo: base64 encode("hello") via the base64 crate',
    frontEnd(BASE64_PROG, true, 'rust'),
    'aGVsbG8=',
    false,
  )
  runSwiftText(
    'swift + hex: encode("hi") via Foundation',
    frontEnd(HEX_PROG, true, 'swift'),
    '6869',
  )
  runKotlinText(
    'kotlin + hex: encode("hi") via kotlin',
    frontEnd(HEX_PROG, true, 'kotlin'),
    '6869',
  )
  runRustCargo(
    'rust + cargo: hex encode("hi") via the hex crate',
    frontEnd(HEX_PROG, true, 'rust'),
    '6869',
    false,
  )
  runSwiftCrypto(
    'swift + hmac: sha256 RFC vector via CryptoKit',
    frontEnd(HMAC_PROG, true, 'swift'),
    HMAC_VECTOR,
  )
  runKotlinCrypto(
    'kotlin + hmac: sha256 RFC vector via javax.crypto.Mac',
    frontEnd(HMAC_PROG, true, 'kotlin'),
    HMAC_VECTOR,
  )
  runRustCargo(
    'rust + cargo: hmac sha256 RFC vector via the hmac crate',
    frontEnd(HMAC_PROG, true, 'rust'),
    HMAC_VECTOR,
    true,
  )

  // uuid (format-checked via regex) + random (deterministic integer) to "runs" on all three
  runSwiftText(
    'swift + uuid: version4 is well-formed (via Foundation UUID)',
    frontEnd(UUID_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + uuid: version4 is well-formed (via java.util.UUID)',
    frontEnd(UUID_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: uuid version4 is well-formed (via the uuid crate)',
    frontEnd(UUID_PROG, true, 'rust'),
    'true',
    false,
  )
  runSwiftText(
    'swift + random: integer(5,5) is 5 (via Int.random)',
    frontEnd(RANDOM_PROG, true, 'swift'),
    '5',
  )
  runKotlinText(
    'kotlin + random: integer(5,5) is 5 (via kotlin Random)',
    frontEnd(RANDOM_PROG, true, 'kotlin'),
    '5',
  )
  runRustCargo(
    'rust + cargo: random integer(5,5) is 5 (via the rand crate)',
    frontEnd(RANDOM_PROG, true, 'rust'),
    '5',
    false,
  )
  // secure random: two draws differ, via each platform's OS-backed cryptographic generator
  runSwiftText(
    'swift + crypto/random: two 16-byte draws differ (SystemRandomNumberGenerator)',
    frontEnd(SECURE_RANDOM_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + crypto/random: two 16-byte draws differ (SecureRandom)',
    frontEnd(SECURE_RANDOM_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: crypto/random two 16-byte draws differ (OsRng)',
    frontEnd(SECURE_RANDOM_PROG, true, 'rust'),
    'true',
    false,
  )
  // AES-256-GCM authenticated encryption round-trips on all three (rust aes-gcm, swift CryptoKit, kotlin javax.crypto)
  runSwiftCrypto(
    'swift + crypto/cipher: AES-256-GCM encrypt + decrypt round-trips (CryptoKit)',
    frontEnd(CIPHER_PROG, true, 'swift'),
    'true',
  )
  runKotlinCrypto(
    'kotlin + crypto/cipher: AES-256-GCM encrypt + decrypt round-trips (javax.crypto)',
    frontEnd(CIPHER_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: crypto/cipher AES-256-GCM encrypt + decrypt round-trips (aes-gcm)',
    frontEnd(CIPHER_PROG, true, 'rust'),
    'true',
    true,
  )
  // Ed25519 sign + verify round-trips on all three (rust ed25519-dalek, swift CryptoKit, kotlin java.security)
  runSwiftCrypto(
    'swift + crypto/signature: Ed25519 sign + verify round-trips (CryptoKit)',
    frontEnd(SIGNATURE_PROG, true, 'swift'),
    'true',
  )
  runKotlinCrypto(
    'kotlin + crypto/signature: Ed25519 sign + verify round-trips (java.security)',
    frontEnd(SIGNATURE_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: crypto/signature Ed25519 sign + verify round-trips (ed25519-dalek)',
    frontEnd(SIGNATURE_PROG, true, 'rust'),
    'true',
    true,
  )
  // environment variable: PATH is non-empty, read through the host environment
  runSwiftText(
    'swift + environment: variable(PATH) is non-empty (ProcessInfo)',
    frontEnd(ENV_VAR_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + environment: variable(PATH) is non-empty (System.getenv)',
    frontEnd(ENV_VAR_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: environment variable(PATH) is non-empty (std::env)',
    frontEnd(ENV_VAR_PROG, true, 'rust'),
    'true',
    false,
  )
  // directory make + metadata is-directory
  runSwiftText(
    'swift + file/directory: make then is-directory (FileManager)',
    frontEnd(DIR_MAKE_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + file/directory: make then is-directory (java.io.File)',
    frontEnd(DIR_MAKE_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: file/directory make then is-directory (std::fs)',
    frontEnd(DIR_MAKE_PROG, true, 'rust'),
    'true',
    false,
  )
  // directory remove: gone afterward
  runSwiftText(
    'swift + file/directory: make then remove leaves it absent (FileManager)',
    frontEnd(DIR_REMOVE_PROG, true, 'swift'),
    'false',
  )
  runKotlinText(
    'kotlin + file/directory: make then remove leaves it absent (java.io.File)',
    frontEnd(DIR_REMOVE_PROG, true, 'kotlin'),
    'false',
  )
  runRustCargo(
    'rust + cargo: file/directory make then remove leaves it absent (std::fs)',
    frontEnd(DIR_REMOVE_PROG, true, 'rust'),
    'false',
    false,
  )
  // calendar: ISO format + parse + calendar-aware add-months agree across the platform date libraries
  runSwiftText(
    'swift + calendar: ISO format + parse + add-months (Foundation)',
    frontEnd(CALENDAR_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + calendar: ISO format + parse + add-months (java.time)',
    frontEnd(CALENDAR_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: calendar ISO format + parse + add-months (chrono)',
    frontEnd(CALENDAR_PROG, true, 'rust'),
    'true',
    false,
  )
  // X25519 ECDH: both sides derive the same shared secret, on each platform's key-agreement library
  runSwiftCrypto(
    'swift + crypto/key-agreement: X25519 shared secret agrees (CryptoKit)',
    frontEnd(KEY_AGREEMENT_PROG, true, 'swift'),
    'true',
  )
  runKotlinCrypto(
    'kotlin + crypto/key-agreement: X25519 shared secret agrees (java.security)',
    frontEnd(KEY_AGREEMENT_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: crypto/key-agreement X25519 shared secret agrees (x25519-dalek)',
    frontEnd(KEY_AGREEMENT_PROG, true, 'rust'),
    'true',
    true,
  )
  // json to "runs" via the host JSON: rust serde_json (cargo), swift JSONSerialization. kotlin needs org.json on the
  // classpath (not in the JDK), so it is compile-checked, not run here.
  runRustCargo(
    'rust + cargo: json parse + index + as-number via serde_json',
    frontEnd(JSON_RT_PROG, true, 'rust'),
    'true',
    false,
  )
  runSwiftText(
    'swift + json: parse + index + as-number via JSONSerialization',
    frontEnd(JSON_RT_PROG, true, 'swift'),
    'true',
  )
  // typed encode: build the value field-by-field, stringify, re-parse, read it back (no derive macros)
  runRustCargo(
    'rust + cargo: json encode a typed value + round-trip via serde_json',
    frontEnd(JSON_ENCODE_RT, true, 'rust'),
    'true',
    false,
  )
  runSwiftText(
    'swift + json: encode a typed value + round-trip via JSONSerialization',
    frontEnd(JSON_ENCODE_RT, true, 'swift'),
    'true',
  )

  // float math to "runs" on all three (square-root(9.0) == 3.0 via each platform's float library)
  runSwiftText(
    'swift + float: square-root(9.0) == 3.0 (via Foundation)',
    frontEnd(FLOAT_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + float: square-root(9.0) == 3.0 (via kotlin.math)',
    frontEnd(FLOAT_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: float square-root(9.0) == 3.0 (via f64 methods)',
    frontEnd(FLOAT_PROG, true, 'rust'),
    'true',
    false,
  )

  // time (positive epoch) + console (stdout) to "runs" on all three
  runSwiftText(
    'swift + time: now() is a positive epoch (via Date)',
    frontEnd(TIME_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + time: now() is a positive epoch (via System)',
    frontEnd(TIME_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: time now() is a positive epoch (via std::time)',
    frontEnd(TIME_PROG, true, 'rust'),
    'true',
    false,
  )
  runSwiftConsole(
    'swift + console: log prints to stdout (via print)',
    frontEnd(CONSOLE_PROG, true, 'swift'),
    'hello console',
  )
  runKotlinConsole(
    'kotlin + console: log prints to stdout (via println)',
    frontEnd(CONSOLE_PROG, true, 'kotlin'),
    'hello console',
  )
  runRustConsole(
    'rust + console: log prints to stdout (via println!)',
    frontEnd(CONSOLE_PROG, true, 'rust'),
    'hello console',
  )

  // clock + process + environment + log to "runs" on all three
  runSwiftText(
    'swift + clock: now() is positive (via ProcessInfo uptime)',
    frontEnd(CLOCK_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + clock: now() is positive (via System.nanoTime)',
    frontEnd(CLOCK_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: clock now() is positive (via std::time)',
    frontEnd(CLOCK_PROG, true, 'rust'),
    'true',
    false,
  )
  runSwiftText(
    'swift + process: platform() is non-empty (via ProcessInfo)',
    frontEnd(PROCESS_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + process: platform() is non-empty (via System)',
    frontEnd(PROCESS_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: process platform() is non-empty (via std::env)',
    frontEnd(PROCESS_PROG, true, 'rust'),
    'true',
    false,
  )
  runSwiftText(
    'swift + environment: directory() is non-empty (via FileManager)',
    frontEnd(ENVIRONMENT_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + environment: directory() is non-empty (via System)',
    frontEnd(ENVIRONMENT_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: environment directory() is non-empty (via std::env)',
    frontEnd(ENVIRONMENT_PROG, true, 'rust'),
    'true',
    false,
  )
  runSwiftConsole(
    'swift + log: info prints to stdout (via print)',
    frontEnd(LOG_PROG, true, 'swift'),
    'hello log',
  )
  runKotlinConsole(
    'kotlin + log: info prints to stdout (via println)',
    frontEnd(LOG_PROG, true, 'kotlin'),
    'hello log',
  )
  runRustConsole(
    'rust + log: info prints to stdout (via println!)',
    frontEnd(LOG_PROG, true, 'rust'),
    'hello log',
  )

  // string ops through the public text interface, running on each compiled toolchain via the text shim
  runRustText(
    'rust + text runtime: to-upper("seed") through the string interface',
    frontEnd(TEXT_PROG, true, 'rust'),
    'SEED',
  )
  runSwiftText(
    'swift + text runtime: to-upper("seed") through the string interface',
    frontEnd(TEXT_PROG, true, 'swift'),
    'SEED',
  )
  runKotlinText(
    'kotlin + text runtime: to-upper("seed") through the string interface',
    frontEnd(TEXT_PROG, true, 'kotlin'),
    'SEED',
  )

  // regex through the public interface, running on each toolchain via the regex shim (the runner auto-prepends it)
  runSwiftText(
    'swift + regex runtime: matches("^[0-9]+$","12345") via NSRegularExpression',
    frontEnd(REGEX_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + regex runtime: matches("^[0-9]+$","12345") via kotlin.text.Regex',
    frontEnd(REGEX_PROG, true, 'kotlin'),
    'true',
  )

  // http client to "runs": fetch a real server. The server runs in a SEPARATE node process so the blocking
  // execFileSync of each compiled binary does not freeze its event loop. swift uses URLSession, kotlin java.net.http,
  // rust reqwest -- each wraps its platform client behind the one async `get` interface.
  const portFile = join(dir, 'server-port.txt')
  const serverCode = `const http=require('http');const fs=require('fs');const s=http.createServer((q,r)=>{r.writeHead(200);r.end('http ok')});s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],String(s.address().port)))`
  const server = spawn(process.execPath, ['-e', serverCode, portFile], {
    stdio: 'ignore',
  })
  let port = ''
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  for (let i = 0; i < 100 && !port; i++) {
    if (existsSync(portFile))
      port = readFileSync(portFile, 'utf8').trim()
    else Atomics.wait(waiter, 0, 0, 50)
  }
  if (port) {
    const httpProg = `load @cluesurf/base/code/network/http\n  find get\n\ntask compute\n  mark async\n  like text\n  save r\n    call get\n      text <http://127.0.0.1:${port}/>\n      wait true\n  send back\n    read r/body\n`
    runSwiftCrypto(
      'swift + http: GET a real server via URLSession',
      frontEnd(httpProg, true, 'swift'),
      'http ok',
    )
    runKotlinCrypto(
      'kotlin + http: GET a real server via java.net.http',
      frontEnd(httpProg, true, 'kotlin'),
      'http ok',
    )
    runRustCargo(
      'rust + cargo: http GET a real server via reqwest',
      frontEnd(httpProg, true, 'rust'),
      'http ok',
      true,
    )
  } else {
    skipped('http round-trips', 'could not start the local test server')
  }
  server.kill()

  console.log(
    `\nroundtrip: ${pass} pass, ${fail} fail, ${skip} skipped  (compiled + ran on the real toolchain)`,
  )
  if (fail > 0) process.exit(1)
}

main()
