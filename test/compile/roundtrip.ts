// Round-trip tests: emit each native backend, compile it with the REAL toolchain (swiftc / kotlinc / clang), run the
// binary, and assert the result matches the interpreter's. This proves the backends emit code that actually compiles
// and computes correctly, not just code of the right shape. Each backend is gated on its toolchain being installed;
// a missing toolchain is reported as skipped, never a failure. Run: npx tsx test/compile/roundtrip.ts

import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@cluesurf/make/code/parser/tree'
import { mill } from '@cluesurf/make/code/compile/mill'
import { resolve as resolveNames } from '@cluesurf/make/code/check/resolve'
import { check } from '@cluesurf/make/code/check/infer'
import { simplify } from '@cluesurf/make/code/ir/simplify'
import { collectModules } from '@cluesurf/make/code/compile/load'
import type { Source } from '@cluesurf/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@cluesurf/make/code/compile/native'
import { emitSwift } from '@cluesurf/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@cluesurf/make/code/compile/kotlin'
import { emitLlvm } from '@cluesurf/make/code/compile/llvm'
import { emitRust } from '@cluesurf/make/code/compile/rust'
import { emitTypeScript } from '@cluesurf/make/code/compile/typescript'
import { LLVM_RUNTIME_RUST } from '@cluesurf/make/code/compile/llvm-runtime'
import type { Program } from '@cluesurf/make/code/compile/node'
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
const baseTree = join(process.cwd(), 'deck', 'base')
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
  // the entry module's own functions are the public roots: kept through simplification even when nothing internal
  // calls them. Stdlib wrappers are internal and may be inlined or specialized away.
  const roots = new Set<string>()
  for (const unit of sources) {
    const parsed = parse(unit)
    if (!parsed.ok) throw new Error('parse failed')
    const built = mill(parsed.tree, unit.file)
    if (!built.ok)
      throw new Error(
        'mill failed: ' +
          built.diagnostics.map(d => d.message).join(', '),
      )
    if (unit.file === 'main.tree')
      for (const node of built.program)
        if (node.form === 'function') roots.add(node.name)
    program.push(...built.program)
  }
  resolveNames(program, 'main.tree')
  check(program, 'main.tree')
  // the same IR pass the compile() driver runs before emit: forwarder inlining, constant folding, and (added here)
  // constant-selector specialization, so every backend consumes the specialized AST.
  return simplify(program, roots)
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
    hoistKotlinImports(`${emitKotlin(program)}\nfun main() { println(${callExpr}) }\n`),
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
    hoistKotlinImports(`${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}${main}`),
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
    hoistKotlinImports(`${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}\nfun main() { print(compute()) }\n`),
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
    hoistKotlinImports(`${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}\nsuspend fun main() { print(compute()) }\n`),
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
    hoistKotlinImports(`${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}\nfun main() { print(compute()) }\n`),
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
    hoistKotlinImports(`${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
      program,
    )}\nfun main() { compute() }\n`),
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

// like runLlvmRust but for an i64-returning entry: link the Rust runtime (so the seed_list_* heap ops resolve) and
// assert the process exit code. Used for the list ops, whose handles live in the runtime.
function runLlvmRustExit(
  name: string,
  program: Program,
  mangledCall: string,
  want: number,
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
  const main = `\ndefine i32 @main() {\n  %r = call i64 ${mangledCall}\n  %t = trunc i64 %r to i32\n  ret i32 %t\n}\n`
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
  ok(name, spawnSync(exe).status, want)
}

// a string-returning function: a literal concatenation, lowered to the runtime's seed_str_concat
const GREETING = `task greeting\n  like text\n  send back\n    call add\n      text <hello >\n      text <world>\n`

// a list reaching LLVM: build a list, push three integers, read element 1 (at) and the length (count). 20 + 3 = 23.
// Exercises the seed_list_* heap runtime (new / push / at / length) -- the imperative integer-list capability.
const LIST_LLVM = `load @cluesurf/base/code/list
  find list
  find push
  find get
  find count

task compute
  like number
  save xs
    make list
  call push
    read xs
    code 10
  call push
    read xs
    code 20
  call push
    read xs
    code 30
  save n
    call get
      read xs
      code 1
  send back
    call add
      read n
      call count
        read xs
`

