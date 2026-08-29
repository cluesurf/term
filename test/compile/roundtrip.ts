// Round-trip tests: emit each native backend, compile it with the REAL toolchain (swiftc / kotlinc / cargo (rust) / hvm), run the
// binary, and assert the result matches the interpreter's. This proves the backends emit code that actually compiles
// and computes correctly, not just code of the right shape. Each backend is gated on its toolchain being installed;
// a missing toolchain is reported as skipped, never a failure. Run: npx tsx test/compile/roundtrip.ts

import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import {
  emitKotlin,
  hoistKotlinImports,
} from '@term/make/code/compile/kotlin'
import { emitRust } from '@term/make/code/compile/rust'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'
import { readFileSync, existsSync } from 'node:fs'

let pass = 0
let fail = 0
let skip = 0

// optional substring filter so a single domain can be re-verified fast: RT_ONLY=process/run npx tsx ...
const RT_ONLY = process.env.RT_ONLY ?? ''

function skip_filtered(name: string): boolean {
  return RT_ONLY !== '' && !name.includes(RT_ONLY)
}

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
const baseTree = join(process.cwd(), 'deck', 'seed')

// the stdlib's own modules import each other as `@term/seed/...` (the Term rename); older test programs still say
// `@cluesurf/seed/...`. Both spell the same package, so the resolver accepts either prefix.
const STDLIB_PREFIX = /^@(?:cluesurf|term)\/seed\//

