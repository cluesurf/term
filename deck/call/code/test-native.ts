// `term test --env rust|swift|kotlin`: a project's tests run on a native backend (note/term/guides/tests/backends.md).
//
// A test file builds for every backend, and a test that holds on node and not on Rust is a defect nobody sees until
// the program ships there. The standard library has had this as a repository gate (task/term/base-gate.ts); this is
// the same run for any project. Each test file is built on the backend with one more task beside its tests, the
// REPORT, which calls each test in order inside a guard and answers one letter per test: `P` it held, `F` it did not,
// `E` it raised. The program is compiled with the backend's own toolchain (cargo, swiftc, kotlinc), run, and its last
// line read back into the same results `term test` reports for node.
//
// The report is a module of its own under the project's `.base/`, loading the test file, so a lean test file is read
// lean and the report is read as it is written. The resolver hands it the test file as `term test` rewrote it (its
// `test` blocks made tasks), since the file on disk still has them.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { hashText } from '@term/make/code/term/hash'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { projectCacheDir } from '@term/call/code/cache-store'
import { projectResolver } from '@term/call/code/make'
import { cargoManifest, swiftFlags } from '@term/call/code/cask'
import type { RoleOf } from '@term/call/code/role-of'
import type { DeckOf } from '@term/make/code/compile/roll'
import type { TestResult, TestRun } from '@term/call/code/test-run'

export type NativeTestEnv = 'rust' | 'swift' | 'kotlin'

export const NATIVE_TEST_ENVS: NativeTestEnv[] = ['rust', 'swift', 'kotlin']

// what each backend needs on this machine, named in the refusal when it is not here
const TOOLS: Record<NativeTestEnv, string[]> = { rust: ['cargo'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }

// the tools a backend needs that this machine lacks
export function missingTools(env: NativeTestEnv): string[] {
  return TOOLS[env].filter(tool => spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0)
}

// the report task's name, as each backend spells it
const REPORT = 'term-test-report'
// what ends each test's entry in the report: a character no note holds
const ENTRY_END = '␞'
const SPELLED: Record<NativeTestEnv, string> = { rust: 'term_test_report', swift: 'termTestReport', kotlin: 'termTestReport' }

export async function runNativeTestFile(input: {
  root: string
  file: string
  // the file as `term test` rewrote it, its tests in source order with their labels and lines as written
  text: string
  // and the file as written, which a failing `want`'s line is read from
  source: string
  tests: { name: string; label: string; line?: number }[]
  env: NativeTestEnv
  roleOf?: RoleOf
  leanOf?: (file: string) => boolean
  deckOf?: DeckOf
}): Promise<TestRun> {
  const { root, file, env } = input
  const work = path.join(projectCacheDir(root), 'test-native', env)
  mkdirSync(work, { recursive: true })

  // the report, beside the cache, loading the test file by its path from there (inside the package, as a relative
  // load must be)
  const reportFile = path.join(projectCacheDir(root), 'test-native', `${hashText(file)}.tree`)
  const load = path.relative(path.dirname(reportFile), file).replace(/\.tree$/, '').split(path.sep).join('/')
  writeFileSync(reportFile, reportText(load.startsWith('.') ? load : `./${load}`, input.tests.map(test => test.name)))

  const base = projectResolver(root, env)
  const real = realpathSync(file)
  // the test file as rewritten, wherever the report's load lands on it
  const resolve = (importPath: string, from: string, how?: { base?: string }): Source | undefined => {
    const found = base(importPath, from, how)

    return found && (found.file === file || found.file === real) ? { file: found.file, text: input.text } : found
  }

  const result = compile(
    { file: reportFile, text: readFileSync(reportFile, 'utf8') },
    { resolve, env, roleOf: input.roleOf, leanOf: input.leanOf, deckOf: input.deckOf },
  )

  if (!result.ok) {
    // a diagnostic in the report itself is the runner's, and only one in the program is the file's
    const own = result.diagnostics.filter(d => (d.span.file ?? d.file) !== reportFile)

    return failed(`did not compile for ${env}`, own.length > 0 ? own : result.diagnostics)
  }

  const emitted = env === 'rust' ? emitRust(result.program) : env === 'swift' ? emitSwift(result.program) : emitKotlin(result.program)
  const readRuntime = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, 'utf8') : undefined)
  const prelude = nativePrelude(result.program, env, readRuntime, emitted)
  const source = `${prelude}\n${emitted}`
  const call = SPELLED[env]

  if (!new RegExp(`\\b${call}\\b`).test(emitted)) {
    return failed(`the ${env} program has no ${call}`)
  }

  const ran = env === 'rust' ? buildRust(work, source, call) : env === 'swift' ? buildSwift(work, source, call) : buildKotlin(work, source, call)

  if ('failure' in ran) {
    return failed(ran.failure)
  }

  // the report is the end of what the program printed, after anything its tests printed
  const answer = ran.out.trimEnd().split('\n').pop() ?? ''
  const entries = answer.split(ENTRY_END).slice(0, -1)

  if (entries.length !== input.tests.length || entries.some(entry => !/^[PFE]/.test(entry))) {
    return failed(`the ${env} program answered ${JSON.stringify(answer.slice(0, 80))} for ${input.tests.length} tests`)
  }

  const lines = input.source.split('\n')
  const results: TestResult[] = input.tests.map((test, at) => {
    const entry = entries[at]!
    const note = entry.slice(1)
    // a failing `want` raises its line, which is said as node says it, with the line as written
    const want = /^want:(\d+)$/.exec(note)
    const why = want
      ? `line ${want[1]} did not hold on ${env}: ${lines[Number(want[1]) - 1]?.trim() ?? ''}`
      : `it raised on ${env}${note ? `: ${note}` : ''}`

    return {
      name: test.name,
      label: test.label,
      held: entry[0] === 'P',
      ...(want ? { line: Number(want[1]) } : test.line !== undefined ? { line: test.line } : {}),
      ...(entry[0] === 'E' ? { error: why } : {}),
    }
  })

  return { ok: results.every(one => one.held), results }
}