// a map on LLVM: build a hash, set two keys plus a duplicate, read the size. The seed_map_* runtime canonicalizes keys
// by value, so 1 -> ... twice counts once: size is 2. Exercises seed_map_new / set / size.
const HASH_LLVM = `load @cluesurf/base/code/hash
  find hash

task compute
  like number
  save m
    make find
  call set
    read m
    code 1
    code 100
  call set
    read m
    code 2
    code 200
  call set
    read m
    code 1
    code 300
  send back
    call size
      read m
`

// a list through the closure-taking ops on LLVM: [1,2,3] -> map(*2) -> [2,4,6] -> reduce(+, 0) -> 12. The list
// runtime calls each closure back per element (its { code, env } passed as two pointers).
const LIST_FOLD_LLVM = `load @cluesurf/base/code/list
  find list
  find push
  find map
  find reduce

task compute
  like number
  save xs
    make list
  call push
    read xs
    code 1
  call push
    read xs
    code 2
  call push
    read xs
    code 3
  save doubled
    call map
      read xs
      task double
        take item, like number
        like number
        send back
          call multiply
            read item
            code 2
  send back
    call reduce
      read doubled
      task add-up
        take total, like number
        take item, like number
        like number
        send back
          call add
            read total
            read item
      code 0
`

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
            code 2
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
                code 3
      read seed
`
// a closure that CAPTURES an outer variable (`seed`) and is invoked through a higher-order task: the `move` closure
// owns its capture, so it is `'static` and storable as a `Box<dyn Fn>`. apply(adder, 10) with seed = 7 -> 17.
const CAPTURE = `task apply
  take f
    like task
      take n, like number
      like number
  take x, like number
  like number
  send back
    call f
      read x

task compute
  take seed
  like number
  send back
    call apply
      task adder
        take n, like number
        like number
        send back
          call add
            read n
            read seed
      code 10
`

// generic trait-bounded dispatch on a native backend: a trait (`mask`) with two instances, and one generic function
// bounded by it that calls a trait method on its type parameter. On Rust this emits a native `trait` + `impl` blocks +
// a `T: Sizer` bound, so `run` dispatches box.measure()=7 and circle.measure()=9 through one generic `describe` -> 16.
const TRAIT_GENERIC = `mask sizer
  task measure
    take self
    like number

form box
  link n, like number
  wear sizer
    task measure
      take self
      like number
      send back
        read self/n

form circle
  link r, like number
  wear sizer
    task measure
      take self
      like number
      send back
        read self/r

task describe
  head t, need sizer
  take x, like t
  like number
  send back
    call measure
      read x

task run
  like number
  save a
    call describe
      make box
        bind n
          code 7
  save b
    call describe
      make circle
        bind r
          code 9
  send back
    call add
      read a
      read b
`

// a sum type (variant / enum) on LLVM: build a tagged value, match on it, read the payload. `make full` is tag 0 with
// payload 7; the match reads the tag, takes the `full` arm, returns the payload -> 7. (Tagged union { i64, i64 }.)
const VARIANT = `form box
  case full
    link value, like number
  case empty

task make-box
  take flag, like boolean
  like box
  fork test
    hook test
      read flag
    hook hold
      send back
        make full
          bind value
            code 7
    hook miss
      send back
        make empty

task compute
  like number
  save b
    call make-box
      wave true
  fork case, read b
    case full
      send back
        read b/value
    case empty
      send back
        code 0
`

// a value-position conditional (a `fork` used as the returned value) with an else-if chain: grade(70) takes the second
// branch -> 2. On llvm this lowers to a result alloca written from each arm's block, loaded at the merge (no phi).
const VALUE_COND = `task grade
  take n, like number
  like number
  send back
    fork test
      hook test
        call is-above
          read n
          code 90
      hook hold
        code 1
      hook test
        call is-above
          read n
          code 50
      hook hold
        code 2
      hook miss
        code 3
`

// a generic function reaching a monomorphic backend: identity<t> called at a number. LLVM has no type parameters, so
// monomorphization must specialize identity at i64 and rewrite the call, or the function would be dropped. compute -> 42.
const GENERIC = `task identity
  head t
  take x, like t
  like t
  send back
    read x

task compute
  like number
  send back
    call identity
      code 42
`

// a plain record reaching LLVM: build a struct, pass it by value, read a field. LLVM lowers it to a first-class
// %struct value (insertvalue to build, extractvalue to read) -- no heap. compute -> 35.
const RECORD = `form point
  link x, like number
  link y, like number

task make-point
  take a, like number
  take b, like number
  like point
  send back
    make point
      bind x, read a
      bind y, read b

task compute
  like number
  save p
    call make-point
      code 7
      code 35
  send back
    read p/y
`