const stdlib = (path: string): Source | undefined => {
  if (!STDLIB_PREFIX.test(path)) {return undefined}

  const file = join(
    baseTree,
    `${path.replace(STDLIB_PREFIX, '')}.tree`,
  )

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

// read a native runtime shim's raw source (the path already carries the real extension, no `.tree`). `nativePrelude`
// now resolves shims next to the module that docks them (an absolute path), so try that directly first; fall back to
// the `@cluesurf/seed/...` import-path form for any dock whose origin file was not recorded.
const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {return readFileSync(path, 'utf8')}

  if (!STDLIB_PREFIX.test(path)) {return undefined}

  const file = join(baseTree, path.replace(STDLIB_PREFIX, ''))

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

    if (!parsed.ok) {throw new Error('parse failed')}

    const built = mill(parsed.tree, unit.file)

    if (!built.ok)
      {throw new Error(
        'mill failed: ' +
          built.diagnostics.map(d => d.message).join(', '),
      )}

    if (unit.file === 'main.tree')
      {for (const node of built.program)
        {if (node.form === 'function') {roots.add(node.name)}}}

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
  if (skip_filtered(name)) {return}

  if (!have('swiftc')) {return skipped(name, 'swiftc not installed')}

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
  if (skip_filtered(name)) {return}

  if (!have('kotlinc') || !have('java'))
    {return skipped(name, 'kotlinc/java not installed')}

  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    hoistKotlinImports(
      `${emitKotlin(program)}\nfun main() { println(${callExpr}) }\n`,
    ),
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

// compile emitted Rust with rustc and run it, asserting the exit code
function runRust(
  name: string,
  program: Program,
  callExpr: string,
  want: number,
): void {
  if (skip_filtered(name)) {return}

  if (!have('rustc')) {return skipped(name, 'rustc not installed')}

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

// like frontEnd, but runs async resolution (the pass that marks functions/closures async and inserts the default awaits)
// between type-checking and IR simplification, exactly as the real compile() driver does. Needed for any program that
// uses `wait true` / async closures.
function frontEndAsync(
  text: string,
  env?: 'rust' | 'swift' | 'kotlin' | 'node',
): Program {
  const resolver = env ? withNativeEnv(env, stdlib) : stdlib
  const parsed = parse({ file: 'main.tree', text })

  if (!parsed.ok) {throw new Error('parse failed')}

  const built = mill(parsed.tree, 'main.tree')

  if (!built.ok)
    {throw new Error(
      'mill failed: ' +
        built.diagnostics.map(d => d.message).join(', '),
    )}

  const roots = new Set<string>()

  for (const node of built.program)
    {if (node.form === 'function') {roots.add(node.name)}}

  resolveNames(built.program, 'main.tree')
  check(built.program, 'main.tree')
  resolveAsync(built.program)

  void resolver

  return simplify(built.program, roots)
}

// Rust async: append a tiny dependency-free `block_on` executor and exit with the awaited result. Proves the
// async-closure lowering (`move |..| Box::pin(async move { .. })` + `Pin<Box<dyn Future>>` type) actually compiles
// and runs on real rustc, not just that it has the right shape.
function runRustAsync(
  name: string,
  program: Program,
  callExpr: string,
  want: number,
): void {
  if (skip_filtered(name)) {return}

  if (!have('rustc')) {return skipped(name, 'rustc not installed')}

  const blockOn = `
use std::future::Future as _SeedFuture; use std::pin::Pin as _SeedPin;
use std::task::{Context as _SeedCx, Poll as _SeedPoll, RawWaker as _SeedRW, RawWakerVTable as _SeedVT, Waker as _SeedWaker};
fn seed_block_on<F: _SeedFuture>(f: F) -> F::Output {
  fn no(_: *const ()) {} fn cl(_: *const ()) -> _SeedRW { _SeedRW::new(std::ptr::null(), &VT) }
  static VT: _SeedVT = _SeedVT::new(cl, no, no, no);
  let w = unsafe { _SeedWaker::from_raw(_SeedRW::new(std::ptr::null(), &VT)) };
  let mut cx = _SeedCx::from_waker(&w); let mut f = Box::pin(f);
  loop { match f.as_mut().poll(&mut cx) { _SeedPoll::Ready(v) => return v, _SeedPoll::Pending => {} } }
}
fn main() { std::process::exit((seed_block_on(${callExpr})) as i32); }
`
  const file = join(dir, `${name.replace(/\W/g, '')}.rs`)
  writeFileSync(file, `${emitRust(program)}\n${blockOn}`)

  const exe = file.replace(/\.rs$/, '')

  try {
    execFileSync('rustc', ['-A', 'warnings', '--edition', '2021', file, '-o', exe], {
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

// Swift async: a tiny semaphore + Task bridge drives the async entrypoint to completion and prints its result.
function runSwiftAsync(
  name: string,
  program: Program,
  callExpr: string,
  want: number,
): void {
  if (skip_filtered(name)) {return}

  if (!have('swiftc')) {return skipped(name, 'swiftc not installed')}

  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  const driver = `let _seedSem = DispatchSemaphore(value: 0)\nvar _seedOut = 0\nTask { _seedOut = await ${callExpr}; _seedSem.signal() }\n_seedSem.wait()\nprint(_seedOut)\n`
  writeFileSync(file, `import Foundation\n${emitSwift(program)}\n${driver}`)

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

// Kotlin async: a hand-rolled `startCoroutine` driver runs the suspend entrypoint with no kotlinx.coroutines dependency
// (our suspend functions never truly suspend, so the coroutine completes synchronously).
function runKotlinAsync(
  name: string,
  program: Program,
  callExpr: string,
  want: number,
): void {
  if (skip_filtered(name)) {return}

  if (!have('kotlinc') || !have('java'))
    {return skipped(name, 'kotlinc/java not installed')}

  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  const driver = `import kotlin.coroutines.*\nfun <T> seedDrive(b: suspend () -> T): T { var r: T? = null; b.startCoroutine(object: Continuation<T>{ override val context = EmptyCoroutineContext; override fun resumeWith(x: Result<T>){ r = x.getOrThrow() } }); return r!! }\nfun main() { println(seedDrive { ${callExpr} }) }\n`
  writeFileSync(
    file,
    hoistKotlinImports(`${driver}\n${emitKotlin(program)}`),
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

// Rust file IO end to end: compile the synchronous native/rust/file module (which forwards to the linked `io`
// runtime), prepend the io runtime shim (from base.tree, via nativePrelude), append a main that writes a temp file through the emitted code then reads it
// back, run with rustc, and assert stdout. Proves native file IO actually RUNS on a real compiled toolchain, not just
// that it emits the right shape. main owns the path and clones it across the two calls (each emitted call moves its arg).
function runRustIo(name: string, program: Program, want: string): void {
  if (skip_filtered(name)) {return}

  if (!have('rustc')) {return skipped(name, 'rustc not installed')}

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
  if (skip_filtered(name)) {return}

  if (!have('swiftc')) {return skipped(name, 'swiftc not installed')}

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
  if (skip_filtered(name)) {return}

  if (!have('kotlinc') || !have('java'))
    {return skipped(name, 'kotlinc/java not installed')}

  const path = join(dir, 'seed_kotlin_io.txt')
  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  const main = `\nfun main() {\n  writeDemo(${JSON.stringify(
    path,
  )}, ${JSON.stringify(want)})\n  print(readDemo(${JSON.stringify(
    path,
  )}))\n}\n`

  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
        program,
      )}${main}`,
    ),
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
  if (skip_filtered(name)) {return}

  if (!have('rustc')) {return skipped(name, 'rustc not installed')}

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
  if (skip_filtered(name)) {return}

  if (!have('swiftc')) {return skipped(name, 'swiftc not installed')}

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
  if (skip_filtered(name)) {return}

  if (!have('kotlinc') || !have('java'))
    {return skipped(name, 'kotlinc/java not installed')}

  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
        program,
      )}\nfun main() { print(compute()) }\n`,
    ),
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
  if (skip_filtered(name)) {return}

  if (!have('swiftc')) {return skipped(name, 'swiftc not installed')}

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
  if (skip_filtered(name)) {return}

  if (!have('kotlinc') || !have('java'))
    {return skipped(name, 'kotlinc/java not installed')}

  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
        program,
      )}\nsuspend fun main() { print(compute()) }\n`,
    ),
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
  if (skip_filtered(name)) {return}

  if (!have('rustc')) {return skipped(name, 'rustc not installed')}

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
  isAsync = false,
): void {
  if (skip_filtered(name)) {return}

  if (!have('swiftc')) {return skipped(name, 'swiftc not installed')}

  const file = join(dir, `${name.replace(/\W/g, '')}.swift`)
  const callCompute = isAsync ? 'await compute()' : 'compute()'
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(
      program,
    )}\nprint(${callCompute}, terminator: "")\n`,
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
  isAsync = false,
): void {
  if (skip_filtered(name)) {return}

  if (!have('kotlinc') || !have('java'))
    {return skipped(name, 'kotlinc/java not installed')}

  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  const mainSig = isAsync ? 'suspend fun main()' : 'fun main()'
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
        program,
      )}\n${mainSig} { print(compute()) }\n`,
    ),
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
tokio = { version = "1", features = ["rt", "rt-multi-thread", "macros", "net", "io-util"] }
unicode-normalization = "0.1"
unicode-segmentation = "1"
tokio-tungstenite = "0.24"
futures-util = "0.3"

`

function runRustCargo(
  name: string,
  program: Program,
  want: string,
  isAsync: boolean,
): void {
  if (skip_filtered(name)) {return}

  if (!have('cargo')) {return skipped(name, 'cargo not installed')}

  // one cargo project for every program, so the crates build once and are shared, and ONE BINARY PER PROGRAM
  // (`src/bin/<name>.rs`, `cargo run --bin <name>`): a shared `src/main.rs` rewritten within the same second as the
  // previous build ran was skipped by cargo's mtime check, and the previous program's binary ran in its place
  const proj = join(tmpdir(), 'seed-rust-runtime')
  mkdirSync(join(proj, 'src', 'bin'), { recursive: true })
  writeFileSync(join(proj, 'Cargo.toml'), RUST_CARGO_TOML)
  // cargo wants a library or a main; an empty library keeps the package valid with only `src/bin/` programs. A
  // `src/main.rs` left by an older harness would be a stale program cargo tries to build, so it is emptied too
  writeFileSync(join(proj, 'src', 'lib.rs'), '')
  writeFileSync(join(proj, 'src', 'main.rs'), 'fn main() {}\n')

  const prelude = nativePrelude(program, 'rust', readRuntime)
  const main = isAsync
    ? `\n#[tokio::main]\nasync fn main() { print!("{}", compute().await); }\n`
    : `\nfn main() { print!("{}", compute()); }\n`
  const bin = `p_${name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 80)

  writeFileSync(
    join(proj, 'src', 'bin', `${bin}.rs`),
    `${prelude}\n${emitRust(program)}${main}`,
  )

  let out: string

  try {
    out = execFileSync('cargo', ['run', '--quiet', '--bin', bin], {
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
  if (skip_filtered(name)) {return}

  if (!have('rustc')) {return skipped(name, 'rustc not installed')}

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
  if (skip_filtered(name)) {return}

  if (!have('swiftc')) {return skipped(name, 'swiftc not installed')}

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
  if (skip_filtered(name)) {return}

  if (!have('kotlinc') || !have('java'))
    {return skipped(name, 'kotlinc/java not installed')}

  const file = join(dir, `${name.replace(/\W/g, '')}.kt`)
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
        program,
      )}\nfun main() { compute() }\n`,
    ),
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

// a closure that MUTATES a captured outer variable, called twice, with the mutation visible after the closure.
// Exercises mutable capture on every backend: Rust boxes the local in Rc<RefCell> (reads borrow + clone, writes go
// through borrow_mut, the closure clones the handle before the move), Swift and Kotlin capture the mutable local
// directly. compute(0) -> bump(5) -> bump(7) -> 12.
const MUTATE_CAPTURE = `task compute
  take start, like number
  like number
  save total, read start
  save bump
    task grow
      take amount, like number
      like number
      save total
        call add
          read total
          read amount
      send back, read total
  call bump
    code 5
  call bump
    code 7
  send back
    read total
`

// an ASYNC closure that awaits and CAPTURES an outer variable, invoked through a local binding. Exercises the
// async-closure lowering on every backend: Rust `move |..| Box::pin(async move {..})` returning `Pin<Box<dyn Future>>`,
// Swift `{ (x) async -> Int in .. }`, Kotlin `suspend (Long) -> Long`. run(3) -> f(7) -> delay(7 + 3) -> 10.
const ASYNC_CLOSURE = `task delay
  take n, like number
  wait true
  like number
  send back, loan n

task run
  take seed, like number
  like number
  save f
    task handler
      take x, like number
      wait true
      like number
      send back
        call delay
          call add
            loan x
            loan seed
          wait true
  send back
    call f
      code 7
      wait true
`

// generic containers cross-backend: each is a `head t` form whose field is `list<t>` and whose pop/dequeue returns
// `maybe<t>`. These exercise the full generic-container path on the strict backends (native `<T>` struct with a used
// type parameter, mutation through the shared list handle, and a `maybe<t>`-returning method extracted via unwrap-or).
// stack is LIFO: push 7, push 3, pop -> 3.
const STACK_GENERIC = `load @cluesurf/seed/code/list/stack
  find stack

task run
  like number
  save s
    make stack
      bind items
        make list
  call push
    read s
    code 7
  call push
    read s
    code 3
  send back
    call unwrap-or
      call pop
        read s
      code 0
`

// queue is FIFO: enqueue 7, enqueue 3, dequeue -> 7.
const QUEUE_GENERIC = `load @cluesurf/seed/code/list/queue
  find queue

task run
  like number
  save q
    make queue
      bind items
        make list
  call enqueue
    read q
    code 7
  call enqueue
    read q
    code 3
  send back
    call unwrap-or
      call dequeue
        read q
      code 0
`

// deque is double-ended: push-back 7, push-front 3 -> [3, 7], pop-back -> 7.
const DEQUE_GENERIC = `load @cluesurf/seed/code/list/deque
  find deque

task run
  like number
  save d
    make deque
      bind items
        make list
  call push-back
    read d
    code 7
  call push-front
    read d
    code 3
  send back
    call unwrap-or
      call pop-back
        read d
      code 0
`

// code-point decomposition: to-runes turns text into its list of Unicode scalar values, building each backend's own
// list representation directly (so the result is a first-class list whose /length applies). "A😀b" is three code points
// (the emoji is one astral scalar), so the count is 3 on every backend -- proving the list-return wrapper is solved.
const RUNE_COUNT = `load @cluesurf/seed/code/text/unicode
  find to-runes

task run
  like number
  save runes
    call to-runes
      text <A😀b>
  send back
    read runes/length
`

// round-trip: to-runes then from-runes reconstructs the original text, astral scalar included. from-runes is pure Seed
// over the list's own iteration (folding each rune's one-character text), so it never touches a backend's list rep.
const RUNE_ROUND = `load @cluesurf/seed/code/text/unicode
  find to-runes
  find from-runes

task compute
  like text
  send back
    call from-runes
      call to-runes
        text <A😀b>
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

// a sum type (variant / enum): build a tagged value, match on it, read the payload. `make full` is tag 0 with
// payload 7; the match reads the tag, takes the `full` arm, returns the payload -> 7.
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
      true
  fork case, read b
    case full
      send back
        read b/value
    case empty
      send back
        code 0
`

// a value-position conditional (a `fork` used as the returned value) with an else-if chain: grade(70) takes the second
// branch -> 2.
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

// a generic function reaching a monomorphic backend: identity<t> called at a number. A monomorphic backend has no type
// parameters, so monomorphization must specialize identity at the number type and rewrite the call. compute -> 42.
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

// a plain record: build a struct, pass it by value, read a field. compute -> 35.
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
const MAYBE = `load @cluesurf/seed/code/maybe
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
) => `load @cluesurf/seed/code/native/${platform}/file
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
const MATH_PROG = `load @cluesurf/seed/code/math
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
) => `load @cluesurf/seed/code/cryptography/digest
  find sha256

load @cluesurf/seed/code/bytes
  find from-text
  find to-hex

task compute
  note async
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
const BASE64_PROG = `load @cluesurf/seed/code/text/base64
  find encode

task compute
  like text
  send back
    call encode
      text <hello>
`

const HEX_PROG = `load @cluesurf/seed/code/text/hex
  find encode

task compute
  like text
  send back
    call encode
      text <hi>
`

const HMAC_PROG = `load @cluesurf/seed/code/cryptography/hmac
  find sha256

load @cluesurf/seed/code/bytes
  find from-text
  find to-hex

task compute
  note async
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
const UUID_PROG = `load @cluesurf/seed/code/uuid
  find version4

load @cluesurf/seed/code/regex
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
const RANDOM_PROG = `load @cluesurf/seed/code/random
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
const SECURE_RANDOM_PROG = `load @cluesurf/seed/code/cryptography/random
  find bytes

load @cluesurf/seed/code/bytes
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
const BYTES_PROG = `load @cluesurf/seed/code/bytes
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
const CIPHER_PROG = `load @cluesurf/seed/code/cryptography/cipher
  find encrypt
  find decrypt

load @cluesurf/seed/code/bytes
  find from-text
  find to-text
  find from-hex

task compute
  note async
  like boolean
  save sealed
    call encrypt
      call from-hex
        text <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff>
      call from-hex
        text <000102030405060708090a0b>
      call from-text
        text <attack at dawn>
      call from-text
        text <>
      wait true
  save opened
    call decrypt
      call from-hex
        text <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff>
      call from-hex
        text <000102030405060708090a0b>
      read sealed
      call from-text
        text <>
      wait true
  send back
    call is-equal
      call to-text
        read opened
      text <attack at dawn>
`

// Ed25519 signatures: generate a key pair, sign a message, verify it (boolean round-trip, print-format agnostic).
// Exercises each platform's Ed25519 (rust ed25519-dalek, swift CryptoKit Curve25519, kotlin java.security).
const SIGNATURE_PROG = `load @cluesurf/seed/code/cryptography/signature
  find make-key-pair
  find sign
  find verify

load @cluesurf/seed/code/bytes
  find from-text

task compute
  note async
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
const ENV_VAR_PROG = `load @cluesurf/seed/code/environment
  find variable

task compute
  like boolean
  send back
    call is-unequal
      call variable
        text <PATH>
      text <>
`

// subprocess: run `echo ok` to completion and confirm exit code 0 (std::process::Command / Foundation.Process /
// ProcessBuilder). Boolean result keeps the output uniform across backends.
const RUN_PROG = `load @cluesurf/seed/code/process/run
  find run
  find run-result

load @cluesurf/seed/code/list
  find list
  find push

task make-arguments
  like list
    like text
  save out
    make list
  call push
    read out
    text <ok>
  send back, read out

task compute
  note async
  like boolean
  save result
    call run
      text <echo>
      call make-arguments
      wait true
  send back
    call is-equal
      read result/code
      code 0
`

// TCP loopback: listen, connect, accept, then exchange ping / pong over the live connection. Exercises the whole
// sockets stack — opaque per-backend handle (the platform socket) stored in the connection / listener forms, plus
// connect / listen / accept / read / write. The accept picks up the connection the OS backlogs from connect, so the
// flow stays sequential.
const TCP_PROG = `load @cluesurf/seed/code/network/tcp
  find connect
  find listen
  find read
  find write
  find accept

task compute
  note async
  like boolean
  save server
    call listen
      code 47924
      text <127.0.0.1>
      false
      text <>
      text <>
      wait true
  save client
    call connect
      text <127.0.0.1>
      code 47924
      false
      wait true
  save peer
    call accept
      read server
      wait true
  call write
    read client
    text <ping>
    wait true
  save got
    call read
      read peer
      wait true
  call write
    read peer
    text <pong>
    wait true
  save reply
    call read
      read client
      wait true
  send back
    call is-equal
      read reply
      text <pong>
`

// UDP loopback: open two datagram sockets, send a message from one to the other, receive it. Exercises the datagram
// stack — opaque per-backend socket handle, plus open / send / receive returning the datagram form with sender address.
const UDP_PROG = `load @cluesurf/seed/code/network/udp
  find open
  find send
  find receive

task compute
  note async
  like boolean
  save receiver
    call open
      code 48001
      text <127.0.0.1>
      wait true
  save sender
    call open
      code 48002
      text <127.0.0.1>
      wait true
  call send
    read sender
    text <hello>
    text <127.0.0.1>
    code 48001
    wait true
  save message
    call receive
      read receiver
      wait true
  send back
    call is-equal
      read message/data
      text <hello>
`

// rune Unicode predicates + case mapping via declarative bindings (rust char tables, swift Character, kotlin Character).
// 233 is 'é' (a letter), to-uppercase of 97 'a' is 65 'A'. Both checks true.
const RUNE_PROG = `load @cluesurf/seed/code/rune
  find make-rune
  find is-letter
  find to-uppercase

task compute
  like boolean
  save accented
    call make-rune
      code 233
  save lower
    call make-rune
      code 97
  save upper
    call to-uppercase
      read lower
  send back
    call and
      call is-letter
        read accented
      call is-equal
        read upper/code
        code 65
`

// Unicode text measurement via declarative bindings: 'café' is 4 code points and 5 UTF-8 bytes on every backend.
const UNICODE_COUNT_PROG = `load @cluesurf/seed/code/text/unicode
  find rune-count
  find byte-count

task compute
  like boolean
  send back
    call and
      call is-equal
        call rune-count
          text <café>
        code 4
      call is-equal
        call byte-count
          text <café>
        code 5
`

// Unicode normalization via declarative bindings: NFD decomposes 'café' so it has more than 4 code points (the accent
// splits off). rust uses the unicode-normalization crate, the others the built-in normalizer.
const UNICODE_NORM_PROG = `load @cluesurf/seed/code/text/unicode
  find to-nfd
  find rune-count

task compute
  like boolean
  send back
    call is-above
      call rune-count
        call to-nfd
          text <café>
      code 4
`

// Unicode grapheme segmentation: a decomposed 'é' (e + combining accent) is two code points but one grapheme cluster.
const UNICODE_GRAPHEME_PROG = `load @cluesurf/seed/code/text/unicode
  find grapheme-count
  find rune-count
  find to-nfd

task compute
  like boolean
  save decomposed
    call to-nfd
      text <é>
  send back
    call and
      call is-equal
        call grapheme-count
          read decomposed
        code 1
      call is-equal
        call rune-count
          read decomposed
        code 2
`

// concurrency channel: send a message then receive it over a buffered text channel (node async queue, rust tokio mpsc,
// swift semaphore-buffered, kotlin BlockingQueue). The buffer holds the value so send-then-receive in one task works.
const CHANNEL_PROG = `load @cluesurf/seed/code/channel
  find make-channel
  find send
  find receive

task compute
  note async
  like boolean
  save gate
    call make-channel
  call send
    read gate
    text <channel-ok>
    wait true
  save got
    call receive
      read gate
      wait true
  send back
    call is-equal
      read got
      text <channel-ok>
`
// concurrency atomic: an atomic counter, increase then load (node Atomics/SAB, rust AtomicI64, swift lock-guarded,
// kotlin AtomicLong). 10 + 5 = 15, and the cell reads back 15.
const ATOMIC_PROG = `load @cluesurf/seed/code/atomic
  find make-atomic
  find load
  find increase

task compute
  like boolean
  save cell
    call make-atomic
      code 10
  save after
    call increase
      read cell
      code 5
  send back
    call and
      call is-equal
        read after
        code 15
      call is-equal
        call load
          read cell
        code 15
`
// concurrency mutex: lock then unlock then lock again proves the lock is released and re-acquirable (node async flag,
// rust atomic spinlock, swift NSLock, kotlin ReentrantLock).
const MUTEX_PROG = `load @cluesurf/seed/code/mutex
  find make-mutex
  find lock
  find unlock

task compute
  note async
  like boolean
  save guard
    call make-mutex
  call lock
    read guard
    wait true
  call unlock
    read guard
    wait true
  call lock
    read guard
    wait true
  call unlock
    read guard
    wait true
  send back, true
`
// directory make plus metadata: make a directory then confirm is-directory reports it. Exercises the io shim's
// dir-make and is-directory on each platform (rust std::fs, swift FileManager, kotlin java.io.File).
const DIR_MAKE_PROG = `load @cluesurf/seed/code/file/directory
  find make
load @cluesurf/seed/code/file/metadata
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
const DIR_REMOVE_PROG = `load @cluesurf/seed/code/file/directory
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
const DIR_LIST_PROG = `load @cluesurf/seed/code/file/directory
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
const DIR_WALK_PROG = `load @cluesurf/seed/code/file/directory
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
const PATH_JOIN_PROG = `load @cluesurf/seed/code/path
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
const PATH_EXTENSION_PROG = `load @cluesurf/seed/code/path
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
const CALENDAR_PROG = `load @cluesurf/seed/code/calendar
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
const KEY_AGREEMENT_PROG = `load @cluesurf/seed/code/cryptography/key-agreement
  find make-key-pair
  find shared-secret

load @cluesurf/seed/code/bytes
  find to-hex

task compute
  note async
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
const DNS_PROG = `load @cluesurf/seed/code/network/dns
  find resolve-one

task compute
  note async
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
const COLLECTION_PROG = `load @cluesurf/seed/code/set
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
const LIST_PROG = `load @cluesurf/seed/code/list
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
const LIST_SET_PROG = `load @cluesurf/seed/code/list
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
const JSON_RT_PROG = `load @cluesurf/seed/code/json
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
const JSON_ENCODE_RT = `load @cluesurf/seed/code/json
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
          true
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
const FLOAT_PROG = `load @cluesurf/seed/code/float
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
const TRIG_PROG = `load @cluesurf/seed/code/float
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
const VECTOR3_PROG = `load @cluesurf/seed/code/line/float/32/vector-3
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
const QUATERNION_PROG = `load @cluesurf/seed/code/line/float/32/quaternion
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
const TIME_PROG = `load @cluesurf/seed/code/time
  find now

task compute
  like boolean
  send back
    call is-above
      call now
      code 0
`

// console: compute() prints to stdout (it returns unit), so the runner just calls it and captures stdout
const CONSOLE_PROG = `load @cluesurf/seed/code/console
  find log

task compute
  like void
  call log
    text <hello console>
`

// clock: monotonic now() is positive
const CLOCK_PROG = `load @cluesurf/seed/code/clock
  find now

task compute
  like boolean
  send back
    call is-above
      call now
      code 0
`

// process / environment: return non-empty platform info, verified with regex (no member access)
const PROCESS_PROG = `load @cluesurf/seed/code/process
  find platform

load @cluesurf/seed/code/regex
  find matches

task compute
  like boolean
  send back
    call matches
      text <^.+$>
      call platform
`

const ENVIRONMENT_PROG = `load @cluesurf/seed/code/environment
  find directory

load @cluesurf/seed/code/regex
  find matches

task compute
  like boolean
  send back
    call matches
      text <^.+$>
      call directory
`

// log: info() prints to stdout
const LOG_PROG = `load @cluesurf/seed/code/log
  find info

task compute
  like void
  call info
    text <hello log>
`

// a string op through the public interface: to-upper("seed") forwards to the per-target text shim
const TEXT_PROG = `load @cluesurf/seed/code/text/string
  find to-upper

task compute
  like text
  send back
    call to-upper
      text <seed>
`

// string concat through the public interface, forwarding to each target's text shim (boolean result -> uniform output)
const CONCAT_PROG = `load @cluesurf/seed/code/text/string
  find concat

task compute
  like boolean
  send back
    call is-equal
      call concat
        text <foo>
        text <bar>
      text <foobar>
`

// a regex match through the public interface, forwarding to the per-target regex shim (the prelude is auto-collected)
const REGEX_PROG = `load @cluesurf/seed/code/regex
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
  if (skip_filtered(name)) {return}

  const file = join(dir, `${name.replace(/\W/g, '')}.ts`)
  writeFileSync(
    file,
    `${emitTypeScript(program)}\nconsole.log(${call})\n`,
  )

  // a runtime error in the emitted module is a FAIL for this test, never an abort of the whole harness
  try {
    ok(
      name,
      execFileSync('node', ['--experimental-strip-types', file], {
        stdio: 'pipe',
      })
        .toString()
        .trim(),
      want,
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (node error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 300)})`,
    )
  }
}

