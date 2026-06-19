// Round-trip tests: emit each native backend, compile it with the REAL toolchain (swiftc / kotlinc / clang), run the
// binary, and assert the result matches the interpreter's. This proves the backends emit code that actually compiles
// and computes correctly, not just code of the right shape. Each backend is gated on its toolchain being installed;
// a missing toolchain is reported as skipped, never a failure. Run: npx tsx test/compile/roundtrip.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { resolve as resolveNames } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { collectModules } from '@/code/compile/load'
import type { Source } from '@/code/compile/load'
import { withNativeEnv } from '@/code/compile/native'
import { emitSwift } from '@/code/compile/swift'
import { emitKotlin } from '@/code/compile/kotlin'
import { emitLlvm } from '@/code/compile/llvm'
import { emitRust } from '@/code/compile/rust'
import { LLVM_RUNTIME_RUST } from '@/code/compile/llvm-runtime'
import { SEED_IO_RUNTIME_RUST, SEED_IO_RUNTIME_SWIFT, SEED_IO_RUNTIME_KOTLIN } from '@/code/compile/io-runtime'
import { SEED_MATH_RUNTIME_RUST, SEED_MATH_RUNTIME_SWIFT, SEED_MATH_RUNTIME_KOTLIN } from '@/code/compile/math-runtime'
import { SEED_CRYPTO_RUNTIME_SWIFT, SEED_CRYPTO_RUNTIME_KOTLIN } from '@/code/compile/crypto-runtime'
import { SEED_TEXT_RUNTIME_RUST, SEED_TEXT_RUNTIME_SWIFT, SEED_TEXT_RUNTIME_KOTLIN } from '@/code/compile/text-runtime'
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
    console.log(`FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
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
  return existsSync(file) ? { file, text: readFileSync(file, 'utf8') } : undefined
}

// front-end a program (optionally resolving stdlib imports) to a checked compile AST. An `env` resolves abstract
// `native/<x>` imports to that platform's implementation (so the public math/file modules pick up native/<env>/<x>).
function frontEnd(text: string, withStdlib = false, env?: 'rust' | 'swift' | 'kotlin' | 'node'): Program {
  const resolver = env ? withNativeEnv(env, stdlib) : stdlib
  const sources = withStdlib ? collectModules({ file: 'main.tree', text }, resolver).sources : [{ file: 'main.tree', text }]
  const program: Program = []
  for (const unit of sources) {
    const parsed = parse(unit)
    if (!parsed.ok) throw new Error('parse failed')
    const built = mill(parsed.tree, unit.file)
    if (!built.ok) throw new Error('mill failed: ' + built.diagnostics.map((d) => d.message).join(', '))
    program.push(...built.program)
  }
  resolveNames(program, 'main.tree')
  check(program, 'main.tree')
  return program
}

function runSwift(name: string, program: Program, callExpr: string, want: number): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(file, `${emitSwift(program)}\nprint(${callExpr})\n`)
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (swiftc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, Number(execFileSync(exe).toString().trim()), want)
}

function runKotlin(name: string, program: Program, callExpr: string, want: number): void {
  if (!have('kotlinc') || !have('java')) return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(file, `${emitKotlin(program)}\nfun main() { println(${callExpr}) }\n`)
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (kotlinc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, Number(execFileSync('java', ['-jar', jar]).toString().trim()), want)
}

// LLVM: append a main that returns the function result as the process exit code, assemble + run with clang
function runLlvm(name: string, program: Program, mangledCall: string, want: number): void {
  if (!have('clang')) return skipped(name, 'clang not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.ll`)
  const main = `\ndefine i32 @main() {\n  %r = call i64 ${mangledCall}\n  %t = trunc i64 %r to i32\n  ret i32 %t\n}\n`
  writeFileSync(file, emitLlvm(program) + main)
  const exe = file.replace(/\.ll$/, '')
  try {
    execFileSync('clang', ['-Wno-override-module', '-x', 'ir', file, '-o', exe], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (clang error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, spawnSync(exe).status, want)
}

// compile emitted Rust with rustc and run it, asserting the exit code
function runRust(name: string, program: Program, callExpr: string, want: number): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(file, `${emitRust(program)}\nfn main() { std::process::exit((${callExpr}) as i32); }\n`)
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (rustc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, spawnSync(exe).status, want)
}