const FIB = `task find-fibonacci-via-loop
  take n
  save a, code 0
  save b, code 1
  walk test
    hook test
      call is-above
        loan n
        code 0
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
          code 1
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
      bind value, code 41
  save total
    call unwrap-or
      read m
      code 0
  save e
    make none
  save total
    call add
      read total
      call unwrap-or
        read e
        code 7
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
      code 2
      code 10
`

// a digest computed through the PUBLIC interface: sha256("abc") resolves to the declarative `bind` map, which inlines
// the per-backend native call (sha2 crate on rust, CryptoKit on swift, ...). The `platform` arg is unused now that the
// binding is per-backend in one place; kept so the caller's per-platform loop is unchanged.
const cryptoProgram = (
  _platform: string,
) => `load @cluesurf/base/code/cryptography/digest
  find sha256

load @cluesurf/base/code/bytes
  find from-text
  find to-hex

task compute
  mark async
  like text
  send back
    call to-hex
      call sha256
        call from-text
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

load @cluesurf/base/code/bytes
  find from-text
  find to-hex

task compute
  mark async
  like text
  send back
    call to-hex
      call sha256
        call from-text
          text <key>
        call from-text
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
      code 5
      code 5
`
// secure random: two 16-byte draws differ (the OS-backed generator is not a constant). The draws are raw bytes (the
// crypto currency); hex-encode each at the edge so the comparison is by value on every platform (a raw-buffer != would
// be a reference compare on node / kotlin). Asserted as a boolean to stay print-format agnostic. Exercises the inlined
// random-bytes bind on each platform (rust OsRng, swift system RNG, kotlin SecureRandom).
const SECURE_RANDOM_PROG = `load @cluesurf/base/code/cryptography/random
  find bytes

load @cluesurf/base/code/bytes
  find to-hex

task compute
  like boolean
  send back
    call is-unequal
      call to-hex
        call bytes
          code 16
      call to-hex
        call bytes
          code 16
`
// the bytes currency type as a native buffer: text "ab" + "cd" concatenated, hex-encoded, equals "61626364". The data
// is a byte vector / Data / ByteArray the whole way through, hex only at the edge. Boolean so it is print-agnostic.
const BYTES_PROG = `load @cluesurf/base/code/bytes
  find from-text
  find to-hex
  find concat

task compute
  like boolean
  send back
    call is-equal
      call to-hex
        call concat
          call from-text
            text <ab>
          call from-text
            text <cd>
      text <61626364>
`
// AES-256-GCM: encrypt a plaintext then decrypt it, asserting the round-trip recovers the original (boolean, so it is
// print-format agnostic). Key is 32 bytes / 64 hex, nonce is 12 bytes / 24 hex. Exercises each platform's AEAD
// library (rust aes-gcm, swift CryptoKit AES.GCM, kotlin javax.crypto), all agreeing on the ciphertext || tag layout.
const CIPHER_PROG = `load @cluesurf/base/code/cryptography/cipher
  find encrypt
  find decrypt

load @cluesurf/base/code/bytes
  find from-text
  find to-text
  find from-hex

task compute
  mark async
  like boolean
  save sealed
    call encrypt
      call from-hex
        text <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff>
      call from-hex
        text <000102030405060708090a0b>
      call from-text
        text <attack at dawn>
      wait true
  save opened
    call decrypt
      call from-hex
        text <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff>
      call from-hex
        text <000102030405060708090a0b>
      read sealed
      wait true
  send back
    call is-equal
      call to-text
        read opened
      text <attack at dawn>
`
// Ed25519 signatures: generate a key pair, sign a message, verify it (boolean round-trip, print-format agnostic).
// Exercises each platform's Ed25519 (rust ed25519-dalek, swift CryptoKit Curve25519, kotlin java.security).
const SIGNATURE_PROG = `load @cluesurf/base/code/cryptography/signature
  find make-key-pair
  find sign
  find verify

load @cluesurf/base/code/bytes
  find from-text

task compute
  mark async
  like boolean
  save pair
    call make-key-pair
      wait true
  save proof
    call sign
      read pair/private-key
      call from-text
        text <ship sails at noon>
      wait true
  send back
    call verify
      read pair/public-key
      call from-text
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
// directory list: make a directory with one child, list it, and count the entries by walking the result. Exercises
// the list-typed native return (Vec<String> / [String] / MutableList<String>) plus native list iteration on each
// backend. The walk avoids reducing through the list form, which does not yet apply to a raw native array.
const DIR_LIST_PROG = `load @cluesurf/base/code/file/directory
  find make
  find remove
  find list

