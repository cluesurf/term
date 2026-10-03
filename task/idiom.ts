// pnpm term:idiom: is the emitted code idiomatic, as the target's own tools judge it (note/term/codegen/readme.md,
// rule 4). Every program under bench/ and every meaning-native fixture is emitted with its prelude on all four
// targets: Rust linted with `clippy::all`, TypeScript typechecked with `tsc --strict`, Swift and Kotlin counted by
// their compilers' own warnings and errors. The findings are counted by kind, and the total is the gate: it may only
// fall. swiftlint, ktlint and detekt join when they are installed on the machine that runs this.
//
//   pnpm term:idiom            report
//   pnpm term:idiom --max 0    fail when the total is above the number

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'

const TERM = join(import.meta.dirname, '..')
const base = join(TERM, 'deck/base')
const out = join(TERM, 'tmp', 'idiom')
mkdirSync(out, { recursive: true })
// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
const stdlib = stdlibResolver()!
const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

const programs = [
  ...readdirSync(join(TERM, 'bench'))
    .filter(name => existsSync(join(TERM, 'bench', name, 'term.tree')))
    .map(name => ({ name, file: join(TERM, 'bench', name, 'term.tree') })),
  ...readdirSync(join(TERM, 'test/compile/meaning-native'))
    .filter(name => name.endsWith('.tree'))
    .map(name => ({ name: `meaning/${name.replace(/\.tree$/, '')}`, file: join(TERM, 'test/compile/meaning-native', name) })),
]

const lints = new Map<string, number>()
let total = 0

for (const { name, file } of programs) {
  const built = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: withNativeEnv('rust', stdlib), env: 'rust' })

  if (!built.ok) {
    console.log(`  ${name.padEnd(28)} does not build: ${built.diagnostics[0]?.message}`)
    continue
  }

  const path = join(out, `${name.replace(/\//g, '-')}.rs`)
  writeFileSync(path, `${nativePrelude(built.program, 'rust', readRuntime)}\n${emitRust(built.program)}\nfn main() {}\n`)
  const ran = spawnSync('clippy-driver', ['--edition', '2021', '-W', 'clippy::all', '-A', 'dead_code', '-A', 'unused', '-o', join(out, 'lint-out'), path], { encoding: 'utf8' })
  // every finding carries exactly one documentation link, which names its lint
  const found = [...ran.stderr.matchAll(/https:\/\/rust-lang\.github\.io\/rust-clippy\/[^#\s]+#([a-z_]+)/g)].map(m => m[1]!)
  const count = found.length

  for (const lint of found) {
    lints.set(lint, (lints.get(lint) ?? 0) + 1)
  }

  total += count
  console.log(`  ${name.padEnd(28)} ${String(count).padStart(4)} clippy findings${ran.status !== 0 && !/warning/.test(ran.stderr) ? '  (did not compile)' : ''}`)
}

console.log(`\nrust: ${total} clippy findings over ${programs.length} programs`)

for (const [lint, count] of [...lints].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${lint}`)
}

// TypeScript: the same programs emitted for node, typechecked together by `tsc --strict`
const tsFiles: string[] = []

for (const { name, file } of programs) {
  const built = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: withNativeEnv('node', stdlib), env: 'node' })

  if (!built.ok) {
    continue
  }

  // each file a module of its own, so two programs' declarations never meet
  const path = join(out, `${name.replace(/\//g, '-')}.ts`)
  writeFileSync(path, `${nativePrelude(built.program, 'node', readRuntime)}\n${built.typescript}\nexport {}\n`)
  tsFiles.push(path)
}

// es2023: the emitted code targets node 20, which has `toReversed` and the other ES2023 array methods it uses
const tsc = spawnSync('npx', ['tsc', '--noEmit', '--strict', '--target', 'es2022', '--lib', 'es2023', '--types', 'node', '--skipLibCheck', ...tsFiles], { cwd: TERM, encoding: 'utf8' })
const tsErrors = (tsc.stdout.match(/error TS\d+/g) ?? []).length

for (const path of tsFiles) {
  const own = (tsc.stdout.split('\n').filter(line => line.startsWith(path.slice(TERM.length + 1)) || line.startsWith(path)).length)
  console.log(`  ${path.slice(out.length + 1).padEnd(30)} ${String(own).padStart(4)} tsc --strict errors`)
}

console.log(`\ntypescript: ${tsErrors} tsc --strict errors over ${tsFiles.length} programs`)
total += tsErrors

// Swift and Kotlin: no linter is installed here (swiftlint, ktlint and detekt join when one is), so the compilers'
// own warnings stand in. They are idiom findings all the same: a `var` never mutated, a value never read, a cast that
// always succeeds, code after a `return`
const warned = (label: string, text: string, files: string[]): number => {
  const counts = new Map<string, number>()
  let sum = 0

  // swiftc writes `path:line:col: warning: message`, kotlinc `w: file:///path:line:col message`. An error counts too,
  // so a program that stopped compiling can never read as a clean zero
  for (const [, kotlin, file, swift, message] of text.matchAll(/^(?:([we]): )?(?:file:\/\/)?(\/[^:\s]+):\d+:\d+:? (?:(warning|error): )?(.*)$/gm)) {
    const severity = swift ?? (kotlin === 'e' ? 'error' : kotlin === 'w' ? 'warning' : undefined)

    if (!severity || !files.some(f => f === file)) {
      continue
    }

    // the message, its specifics dropped, names the finding
    const name = `${severity === 'error' ? 'ERROR ' : ''}${message!.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '_')}`.slice(0, 76)
    counts.set(name, (counts.get(name) ?? 0) + 1)
    sum++
  }

  console.log(`\n${label}: ${sum} compiler warnings over ${files.length} programs`)

  for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${name}`)
  }

  return sum
}

const which = (tool: string): boolean => spawnSync('which', [tool]).status === 0

if (which('swiftc')) {
  const swiftFiles: string[] = []
  let text = ''

  for (const { name, file } of programs) {
    const built = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: withNativeEnv('swift', stdlib), env: 'swift' })

    if (!built.ok) {
      continue
    }

    const path = join(out, `${name.replace(/\//g, '-')}.swift`)
    writeFileSync(path, `${nativePrelude(built.program, 'swift', readRuntime)}\n${emitSwift(built.program)}\n`)
    swiftFiles.push(path)
    const ran = spawnSync('swiftc', ['-typecheck', path], { encoding: 'utf8' })
    text += ran.stderr
  }

  total += warned('swift', text, swiftFiles)
}

if (which('kotlinc')) {
  const kotlinFiles: string[] = []

  for (const { name, file } of programs) {
    const built = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: withNativeEnv('kotlin', stdlib), env: 'kotlin' })

    if (!built.ok) {
      continue
    }

    // a package each, so one kotlinc run takes them all and two programs' declarations never meet
    const path = join(out, `${name.replace(/\//g, '-')}.kt`)
    const pkg = `idiom.${name.replace(/[^a-z0-9]+/gi, '_')}`
    writeFileSync(path, `package ${pkg}\n${hoistKotlinImports(`${nativePrelude(built.program, 'kotlin', readRuntime)}\n${emitKotlin(built.program)}\n`)}`)
    kotlinFiles.push(path)
  }

  const ran = spawnSync('kotlinc', [...kotlinFiles, '-d', join(out, 'kotlin-out')], { encoding: 'utf8' })
  total += warned('kotlin', ran.stderr, kotlinFiles)
}

const max = process.argv.indexOf('--max')

if (max >= 0 && total > Number(process.argv[max + 1])) {
  console.log(`\nabove the gate of ${process.argv[max + 1]}`)
  process.exit(1)
}