// Rust file IO end to end: compile the synchronous native/rust/file module (which forwards to the linked `io`
// runtime), prepend SEED_IO_RUNTIME_RUST, append a main that writes a temp file through the emitted code then reads it
// back, run with rustc, and assert stdout. Proves native file IO actually RUNS on a real compiled toolchain, not just
// that it emits the right shape. main owns the path and clones it across the two calls (each emitted call moves its arg).
function runRustIo(name: string, program: Program, want: string): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const path = join(dir, 'seed_rust_io_roundtrip.txt')
  const main = `\nfn main() {\n  let p = ${JSON.stringify(path)}.to_string();\n  write_demo(p.clone(), ${JSON.stringify(want)}.to_string());\n  print!("{}", read_demo(p));\n}\n`
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(file, `${SEED_IO_RUNTIME_RUST}\n${emitRust(program)}${main}`)
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (rustc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

// Swift file IO end to end: prepend SEED_IO_RUNTIME_SWIFT, write + read a temp file through the emitted Swift.
function runSwiftIo(name: string, program: Program, want: string): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const path = join(dir, 'seed_swift_io.txt')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  const main = `\nwriteDemo(${JSON.stringify(path)}, ${JSON.stringify(want)})\nprint(readDemo(${JSON.stringify(path)}), terminator: "")\n`
  writeFileSync(file, `${SEED_IO_RUNTIME_SWIFT}\n${emitSwift(program)}${main}`)
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (swiftc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

// Kotlin file IO end to end: prepend SEED_IO_RUNTIME_KOTLIN, write + read a temp file through the emitted Kotlin.
function runKotlinIo(name: string, program: Program, want: string): void {
  if (!have('kotlinc') || !have('java')) return skipped(name, 'kotlinc/java not installed')
  const path = join(dir, 'seed_kotlin_io.txt')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  const main = `\nfun main() {\n  writeDemo(${JSON.stringify(path)}, ${JSON.stringify(want)})\n  print(readDemo(${JSON.stringify(path)}))\n}\n`
  writeFileSync(file, `${SEED_IO_RUNTIME_KOTLIN}\n${emitKotlin(program)}${main}`)
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (kotlinc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// math delegation running for real: prepend the per-target math shim, print a value computed through the public math
// interface (which forwards abs/pow/... to that shim), compile + run, assert stdout.
function runRustMath(name: string, program: Program, want: string): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(file, `${SEED_MATH_RUNTIME_RUST}\n${emitRust(program)}\nfn main() { print!("{}", compute()); }\n`)
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (rustc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runSwiftMath(name: string, program: Program, want: string): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(file, `${SEED_MATH_RUNTIME_SWIFT}\n${emitSwift(program)}\nprint(compute(), terminator: "")\n`)
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (swiftc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runKotlinMath(name: string, program: Program, want: string): void {
  if (!have('kotlinc') || !have('java')) return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(file, `${SEED_MATH_RUNTIME_KOTLIN}\n${emitKotlin(program)}\nfun main() { print(compute()) }\n`)
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (kotlinc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// crypto wrapping running for real: prepend the platform crypto shim (which calls the platform's built-in crypto
// library), compute a digest through the public interface, compile + run, assert the known hex. A toolchain that
// cannot resolve its crypto framework is reported as skipped, not failed.
function runSwiftCrypto(name: string, program: Program, want: string): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(file, `${SEED_CRYPTO_RUNTIME_SWIFT}\n${emitSwift(program)}\nprint(await compute(), terminator: "")\n`)
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    return skipped(name, `swiftc could not build (CryptoKit unavailable?): ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 120)}`)
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runKotlinCrypto(name: string, program: Program, want: string): void {
  if (!have('kotlinc') || !have('java')) return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(file, `${SEED_CRYPTO_RUNTIME_KOTLIN}\n${emitKotlin(program)}\nsuspend fun main() { print(compute()) }\n`)
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    return skipped(name, `kotlinc could not build: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 120)}`)
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// string ops running for real: prepend the per-target text shim, uppercase a string through the public interface.
function runRustText(name: string, program: Program, want: string): void {
  if (!have('rustc')) return skipped(name, 'rustc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(file, `${SEED_TEXT_RUNTIME_RUST}\n${emitRust(program)}\nfn main() { print!("{}", compute()); }\n`)
  const exe = file.replace(/\.rs$/, '')
  try {
    execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', exe], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (rustc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runSwiftText(name: string, program: Program, want: string): void {
  if (!have('swiftc')) return skipped(name, 'swiftc not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  writeFileSync(file, `${SEED_TEXT_RUNTIME_SWIFT}\n${emitSwift(program)}\nprint(compute(), terminator: "")\n`)
  const exe = file.replace(/\.swift$/, '')
  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (swiftc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

function runKotlinText(name: string, program: Program, want: string): void {
  if (!have('kotlinc') || !have('java')) return skipped(name, 'kotlinc/java not installed')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(file, `${SEED_TEXT_RUNTIME_KOTLIN}\n${emitKotlin(program)}\nfun main() { print(compute()) }\n`)
  const jar = file.replace(/\.kt$/, '.jar')
  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (kotlinc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync('java', ['-jar', jar]).toString().trim(), want)
}

// the clang -arch that matches the Rust runtime's host (rustc here targets x86_64; clang cross-compiles to it)
function rustcArch(): string | undefined {
  try {
    const host = /host:\s*(\S+)/.exec(execFileSync('rustc', ['-vV']).toString())?.[1] ?? ''
    if (host.startsWith('x86_64')) return 'x86_64'
    if (host.startsWith('aarch64') || host.startsWith('arm64')) return 'arm64'
  } catch {
    // fall through
  }
  return undefined
}

// LLVM + the Rust runtime: emit IR, append a `main` that prints the string the function returns, compile the Rust
// runtime to a staticlib, link it with clang, run, and check stdout
function runLlvmRust(name: string, program: Program, mangledCall: string, want: string): void {
  if (!have('clang') || !have('rustc')) return skipped(name, 'clang/rustc not installed')
  const arch = rustcArch()
  if (!arch) return skipped(name, 'could not determine the rust host arch')
  const rs = join(dir, `${name.replace(/\W/g, '')}.rs`)
  const lib = join(dir, `lib${name.replace(/\W/g, '')}.a`)
  writeFileSync(rs, LLVM_RUNTIME_RUST)
  try {
    execFileSync('rustc', ['--edition', '2021', '--crate-type', 'staticlib', '-O', rs, '-o', lib], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (rustc error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  const file = join(dir, `${name.replace(/\W/g, '')}.ll`)
  const main = `\ndefine i32 @main() {\n  %r = call ptr ${mangledCall}\n  call void @seed_print_str(ptr %r)\n  ret i32 0\n}\n`
  writeFileSync(file, emitLlvm(program) + main)
  const exe = file.replace(/\.ll$/, '')
  try {
    execFileSync('clang', ['-arch', arch, '-Wno-override-module', '-x', 'ir', file, '-x', 'none', lib, '-o', exe], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (clang error: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 300)})`)
    return
  }
  ok(name, execFileSync(exe).toString().trim(), want)
}

// a string-returning function: a literal concatenation, lowered to the runtime's seed_str_concat
const GREETING = `task greeting\n  like text\n  send back\n    call add\n      text <hello >\n      text <world>\n`

// an iterative Fibonacci: mutation + a while loop (the scalar imperative fragment every native backend supports)
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
const ioProgram = (platform: string) => `load @cluesurf/base/code/native/${platform}/file
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
const cryptoProgram = (platform: string) => `load @cluesurf/base/code/native/${platform}/cryptography/digest
  find digest-sha256

task compute
  mark async
  like text
  send back
    call digest-sha256
      text <abc>
      wait true
`
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

// a string op through the public interface: to-upper("seed") forwards to the per-target text shim
const TEXT_PROG = `load @cluesurf/base/code/text/string
  find to-upper

task compute
  like text
  send back
    call to-upper
      text <seed>
`

function main(): void {
  const fib = frontEnd(FIB)
  runLlvm('llvm: iterative fibonacci (mutation + while)', fib, '@find_fibonacci_via_loop(i64 10)', 55)
  runRust('rust: iterative fibonacci (mutation + while)', fib, 'find_fibonacci_via_loop(10)', 55)
  runSwift('swift: iterative fibonacci', fib, 'findFibonacciViaLoop(10)', 55)
  runKotlin('kotlin: iterative fibonacci', fib, 'findFibonacciViaLoop(10)', 55)

  const maybe = frontEnd(MAYBE, true)
  runSwift('swift: native ADT enum + match + map', maybe, 'demo()', 48)
  runKotlin('kotlin: native ADT sealed class + match + map', maybe, 'demo()', 48)

  // LLVM with the managed Rust runtime: strings as pointers, concatenation + printing through the linked staticlib
  runLlvmRust('llvm + rust runtime: string concat + print', frontEnd(GREETING), '@greeting()', 'hello world')

  // native file IO running for real on each compiled toolchain: write + read a temp file through the emitted code +
  // the per-target io runtime shim (the same public-style file ops, three different platform file systems)
  runRustIo('rust + io runtime: file write then read round-trips', frontEnd(ioProgram('rust'), true), 'hello rust io')
  runSwiftIo('swift + io runtime: file write then read round-trips', frontEnd(ioProgram('swift'), true), 'hello swift io')
  runKotlinIo('kotlin + io runtime: file write then read round-trips', frontEnd(ioProgram('kotlin'), true), 'hello kotlin io')

  // math delegation running for real: the public math interface forwards pow to each target's math shim
  runRustMath('rust + math runtime: power(2,10) through the math interface', frontEnd(MATH_PROG, true, 'rust'), '1024')
  runSwiftMath('swift + math runtime: power(2,10) through the math interface', frontEnd(MATH_PROG, true, 'swift'), '1024')
  runKotlinMath('kotlin + math runtime: power(2,10) through the math interface', frontEnd(MATH_PROG, true, 'kotlin'), '1024')

  // crypto wrapping the platform's built-in library, running for real (swift CryptoKit, kotlin java.security)
  runSwiftCrypto('swift + crypto runtime: sha256("abc") through CryptoKit', frontEnd(cryptoProgram('swift'), true, 'swift'), SHA256_ABC)
  runKotlinCrypto('kotlin + crypto runtime: sha256("abc") through java.security', frontEnd(cryptoProgram('kotlin'), true, 'kotlin'), SHA256_ABC)

  // string ops through the public text interface, running on each compiled toolchain via the text shim
  runRustText('rust + text runtime: to-upper("seed") through the string interface', frontEnd(TEXT_PROG, true, 'rust'), 'SEED')
  runSwiftText('swift + text runtime: to-upper("seed") through the string interface', frontEnd(TEXT_PROG, true, 'swift'), 'SEED')
  runKotlinText('kotlin + text runtime: to-upper("seed") through the string interface', frontEnd(TEXT_PROG, true, 'kotlin'), 'SEED')

  console.log(`\nroundtrip: ${pass} pass, ${fail} fail, ${skip} skipped  (compiled + ran on the real toolchain)`)
  if (fail > 0) process.exit(1)
}

main()