task compute
  like boolean
  call remove
    text </tmp/seed-roundtrip-listdir>
  call make
    text </tmp/seed-roundtrip-listdir/alpha>
  save entries
    call list
      text </tmp/seed-roundtrip-listdir>
  save count, code 0
  walk list, read entries
    hook next
      take site, name item
      save count
        call add
          read count
          code 1
  send back
    call is-equal
      read count
      code 1
`
// directory walk: make a nested directory tree, walk it recursively, and count the entries. Exercises each platform's
// recursive enumerator (rust std::fs recursion, swift FileManager.enumerator, kotlin walkTopDown) returning a list.
const DIR_WALK_PROG = `load @cluesurf/base/code/file/directory
  find make
  find remove
  find walk

task compute
  like boolean
  call remove
    text </tmp/seed-roundtrip-walkdir>
  call make
    text </tmp/seed-roundtrip-walkdir/aaa/bbb>
  save entries
    call walk
      text </tmp/seed-roundtrip-walkdir>
  save count, code 0
  walk list, read entries
    hook next
      take item, name value
      save count
        call add
          read count
          code 1
  send back
    call is-equal
      read count
      code 2
`
// path: join a base and a name, then read the last segment back. Exercises the path shim (node path, rust std::path,
// swift Foundation, kotlin java.io.File). Asserted as a boolean over the exact cross-platform result.
const PATH_JOIN_PROG = `load @cluesurf/base/code/path
  find join
  find file-name

task compute
  like boolean
  send back
    call is-equal
      call file-name
        call join
          text </a/b>
          text <c.json>
      text <c.json>
`
// path: a file extension carries its leading dot, the same on every platform.
const PATH_EXTENSION_PROG = `load @cluesurf/base/code/path
  find file-extension

task compute
  like boolean
  send back
    call is-equal
      call file-extension
        text </a/b/report.txt>
      text <.txt>
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
      code 2026
      code 6
      code 19
      code 12
      code 34
      code 56
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
            code 1
        code 7
`
// X25519 ECDH: two key pairs derive the same shared secret from opposite sides (the agreement property), asserted as
// a boolean. Exercises each platform's X25519 (rust x25519-dalek, swift CryptoKit, kotlin java.security).
const KEY_AGREEMENT_PROG = `load @cluesurf/base/code/cryptography/key-agreement
  find make-key-pair
  find shared-secret

load @cluesurf/base/code/bytes
  find to-hex

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
      call to-hex
        read ab
      call to-hex
        read ba
`
// dns: resolving a numeric IP returns it, through each platform's resolver (rust std::net, swift getaddrinfo, kotlin
// InetAddress). Offline and deterministic, asserted as a boolean.
const DNS_PROG = `load @cluesurf/base/code/network/dns
  find resolve-one

task compute
  mark async
  like boolean
  save ip
    call resolve-one
      text <127.0.0.1>
      wait true
  send back
    call is-equal
      read ip
      text <127.0.0.1>
`
// collection: build two sets, intersect them, check the size. Exercises the native map runtime (set / has / size /
// keys) plus mutable-collection construction and walk on each platform's reference-typed map. Asserted as a boolean.
const COLLECTION_PROG = `load @cluesurf/base/code/set
  find set

task compute
  like boolean
  save a
    make set
      bind items
        make find
  call insert
    read a
    code 1
  call insert
    read a
    code 2
  call insert
    read a
    code 3
  save b
    make set
      bind items
        make find
  call insert
    read b
    code 2
  call insert
    read b
    code 3
  call insert
    read b
    code 4
  send back
    call is-equal
      call size
        call intersect
          read a
          read b
      code 2
`
// list: build a list with push (in-place mutation persists), map it through a closure, then reduce. Exercises the
// native list runtime -- mutation, the closure-taking ops (map / reduce), and `Box<dyn Fn>` / lambda closures.
// [1,2,3] -> map(*2) -> [2,4,6] -> reduce(+, 0) -> 12.
const LIST_PROG = `load @cluesurf/base/code/list
  find list

task compute
  like number
  save xs
    make list
  call push
    read xs
    code 1
  call push
    read xs
    code 2
  call push
    read xs
    code 3
  save doubled
    call map
      read xs
      task double
        take item, like number
        like number
        send back
          call multiply
            read item
            code 2
  send back
    call reduce
      read doubled
      task add-up
        take total, like number
        take item, like number
        like number
        send back
          call add
            read total
            read item
      code 0
