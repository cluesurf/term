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
import { emitSwift } from '@/code/compile/swift'
import { emitKotlin } from '@/code/compile/kotlin'
import { emitLlvm } from '@/code/compile/llvm'
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

// front-end a program (optionally resolving stdlib imports) to a checked compile AST
function frontEnd(text: string, withStdlib = false): Program {
  const sources = withStdlib ? collectModules({ file: 'main.tree', text }, stdlib).sources : [{ file: 'main.tree', text }]
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

function main(): void {
  const fib = frontEnd(FIB)
  runLlvm('llvm: iterative fibonacci (mutation + while)', fib, '@find_fibonacci_via_loop(i64 10)', 55)
  runSwift('swift: iterative fibonacci', fib, 'findFibonacciViaLoop(10)', 55)
  runKotlin('kotlin: iterative fibonacci', fib, 'findFibonacciViaLoop(10)', 55)

  const maybe = frontEnd(MAYBE, true)
  runSwift('swift: native ADT enum + match + map', maybe, 'demo()', 48)
  runKotlin('kotlin: native ADT sealed class + match + map', maybe, 'demo()', 48)

  // LLVM with the managed Rust runtime: strings as pointers, concatenation + printing through the linked staticlib
  runLlvmRust('llvm + rust runtime: string concat + print', frontEnd(GREETING), '@greeting()', 'hello world')

  console.log(`\nroundtrip: ${pass} pass, ${fail} fail, ${skip} skipped  (compiled + ran on the real toolchain)`)
  if (fail > 0) process.exit(1)
}

main()
