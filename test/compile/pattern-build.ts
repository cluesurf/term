// Builds one Term program for one backend on its real toolchain, runs it, and answers what it printed: the value of
// its `compute` task. Shared by the pattern differential's native leg (test/compile/pattern.ts) and the pattern
// benchmark (task/term/pattern-bench.ts), so the two build alike. Importing it runs nothing.
//
// Rust builds with cargo against the crates the native gate declares (the regex crate among them), in the target
// directory every Rust harness shares, so the crates build once. Swift and Kotlin take the stdlib's dependency flags.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { nativeFlags } from './native-flags'
import { runDir } from './run-dir'

export type Backend = 'node' | 'rust' | 'swift' | 'kotlin'

// this file is at <Term>/test/compile/. Read from the file's own URL, as native-flags.ts does: `import.meta.dirname`
// is undefined when a script outside the package (task/term/pattern-bench.ts) loads this as CommonJS
const TERM = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(TERM, '..', '..', '..', '..')
const BASE = join(TERM, 'deck', 'base')
const PREFIX = /^@term\/base\//

export const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  const file = join(BASE, path.replace(PREFIX, ''))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

const CARGO_TOML = readFileSync(join(ROOT, 'task/term/native-gate.ts'), 'utf8')
  .match(/const CARGO_TOML = `([\s\S]*?)`/)![1]!
  .replace('term-native-gate', 'term-pattern-native')

const BIG = { maxBuffer: 256 * 1024 * 1024 }

// the program's printed answer, or a thrown Error carrying the first lines of the compiler's or toolchain's errors
export function runProgram(backend: Backend, text: string, entry: string): string {
  const compiled = compile({ file: entry, text }, { resolve: withNativeEnv(backend, stdlibResolver()!), env: backend })

  if (!compiled.ok) {
    throw new Error(`did not compile: ${compiled.diagnostics.slice(0, 3).map(d => d.message).join('; ')}`)
  }

  const dir = runDir(`term-pattern-${backend}-`)

  try {
    if (backend === 'node') {
      const file = join(dir, 'program.ts')
      writeFileSync(file, `${nativePrelude(compiled.program, 'node', readRuntime)}\n${compiled.typescript}\nprocess.stdout.write(String(compute()))\n`)

      return execFileSync('npx', ['tsx', file], { ...BIG, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    }

    if (backend === 'rust') {
      const emitted = emitRust(compiled.program)
      const answer = /fn compute\(\) -> std::result::Result</.test(emitted) ? 'match compute() { Ok(v) => v, Err(e) => e.to_string() }' : 'compute()'
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'Cargo.toml'), CARGO_TOML)
      writeFileSync(join(dir, 'src', 'main.rs'), `#![allow(warnings)]\n${nativePrelude(compiled.program, 'rust', readRuntime, emitted)}\n${emitted}\nfn main() { print!("{}", ${answer}); }\n`)
      const env = { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), 'seed-rust-runtime', 'target') }
      execFileSync('cargo', ['build', '--release', '--quiet'], { ...BIG, cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })

      return execFileSync(join(env.CARGO_TARGET_DIR, 'release', 'term-pattern-native'), [], BIG).toString()
    }

    if (backend === 'swift') {
      const emitted = emitSwift(compiled.program)
      const answer = /func compute\(\) throws/.test(emitted) ? 'try! compute()' : 'compute()'
      const file = join(dir, 'program.swift')
      writeFileSync(file, `${nativePrelude(compiled.program, 'swift', readRuntime, emitted)}\n${emitted}\nprint(${answer}, terminator: "")\n`)
      execFileSync('swiftc', [...nativeFlags('swift'), '-O', '-o', join(dir, 'program'), file], { ...BIG, stdio: ['ignore', 'pipe', 'pipe'] })

      return execFileSync(join(dir, 'program'), [], BIG).toString()
    }

    const emitted = emitKotlin(compiled.program)
    const file = join(dir, 'program.kt')
    const jar = join(dir, 'program.jar')
    writeFileSync(file, hoistKotlinImports(`${nativePrelude(compiled.program, 'kotlin', readRuntime, emitted)}\n${emitted}\nfun main() { print(compute()) }\n`))
    execFileSync('kotlinc', [file, ...nativeFlags('kotlin'), '-include-runtime', '-d', jar], { ...BIG, stdio: ['ignore', 'pipe', 'pipe'] })

    return execFileSync('java', ['-Xss64m', '-jar', jar], BIG).toString()
  } catch (error) {
    const text = String((error as { stderr?: Buffer }).stderr ?? error)
    const lines = text.split('\n').filter(line => /error/.test(line)).slice(0, 6)

    throw new Error(`build or run failed\n        ${(lines.length ? lines : text.split('\n').slice(0, 6)).join('\n        ')}`)
  }
}

// a long text as a Term list of text literals, each under Kotlin's 64 KB constant. The text must hold no `<`, `>`,
// `{` or `}`: callers write digits and separators
export function chunked(data: string, size = 4000): string {
  const chunks: string[] = []

  for (let at = 0; at < data.length; at += size) {
    chunks.push(`    text <${data.slice(at, at + size)}>`)
  }

  return chunks.join('\n')
}