`
// list set: in-place index write through the native splice op (rust Vec::splice, swift replaceSubrange, kotlin subList)
const LIST_SET_PROG = `load @cluesurf/base/code/list
  find list
  find set
  find get

task compute
  like number
  save xs
    make list
  call push
    read xs
    code 10
  call push
    read xs
    code 20
  call push
    read xs
    code 30
  call set
    read xs
    code 1
    code 99
  send back
    call get
      read xs
      code 1
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
          code 1
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
// arc-trig: arc-cosine(1.0) == 0.0 through each platform's float library (Math.acos / f64.acos / Foundation / kotlin.math)
const TRIG_PROG = `load @cluesurf/base/code/float
  find arc-cosine

task compute
  like boolean
  send back
    call is-equal
      call arc-cosine
        1.0
      0.0
`
// vector-3: length(3,4,0) == 5 through the concrete float vector form
const VECTOR3_PROG = `load @cluesurf/base/code/line/float/32/vector-3
  find make-vector-3
  find length

task compute
  like boolean
  send back
    call is-equal
      call length
        call make-vector-3
          3.0
          4.0
          0.0
      5.0
`
// quaternion: length(1,2,2,0) == 3 through the concrete float quaternion form
const QUATERNION_PROG = `load @cluesurf/base/code/line/float/32/quaternion
  find make-quaternion
  find length

task compute
  like boolean
  send back
    call is-equal
      call length
        call make-quaternion
          1.0
          2.0
          2.0
          0.0
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
      code 0
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
      code 0
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

// the specialization + bind vertical slice. `logarithm` is a verb whose value-position `fork test` dispatches on the
// base to one of three declarative native binds. The convenience form `logarithm-base-2` fixes the base, so a call to
// it specializes: the base==2 branch folds, the verb drops, and the surviving bind renders the platform's native log2
// (`Math.log2` on node, `.log2()` on rust) with no division. `compute` returns log2(8) = 3.
// the enum-verb specialization slice. `describe` dispatches a `fork case` on its parameter. `compute` calls it with the
// constant variant `make warm`, so the verb inlines, the match folds to the matching arm, and `compute` reduces to that
// arm's value. No switch survives in the emitted code.
const ENUM_SPEC_PROG = `form tone
  case warm
  case cool

task describe
  take thing, like tone
  like text
  fork case
    read thing
    case warm
      send back
        text <fire>
    case cool
      send back
        text <ice>

task compute
  like text
  send back
    call describe
      make warm
`

const LOGARITHM_PROG = `bind logarithm-base-2-native
  take value, like float
  like float
  case node
    text <Math.log2($value)>
  case rust
    text <$value.log2()>

bind logarithm-base-10-native
  take value, like float
  like float
  case node
    text <Math.log10($value)>
  case rust
    text <$value.log10()>

bind logarithm-natural-native
  take value, like float
  like float
  case node
    text <Math.log($value)>
  case rust
    text <$value.ln()>

task logarithm
  take value, like float
  take base, like float
  like float
  send back
    fork test
      hook test
        call is-equal
          read base
          2.0
      hook hold
        call logarithm-base-2-native
          read value
      hook test
        call is-equal
          read base
          10.0
      hook hold
        call logarithm-base-10-native
          read value
      hook miss
        call logarithm-natural-native
          read value

task logarithm-base-2
  take value, like float
  like float
  send back
    call logarithm
      read value
      2.0

task compute
  take value, like float
  like float
  send back
    call logarithm-base-2
      read value