function failed(failure: string, diagnostics: Diagnostic[] = []): TestRun {
  return { ok: false, results: [], failure, diagnostics }
}

// one entry per test, each test called inside a guard and each entry ended by ENTRY_END: `P` held, `F` did not, `E`
// and the raise's note when it raised, which for a failing `want` names its line (`want:11`)
function reportText(load: string, names: string[]): string {
  const lines = [`load ${load}`, ...names.map(name => `  find ${name}`), '', `task ${REPORT}`, '  like text', '  save out, text <>']

  for (const name of names) {
    lines.push(
      '  mark unsafe',
      '    fork test',
      '      hook test',
      `        call ${name}`,
      '      hook hold',
      `        save out, text <{out}P${ENTRY_END}>`,
      '      hook miss',
      `        save out, text <{out}F${ENTRY_END}>`,
      '  halt take',
      '    take problem',
      `    save out, text <{out}E{problem/note}${ENTRY_END}>`,
    )
  }

  lines.push('  send back, read out', '')

  return lines.join('\n')
}

type Ran = { out: string } | { failure: string }

const firstError = (text: string, pattern: RegExp): string =>
  (text.split('\n').find(line => pattern.test(line)) ?? text.split('\n')[0] ?? 'the build failed').slice(0, 240)

// run a built program, a minute at most, its standard output when it exits 0
function runBuilt(command: string, args: string[]): Ran {
  const ran = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })

  if (ran.status !== 0) {
    return { failure: `the program stopped (exit ${ran.status ?? ran.signal}): ${firstError(ran.stderr ?? '', /./)}` }
  }

  return { out: ran.stdout }
}

// a cargo project, its target directory kept between runs so the crates build once
function buildRust(work: string, source: string, call: string): Ran {
  const project = path.join(work, 'cargo')
  mkdirSync(path.join(project, 'src'), { recursive: true })

  const asynchronous = new RegExp(`async fn ${call}\\(`).test(source)
  const raising = new RegExp(`fn ${call}\\(\\)[^{]*-> std::result::Result`).test(source)
  const value = asynchronous ? `${call}().await` : `${call}()`
  const shown = raising ? `${value}.unwrap_or_else(|e| e.to_string())` : value
  const main = asynchronous
    ? `#[tokio::main]\nasync fn main() { print!("{}", ${shown}); }\n`
    : `fn main() { print!("{}", ${shown}); }\n`
  const program = `#![allow(warnings)]\n${source}\n${main}`

  writeFileSync(path.join(project, 'src', 'main.rs'), program)
  writeFileSync(path.join(project, 'Cargo.toml'), cargoManifest('term-test', program))

  try {
    execFileSync('cargo', ['build', '--quiet'], { cwd: project, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    return { failure: `cargo could not build it: ${firstError(String((error as { stderr?: Buffer }).stderr ?? error), /^error/)}` }
  }

  return runBuilt(path.join(project, 'target', 'debug', 'term-test'), [])
}

function buildSwift(work: string, source: string, call: string): Ran {
  const file = path.join(work, 'test.swift')
  const exe = path.join(work, 'test')
  const raising = new RegExp(`func ${call}\\(\\)[^{]*throws`).test(source)
  const asynchronous = new RegExp(`func ${call}\\(\\)[^{]*async`).test(source)
  const value = `${raising ? 'try ' : ''}${asynchronous ? 'await ' : ''}${call}()`
  const driver = raising
    ? `do { print(${value}, terminator: "") } catch { print("\\(error)", terminator: "") }\n`
    : `print(${value}, terminator: "")\n`

  writeFileSync(file, `${source}\n${driver}`)

  try {
    execFileSync('swiftc', [...swiftFlags(), '-o', exe, file], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    return { failure: `swiftc could not build it: ${firstError(String((error as { stderr?: Buffer }).stderr ?? error), /error:/)}` }
  }

  return runBuilt(exe, [])
}

// the classpath the Kotlin backend's runtime needs (coroutines, ktor), where task/term/native/kotlin.sh `deps` keeps
// it: the same cache the Swift flags are read from
function kotlinClasspath(): string | undefined {
  const cache = process.env.TERM_NATIVE_CACHE ?? path.join(process.env.TMPDIR ?? tmpdir(), 'term-native')
  const file = path.join(cache, 'kotlin', 'classpath.txt')

  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
}

function buildKotlin(work: string, source: string, call: string): Ran {
  const file = path.join(work, 'TermTest.kt')
  const jar = path.join(work, 'term-test.jar')
  const asynchronous = new RegExp(`suspend fun ${call}\\(`).test(source)
  const driver = asynchronous
    ? `fun main() { print(kotlinx.coroutines.runBlocking { ${call}() }) }\n`
    : `fun main() { print(${call}()) }\n`
  const classpath = kotlinClasspath()

  writeFileSync(file, hoistKotlinImports(`${source}\n${driver}`))

  try {
    execFileSync('kotlinc', [file, ...(classpath ? ['-classpath', classpath] : []), '-include-runtime', '-nowarn', '-d', jar], {
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    return { failure: `kotlinc could not build it: ${firstError(String((error as { stderr?: Buffer }).stderr ?? error), /error/)}` }
  }

  return runBuilt('java', ['-cp', [jar, ...(classpath ? [classpath] : [])].join(':'), 'TermTestKt'])
}