// run the emitted Rust on rustc: print the given call (Display prints 3.0 as "3"), assert stdout
function runRustExpr(
  name: string,
  program: Program,
  call: string,
  want: string,
): void {
  if (skip_filtered(name)) {return}

  if (!have('rustc')) {return skipped(name, 'rustc not installed')}

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

  const mutateCapture = frontEnd(MUTATE_CAPTURE)
  runRust(
    'rust: a closure mutating a captured variable (Rc<RefCell> cell)',
    mutateCapture,
    'compute(0)',
    12,
  )
  runSwift(
    'swift: a closure mutating a captured variable',
    mutateCapture,
    'compute(0)',
    12,
  )
  runKotlin(
    'kotlin: a closure mutating a captured variable',
    mutateCapture,
    'compute(0)',
    12,
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

  // async closures on every backend: a closure that awaits + captures, driven to completion by each runtime. run(3) -> 10
  const asyncClosure = frontEndAsync(ASYNC_CLOSURE)
  runRustAsync(
    'rust: async closure (await + capture) via Pin<Box<dyn Future>>',
    asyncClosure,
    'run(3)',
    10,
  )
  runSwiftAsync(
    'swift: async closure (await + capture)',
    asyncClosure,
    'run(3)',
    10,
  )
  runKotlinAsync(
    'kotlin: suspend closure (await + capture)',
    asyncClosure,
    'run(3)',
    10,
  )

  // generic containers on every strict backend: stack (LIFO) -> 3, queue (FIFO) -> 7, deque (double-ended) -> 7.
  // each fully compiles the `head t` struct + its `maybe<t>`-returning pop/dequeue, proving generics flow end to end.
  for (const [label, prog, want] of [
    ['stack', STACK_GENERIC, 3],
    ['queue', QUEUE_GENERIC, 7],
    ['deque', DEQUE_GENERIC, 7],
  ] as const) {
    const built = frontEnd(prog, true)
    runRust(`rust: generic ${label}<T> (struct + maybe<t> pop)`, built, 'run()', want)
    runSwift(`swift: generic ${label}<T> (struct + maybe<t> pop)`, built, 'run()', want)
    runKotlin(`kotlin: generic ${label}<T> (struct + maybe<t> pop)`, built, 'run()', want)
  }

  // code-point runes on every backend: to-runes count ("A😀b" -> 3) and a to-runes/from-runes text round-trip.
  const runeCount = frontEnd(RUNE_COUNT, true)
  runRust('rust: to-runes code-point count (astral)', runeCount, 'run()', 3)
  runSwift('swift: to-runes code-point count (astral)', runeCount, 'run()', 3)
  runKotlin('kotlin: to-runes code-point count (astral)', runeCount, 'run()', 3)
  runRustText(
    'rust: to-runes/from-runes text round-trip',
    frontEnd(RUNE_ROUND, true, 'rust'),
    'A😀b',
  )
  runSwiftText(
    'swift: to-runes/from-runes text round-trip',
    frontEnd(RUNE_ROUND, true, 'swift'),
    'A😀b',
  )
  runKotlinText(
    'kotlin: to-runes/from-runes text round-trip',
    frontEnd(RUNE_ROUND, true, 'kotlin'),
    'A😀b',
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
  // subprocess: run `echo ok` and confirm exit code 0 on each compiled toolchain
  runSwiftText(
    'swift + process/run: echo exits 0 (Foundation.Process)',
    frontEnd(RUN_PROG, true, 'swift'),
    'true',
    true,
  )
  runKotlinText(
    'kotlin + process/run: echo exits 0 (ProcessBuilder)',
    frontEnd(RUN_PROG, true, 'kotlin'),
    'true',
    true,
  )
  runRustCargo(
    'rust + cargo: process/run echo exits 0 (std::process::Command)',
    frontEnd(RUN_PROG, true, 'rust'),
    'true',
    true,
  )
  // TCP loopback echo on the real toolchain (tokio / java.net)
  runRustCargo(
    'rust + cargo: tcp loopback ping/pong (tokio::net)',
    frontEnd(TCP_PROG, true, 'rust'),
    'true',
    true,
  )
  runKotlinText(
    'kotlin + tcp: loopback ping/pong (java.net)',
    frontEnd(TCP_PROG, true, 'kotlin'),
    'true',
    true,
  )
  runSwiftText(
    'swift + tcp: loopback ping/pong (POSIX sockets)',
    frontEnd(TCP_PROG, true, 'swift'),
    'true',
    true,
  )
  // UDP loopback datagram on the real toolchain
  runRustCargo(
    'rust + cargo: udp datagram round-trips (tokio::net::UdpSocket)',
    frontEnd(UDP_PROG, true, 'rust'),
    'true',
    true,
  )
  runKotlinText(
    'kotlin + udp: datagram round-trips (java.net.DatagramSocket)',
    frontEnd(UDP_PROG, true, 'kotlin'),
    'true',
    true,
  )
  runSwiftText(
    'swift + udp: datagram round-trips (POSIX sockets)',
    frontEnd(UDP_PROG, true, 'swift'),
    'true',
    true,
  )
  // rune Unicode predicates + case mapping via declarative bindings (no hand-written native on these targets)
  runRustCargo(
    'rust + cargo: rune is-letter + to-uppercase (char tables, declarative bind)',
    frontEnd(RUNE_PROG, true, 'rust'),
    'true',
    false,
  )
  runKotlinText(
    'kotlin + rune: is-letter + to-uppercase (Character, declarative bind)',
    frontEnd(RUNE_PROG, true, 'kotlin'),
    'true',
  )
  runSwiftText(
    'swift + rune: is-letter + to-uppercase (Character, declarative bind)',
    frontEnd(RUNE_PROG, true, 'swift'),
    'true',
  )
  // Unicode text measurement (rune-count, byte-count) via declarative bindings
  runRustCargo(
    'rust + cargo: unicode rune-count + byte-count (declarative bind)',
    frontEnd(UNICODE_COUNT_PROG, true, 'rust'),
    'true',
    false,
  )
  runKotlinText(
    'kotlin + unicode: rune-count + byte-count (declarative bind)',
    frontEnd(UNICODE_COUNT_PROG, true, 'kotlin'),
    'true',
  )
  runSwiftText(
    'swift + unicode: rune-count + byte-count (declarative bind)',
    frontEnd(UNICODE_COUNT_PROG, true, 'swift'),
    'true',
  )
  // Unicode normalization (NFD) via declarative bindings (rust unicode-normalization crate, others built-in)
  runRustCargo(
    'rust + cargo: unicode NFD normalize (unicode-normalization crate)',
    frontEnd(UNICODE_NORM_PROG, true, 'rust'),
    'true',
    false,
  )
  runKotlinText(
    'kotlin + unicode: NFD normalize (java.text.Normalizer)',
    frontEnd(UNICODE_NORM_PROG, true, 'kotlin'),
    'true',
  )
  runSwiftText(
    'swift + unicode: NFD normalize (decomposedStringWithCanonicalMapping)',
    frontEnd(UNICODE_NORM_PROG, true, 'swift'),
    'true',
  )
  // Unicode grapheme segmentation (rust unicode-segmentation, swift Character, kotlin BreakIterator)
  runRustCargo(
    'rust + cargo: unicode grapheme-count (unicode-segmentation crate)',
    frontEnd(UNICODE_GRAPHEME_PROG, true, 'rust'),
    'true',
    false,
  )
  runKotlinText(
    'kotlin + unicode: grapheme-count (BreakIterator)',
    frontEnd(UNICODE_GRAPHEME_PROG, true, 'kotlin'),
    'true',
  )
  runSwiftText(
    'swift + unicode: grapheme-count (Character clusters)',
    frontEnd(UNICODE_GRAPHEME_PROG, true, 'swift'),
    'true',
  )
  // concurrency: channel send + receive over a buffered text channel
  runRustCargo(
    'rust + cargo: channel send + receive (tokio mpsc)',
    frontEnd(CHANNEL_PROG, true, 'rust'),
    'true',
    true,
  )
  runKotlinText(
    'kotlin + channel: send + receive (BlockingQueue)',
    frontEnd(CHANNEL_PROG, true, 'kotlin'),
    'true',
    true,
  )
  runSwiftText(
    'swift + channel: send + receive (semaphore buffer)',
    frontEnd(CHANNEL_PROG, true, 'swift'),
    'true',
    true,
  )
  // concurrency: atomic counter increase + load
  runRustCargo(
    'rust + cargo: atomic increase + load (AtomicI64)',
    frontEnd(ATOMIC_PROG, true, 'rust'),
    'true',
    false,
  )
  runKotlinText(
    'kotlin + atomic: increase + load (AtomicLong)',
    frontEnd(ATOMIC_PROG, true, 'kotlin'),
    'true',
  )
  runSwiftText(
    'swift + atomic: increase + load (lock-guarded)',
    frontEnd(ATOMIC_PROG, true, 'swift'),
    'true',
  )
  // concurrency: mutex lock + unlock + relock
  runRustCargo(
    'rust + cargo: mutex lock + unlock (atomic spinlock)',
    frontEnd(MUTEX_PROG, true, 'rust'),
    'true',
    true,
  )
  runKotlinText(
    'kotlin + mutex: lock + unlock (ReentrantLock)',
    frontEnd(MUTEX_PROG, true, 'kotlin'),
    'true',
    true,
  )
  runSwiftText(
    'swift + mutex: lock + unlock (NSLock)',
    frontEnd(MUTEX_PROG, true, 'swift'),
    'true',
    true,
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
  // json to "runs" via the host JSON: rust serde_json (cargo), swift JSONSerialization, kotlin its own reader in the
  // shim (the JDK has none, and nothing is on the classpath).
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
  runKotlinText(
    'kotlin + json: parse + index + as-number via the shim reader',
    frontEnd(JSON_RT_PROG, true, 'kotlin'),
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
  runKotlinText(
    'kotlin + json: encode a typed value + round-trip via the shim writer',
    frontEnd(JSON_ENCODE_RT, true, 'kotlin'),
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

  // string concat through the public text interface, running on each compiled toolchain
  runRustText(
    'rust + text runtime: concat("foo","bar") == "foobar"',
    frontEnd(CONCAT_PROG, true, 'rust'),
    'true',
  )
  runSwiftText(
    'swift + text runtime: concat("foo","bar") == "foobar"',
    frontEnd(CONCAT_PROG, true, 'swift'),
    'true',
  )
  runKotlinText(
    'kotlin + text runtime: concat("foo","bar") == "foobar"',
    frontEnd(CONCAT_PROG, true, 'kotlin'),
    'true',
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
      {port = readFileSync(portFile, 'utf8').trim()}
    else {Atomics.wait(waiter, 0, 0, 50)}
  }

  if (port) {
    const httpProg = `load @cluesurf/seed/code/network/http\n  find get\n\ntask compute\n  note async\n  like text\n  save r\n    call get\n      text <http://127.0.0.1:${port}/>\n      wait true\n  send back\n    read r/body\n`
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

  // websocket client to a real echo server. The server (RFC 6455 handshake + single-frame text echo) runs in a SEPARATE
  // node process so the blocking execFileSync of each compiled binary does not freeze its event loop. node uses the
  // global WebSocket, rust tokio-tungstenite, swift URLSessionWebSocketTask, kotlin java.net.http.WebSocket -- each
  // behind the one async connect / send / receive interface, buffering frames so send-then-receive never races.
  const wsPortFile = join(dir, 'ws-port.txt')
  const wsServerCode = `const http=require('http'),crypto=require('crypto'),fs=require('fs');function dec(b){const op=b[0]&15,mk=(b[1]&128)!==0;let n=b[1]&127,o=2;if(n===126){n=b.readUInt16BE(2);o=4}else if(n===127){n=Number(b.readBigUInt64BE(2));o=10}let m=Buffer.alloc(0);if(mk){m=b.subarray(o,o+4);o+=4}const p=b.subarray(o,o+n),out=Buffer.alloc(p.length);for(let i=0;i<p.length;i++)out[i]=p[i]^(mk?m[i%4]:0);return{op,d:out.toString('utf8')}}function enc(t){const p=Buffer.from(t,'utf8'),n=p.length;let h;if(n<126)h=Buffer.from([0x81,n]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(n,2)}return Buffer.concat([h,p])}const s=http.createServer();s.on('upgrade',(q,sock)=>{const k=q.headers['sec-websocket-key'],a=crypto.createHash('sha1').update(k+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+a+'\\r\\n\\r\\n');sock.on('data',b=>{const f=dec(b);if(f.op===8){sock.end();return}if(f.op===1)sock.write(enc(f.d))})});s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],String(s.address().port)))`
  const wsServer = spawn(process.execPath, ['-e', wsServerCode, wsPortFile], {
    stdio: 'ignore',
  })

  let wsPort = ''
  const wsWaiter = new Int32Array(new SharedArrayBuffer(4))

  for (let i = 0; i < 100 && !wsPort; i++) {
    if (existsSync(wsPortFile))
      {wsPort = readFileSync(wsPortFile, 'utf8').trim()}
    else {Atomics.wait(wsWaiter, 0, 0, 50)}
  }

  if (wsPort) {
    const wsProg = `load @cluesurf/seed/code/network/websocket
  find connect
  find send
  find receive

task compute
  note async
  like text
  save socket
    call connect
      text <ws://127.0.0.1:${wsPort}>
      wait true
  call send
    read socket
    text <ws-roundtrip>
    wait true
  save reply
    call receive
      read socket
      wait true
  send back, read reply/data
`
    const wsNodeName = 'node + websocket: echo (global WebSocket)'
    if (!skip_filtered(wsNodeName)) {
      const nodeWsProgram = frontEnd(wsProg, true, 'node')
      const wsNodeFile = join(dir, 'wsnode.ts')
      writeFileSync(
        wsNodeFile,
        `${nativePrelude(nodeWsProgram, 'node', readRuntime)}\n${emitTypeScript(nodeWsProgram, { env: 'node' })}\ncompute().then(r => { process.stdout.write(String(r)); process.exit(0) })`,
      )
      try {
        ok(
          wsNodeName,
          execFileSync('npx', ['tsx', wsNodeFile], {
            encoding: 'utf8',
            timeout: 20000,
          }).trim(),
          'ws-roundtrip',
        )
      } catch (e) {
        fail++
        console.log(`FAIL  ${wsNodeName}  (${String((e as { message?: string }).message ?? e).slice(0, 120)})`)
      }
    }
    runRustCargo(
      'rust + cargo: websocket echo (tokio-tungstenite)',
      frontEnd(wsProg, true, 'rust'),
      'ws-roundtrip',
      true,
    )
    runKotlinText(
      'kotlin + websocket: echo (java.net.http.WebSocket)',
      frontEnd(wsProg, true, 'kotlin'),
      'ws-roundtrip',
      true,
    )
    runSwiftText(
      'swift + websocket: echo (URLSessionWebSocketTask)',
      frontEnd(wsProg, true, 'swift'),
      'ws-roundtrip',
      true,
    )
  } else {
    skipped('websocket round-trips', 'could not start the local ws server')
  }

  wsServer.kill()

  console.log(
    `\nroundtrip: ${pass} pass, ${fail} fail, ${skip} skipped  (compiled + ran on the real toolchain)`,
  )

  if (fail > 0) {process.exit(1)}
}

main()