`

// run the emitted TypeScript on node: write the module, append a print of the given call, execute through node's native
// type stripping, assert stdout
function runNodeExpr(
  name: string,
  program: Program,
  call: string,
  want: string,
): void {
  const file = join(dir, `${name.replace(/\W/g, '')}.ts`)
  writeFileSync(
    file,
    `${emitTypeScript(program)}\nconsole.log(${call})\n`,
  )
  ok(
    name,
    execFileSync('node', ['--experimental-strip-types', file])
      .toString()
      .trim(),
    want,
  )
}

// run the emitted Rust on rustc: print the given call (Display prints 3.0 as "3"), assert stdout
function runRustExpr(
  name: string,
  program: Program,
  call: string,
  want: string,
): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(
    file,
    `${emitRust(program)}\nfn main() { print!("{}", ${call}); }\n`,
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

function main(): void {
  const fib = frontEnd(FIB)
  runLlvm(
    'llvm: iterative fibonacci (mutation + while)',
    fib,
    '@find_fibonacci_via_loop(i64 10)',
    55,
  )
  // llvm sum type: build a variant, match on the tag, read the payload -> 7 (tagged union { tag, payload })
  runLlvm(
    'llvm: variant build + match + payload read (tagged union)',
    frontEnd(VARIANT),
    '@compute()',
    7,
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
  // llvm value-position conditional: grade(70) -> 2 through the else-if chain (result alloca + branch blocks, no phi)
  runLlvm(
    'llvm: value-position conditional (fork as a value)',
    frontEnd(VALUE_COND),
    '@grade(i64 70)',
    2,
  )
  // llvm monomorphization: a generic identity specialized at i64 and called -> 42 (generic would be dropped otherwise)
  runLlvm(
    'llvm: monomorphized generic function',
    frontEnd(GENERIC),
    '@compute()',
    42,
  )
  // llvm record: a struct built (insertvalue), passed by value, and a field read (extractvalue) -> 35
  runLlvm(
    'llvm: record build + field read (first-class struct)',
    frontEnd(RECORD),
    '@compute()',
    35,
  )
  // llvm list: build an integer list, push, read element 1 + length through the seed_list_* heap runtime -> 23
  runLlvmRustExit(
    'llvm + rust runtime: integer list build + at + count',
    frontEnd(LIST_LLVM, true),
    '@compute()',
    23,
  )
  // llvm closure: a closure capturing an outer variable, passed to a higher-order fn and called indirectly. The env is
  // a seed_list of captured words, so the runtime is linked. compute(7) = adder(10) with captured seed 7 -> 17.
  runLlvmRustExit(
    'llvm + rust runtime: closure capture via indirect call',
    frontEnd(CAPTURE),
    '@compute(i64 7)',
    17,
  )
  // llvm list closure ops: map then reduce, the runtime calling each closure back per element. [1,2,3]*2 summed -> 12
  runLlvmRustExit(
    'llvm + rust runtime: list map + reduce (closure callbacks)',
    frontEnd(LIST_FOLD_LLVM, true),
    '@compute()',
    12,
  )
  // llvm map: set two distinct keys + one duplicate, then read the size -> 2 (verifies the seed_map_* heap runtime and
  // that keys are compared by value, so the duplicate key does not grow the map).
  runLlvmRustExit(
    'llvm + rust runtime: map set (dedup) + size',
    frontEnd(HASH_LLVM, true),
    '@compute()',
    2,
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
    'rust: a move closure capturing an outer variable',
    frontEnd(CAPTURE),
    'compute(7)',
    17,
  )
  runRust(
    'rust: a closure stored in a struct field, called through it',
    frontEnd(HANDLER),
    'compute(6)',
    18,
  )
  runRust(
    'rust: generic trait-bounded dispatch (native trait + impls)',
    frontEnd(TRAIT_GENERIC),
    'run()',
    16,
  )
  runSwift(
    'swift: generic trait-bounded dispatch (protocol + extensions)',
    frontEnd(TRAIT_GENERIC),
    'run()',
    16,
  )
  runKotlin(
    'kotlin: generic trait-bounded dispatch (interface + overrides)',
    frontEnd(TRAIT_GENERIC),
    'run()',
    16,
  )
  runLlvm(
    'llvm: generic trait-bounded dispatch (monomorphized to instance calls)',
    frontEnd(TRAIT_GENERIC),
    '@run()',
    16,
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

  // math through the declarative `bind` interface (no per-env shim): power(2,10) specializes to each target's native
  // power expression and runs for real
  runNodeExpr(
    'node + math bind: power(2,10) inline Math.pow',
    frontEnd(MATH_PROG, true, 'node'),
    'compute()',
    '1024',
  )
  runRustMath(
    'rust + math bind: power(2,10) inline native pow',
    frontEnd(MATH_PROG, true, 'rust'),
    '1024',
  )
  runSwiftMath(
    'swift + math bind: power(2,10) inline native pow',
    frontEnd(MATH_PROG, true, 'swift'),
    '1024',
  )
  runKotlinMath(
    'kotlin + math bind: power(2,10) inline native pow',
    frontEnd(MATH_PROG, true, 'kotlin'),
    '1024',
  )

  // specialization + bind vertical slice: a constant-base logarithm folds to the platform's native log2, end to end
  const logProgram = frontEnd(LOGARITHM_PROG)
  const logTs = emitTypeScript(logProgram)
  ok(
    'specialize: node logarithm-base-2 folds the verb to native Math.log2',
    /function logarithmBase2\(value[^)]*\)[^{]*\{\s*return Math\.log2\(value\)/.test(
      logTs,
    ),
    true,
  )
  ok(
    'specialize: declarative binds emit no function declaration',
    !/function logarithmBase2Native/.test(logTs),
    true,
  )
  const logRust = emitRust(logProgram)
  ok(
    'specialize: rust logarithm-base-2 folds the verb to native .log2()',
    /fn logarithm_base_2\(value[^)]*\)[^{]*\{[\s\S]*?value\.log2\(\)/.test(
      logRust,
    ),
    true,
  )
  runNodeExpr(
    'node: logarithm-base-2(8) through specialization',
    logProgram,
    'compute(8.0)',
    '3',
  )
  runRustExpr(
    'rust: logarithm-base-2(8) through specialization',
    logProgram,
    'compute(8.0)',
    '3',
  )

  // enum-verb specialization: a fork case verb called with a constant variant folds to the matching arm
  const enumProgram = frontEnd(ENUM_SPEC_PROG)
  const enumTs = emitTypeScript(enumProgram)
  ok(
    'specialize: node enum verb folds to the matching arm, no switch',
    /function compute\(\)[^{]*\{\s*return "fire"/.test(enumTs) &&
      !/function compute[\s\S]*?switch/.test(enumTs),
    true,
  )
  runNodeExpr(
    'node: describe(make warm) through enum specialization',
    enumProgram,
    'compute()',
    'fire',
  )
  runRustExpr(
    'rust: describe(make warm) through enum specialization',
    enumProgram,
    'compute()',
    'fire',
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
  // the bytes currency type as a native buffer (rust Vec<u8>, swift Data, kotlin ByteArray), hex only at the edge
  runSwiftText(
    'swift + bytes: concat + hex over Foundation Data',
    frontEnd(BYTES_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + bytes: concat + hex over ByteArray',
    frontEnd(BYTES_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: bytes concat + hex over a Vec<u8> (zero-copy currency)',
    frontEnd(BYTES_PROG, true, 'rust'),
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
  // directory list: the list-typed native return, walked and counted
  runSwiftText(
    'swift + file/directory: list one entry, counted by walk (contentsOfDirectory)',
    frontEnd(DIR_LIST_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + file/directory: list one entry, counted by walk (java.io.File.list)',
    frontEnd(DIR_LIST_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: file/directory list one entry, counted by walk (std::fs::read_dir)',
    frontEnd(DIR_LIST_PROG, true, 'rust'),
    'true',
    false,
  )
  // directory walk: recursive enumeration returns the nested entries, counted
  runSwiftText(
    'swift + file/directory: walk a nested tree (FileManager.enumerator)',
    frontEnd(DIR_WALK_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + file/directory: walk a nested tree (File.walkTopDown)',
    frontEnd(DIR_WALK_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: file/directory walk a nested tree (std::fs recursion)',
    frontEnd(DIR_WALK_PROG, true, 'rust'),
    'true',
    false,
  )
  // path: join + file-name compose to the exact same result on every platform
  runSwiftText(
    'swift + path: join then file-name (Foundation NSString)',
    frontEnd(PATH_JOIN_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + path: join then file-name (java.io.File)',
    frontEnd(PATH_JOIN_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: path join then file-name (std::path)',
    frontEnd(PATH_JOIN_PROG, true, 'rust'),
    'true',
    false,
  )
  // path: file extension carries its leading dot identically across platforms
  runSwiftText(
    'swift + path: file-extension carries its dot (Foundation)',
    frontEnd(PATH_EXTENSION_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + path: file-extension carries its dot (java.io.File)',
    frontEnd(PATH_EXTENSION_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: path file-extension carries its dot (std::path)',
    frontEnd(PATH_EXTENSION_PROG, true, 'rust'),
    'true',
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
  // dns: resolve a numeric IP to itself through each platform's resolver (offline, deterministic)
  runSwiftCrypto(
    'swift + network/dns: resolve-one of a numeric IP (getaddrinfo)',
    frontEnd(DNS_PROG, true, 'swift'),
    'true',
  )
  runKotlinCrypto(
    'kotlin + network/dns: resolve-one of a numeric IP (InetAddress)',
    frontEnd(DNS_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: network/dns resolve-one of a numeric IP (std::net)',
    frontEnd(DNS_PROG, true, 'rust'),
    'true',
    true,
  )
  // collections: the native map runtime on every strict backend. The map is reference-typed on each (kotlin
  // MutableMap, rust Rc<RefCell<HashMap>>, swift a SeedMap class wrapper), so the mutable set form -- which mutates
  // `self.items` for its side effect -- runs uniformly.
  runKotlinText(
    'kotlin + collection: set intersect size via the native map runtime (MutableMap)',
    frontEnd(COLLECTION_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: collection set intersect size via the native map runtime (Rc<RefCell<HashMap>>)',
    frontEnd(COLLECTION_PROG, true, 'rust'),
    'true',
    false,
  )
  runSwiftText(
    'swift + collection: set intersect size via the native map runtime (SeedMap class)',
    frontEnd(COLLECTION_PROG, true, 'swift'),
    'true',
  )
  // list: push mutation + map / reduce closures through the native list runtime
  runKotlinText(
    'kotlin + list: push + map + reduce ([1,2,3]*2 folded == 12)',
    frontEnd(LIST_PROG, true, 'kotlin'),
    '12',
  )
  runRustCargo(
    'rust + cargo: list push + map + reduce ([1,2,3]*2 folded == 12)',
    frontEnd(LIST_PROG, true, 'rust'),
    '12',
    false,
  )
  runSwiftText(
    'swift + list: push + map + reduce ([1,2,3]*2 folded == 12)',
    frontEnd(LIST_PROG, true, 'swift'),
    '12',
  )
  // list set: in-place index write via the native splice op
  runKotlinText(
    'kotlin + list: set index 1 to 99 via splice',
    frontEnd(LIST_SET_PROG, true, 'kotlin'),
    '99',
  )
  runRustCargo(
    'rust + cargo: list set index 1 to 99 via splice',
    frontEnd(LIST_SET_PROG, true, 'rust'),
    '99',
    false,
  )
  runSwiftText(
    'swift + list: set index 1 to 99 via splice',
    frontEnd(LIST_SET_PROG, true, 'swift'),
    '99',
  )
  // NOTE: the iterator (walk) runs on node (test/tree/walk.tree) but cannot yet round-trip on the strict backends for
  // the SAME reason as deque below: a generic `head t` value whose method/field returns `maybe<t>` emits a raw `Maybe`
  // (no type argument) because `t` is not monomorphized to the concrete element. Fixing this one monomorphization gap
  // unblocks the whole generic-container family (walk, deque, queue, stack) cross-backend.
  // NOTE: a cross-backend deque round-trip (push-front/back via shift/unshift) is blocked not by those ops -- list.set
  // above proves splice/shift/unshift lower on every backend -- but by a separate compiler gap: a generic `head t`
  // container started from an empty list leaves `t` unbound, so a strict backend cannot unify its `maybe<t>` return
  // with the concrete element type. The same affects queue / stack. Tracked for the monomorphization pass. deque runs
  // on node today (test/tree/deque.tree).
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

  // arc-trigonometry to "runs" on all three (arc-cosine(1) == 0 via each float library)
  runSwiftText(
    'swift + float: arc-cosine(1.0) == 0.0 (via Foundation)',
    frontEnd(TRIG_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + float: arc-cosine(1.0) == 0.0 (via kotlin.math)',
    frontEnd(TRIG_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: float arc-cosine(1.0) == 0.0 (via f64 methods)',
    frontEnd(TRIG_PROG, true, 'rust'),
    'true',
    false,
  )

  // linear algebra (concrete float forms) to "runs" on all three: vector-3 + quaternion length
  runSwiftText(
    'swift + vector-3: length(3,4,0) == 5',
    frontEnd(VECTOR3_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + vector-3: length(3,4,0) == 5',
    frontEnd(VECTOR3_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: vector-3 length(3,4,0) == 5',
    frontEnd(VECTOR3_PROG, true, 'rust'),
    'true',
    false,
  )
  runSwiftText(
    'swift + quaternion: length(1,2,2,0) == 3',
    frontEnd(QUATERNION_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + quaternion: length(1,2,2,0) == 3',
    frontEnd(QUATERNION_PROG, true, 'kotlin'),
    'true',
  )
  runRustCargo(
    'rust + cargo: quaternion length(1,2,2,0) == 3',
    frontEnd(QUATERNION_PROG, true, 'rust'),
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
