// One program, compiled for one backend, built, and run, answering exactly the text its `run` task returned: TypeScript
// under tsx, Rust through rustc, Swift through swiftc, Kotlin through kotlinc and java. Nothing is added to the output
// (no trailing line break), so a test can compare a painted screen byte for byte, empty last rows included.
//
// `buildOn` stops before running and answers the command that would, for a test that runs the program somewhere of its
// own (a pseudo-terminal). A backend whose toolchain is absent answers `skipped` with the reason rather than failing, as
// the gate's own toolchain-gated suites do. The program is written to `dir` under `name`, so two tests never share a
// file.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { emitRust } from '@term/make/code/compile/rust'
import type { Resolver } from '@term/make/code/compile/load'

export type Backend = 'typescript' | 'rust' | 'swift' | 'kotlin'

export type Built =
  | { form: 'built'; command: string[] }
  | { form: 'failed'; stage: 'compile' | 'build'; reason: string }
  | { form: 'skipped'; reason: string }

export type Ran =
  | { form: 'ran'; output: string }
  | { form: 'failed'; stage: 'compile' | 'build' | 'run'; reason: string }
  | { form: 'skipped'; reason: string }

export type Program = {
  backend: Backend
  program: string
  // a function of the env, so a test can pin a `{platform}` slot
  resolve: (env: NativeEnv) => Resolver
  dir: string
  name: string
}

export const BACKENDS: Backend[] = ['typescript', 'rust', 'swift', 'kotlin']

// the env each backend compiles under, which is what fills `{platform}` before the test's resolver sees the path
const ENV: Record<Backend, NativeEnv> = { typescript: 'node', rust: 'rust', swift: 'swift', kotlin: 'kotlin' }

// the toolchain each backend needs, beyond node
const TOOLS: Record<Backend, string[]> = { typescript: [], rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

function have(tool: string): boolean {
  return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0
}

// the errors in a toolchain's output, not the warnings in front of them
function errorsOf(error: unknown): string {
  const text = String((error as { stderr?: Buffer }).stderr ?? error)
  const errors = text.split('\n').filter(line => /error:|^e: |^error\[|^\s+--> /.test(line))

  return (errors.length > 0 ? errors.join('\n') : text).slice(0, 1600)
}

// run a toolchain, answering its errors when it fails
function toolchain(args: string[]): string | undefined {
  try {
    execFileSync(args[0]!, args.slice(1), { stdio: 'pipe' })

    return undefined
  } catch (error) {
    return errorsOf(error)
  }
}

// compile `program` for `backend` and build it, answering the command that runs its `run` task and prints what it
// returned
export function buildOn({ backend, program, resolve, dir, name }: Program): Built {
  const missing = TOOLS[backend].filter(tool => !have(tool))

  if (missing.length > 0) {
    return { form: 'skipped', reason: `${missing.join(', ')} not installed` }
  }

  const env = ENV[backend]
  const stem = join(dir, `${name}-${backend}`)
  writeFileSync(`${stem}.tree`, program)
  const result = compile({ file: `${stem}.tree`, text: program }, { resolve: resolve(env), env })

  if (!result.ok) {
    return { form: 'failed', stage: 'compile', reason: [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | ') }
  }

  const fail = (reason: string | undefined, command: string[]): Built =>
    reason ? { form: 'failed', stage: 'build', reason } : { form: 'built', command }

  if (backend === 'typescript') {
    const prelude = nativePrelude(result.program, env, readRuntime, result.typescript)
    // `run` may be asynchronous (a terminal app's loop yields to the event loop), so its answer is awaited either way
    writeFileSync(`${stem}.ts`, `${prelude}\n${result.typescript}\nPromise.resolve(run()).then(text => process.stdout.write(text))\n`)

    // node with tsx's loader, never `npx`: npx draws a progress spinner whenever its output is a terminal, and a
    // program run in a pseudo-terminal then shows a stray braille glyph in its last row
    return { form: 'built', command: [process.execPath, '--import', 'tsx', `${stem}.ts`] }
  }

  if (backend === 'rust') {
    const rust = emitRust(result.program)
    writeFileSync(`${stem}.rs`, [nativePrelude(result.program, env, readRuntime, rust), rust, 'fn main() { print!("{}", run()); }', ''].join('\n'))

    // edition 2021: rustc's default is 2015, which has no `async`, and the fire-and-forget executor is async blocks
    return fail(toolchain(['rustc', '--edition', '2021', '-A', 'warnings', '-o', stem, `${stem}.rs`]), [stem])
  }

  if (backend === 'swift') {
    const swift = emitSwift(result.program)
    writeFileSync(`${stem}.swift`, ['import Foundation', nativePrelude(result.program, env, readRuntime, swift), swift, 'print(run(), terminator: "")', ''].join('\n'))

    return fail(toolchain(['swiftc', '-o', stem, `${stem}.swift`]), [stem])
  }

  const kotlin = emitKotlin(result.program)
  writeFileSync(`${stem}.kt`, `${hoistKotlinImports([nativePrelude(result.program, env, readRuntime, kotlin), kotlin, 'fun main() { print(run()) }'].join('\n'))}\n`)

  return fail(toolchain(['kotlinc', `${stem}.kt`, '-include-runtime', '-nowarn', '-d', `${stem}.jar`]), ['java', '-jar', `${stem}.jar`])
}

// compile, build and run `program` on `backend`, answering what its `run` task returned
export function runOn(input: Program): Ran {
  const built = buildOn(input)

  if (built.form !== 'built') {
    return built
  }

  const run = spawnSync(built.command[0]!, built.command.slice(1), { encoding: 'utf8' })

  return run.status === 0
    ? { form: 'ran', output: String(run.stdout) }
    : { form: 'failed', stage: 'run', reason: `exit ${run.status}: ${String(run.stderr).slice(0, 800)}` }
}
