// ONE program's complete source for one backend, from a compile that succeeded: the runtime shims the program docks
// (`nativePrelude`), then the backend's emit. What `term make --emit <target>` writes (call/code/emit.ts) and what the
// browser worker shows (call/code/browser/worker.ts), so the two cannot say different things about the same program.
//
// Browser-safe: no `fs`, no `path`. The caller hands over how to read a runtime shim, from disk or from a snapshot.
//
//   node     TypeScript, ESM, with the shims the program docks in front
//   rust     one `.rs` file for `rustc`
//   swift    one `.swift` file for `swiftc`
//   kotlin   one `.kt` file for `kotlinc`, every import hoisted to the top

import type { Program } from '@term/make/code/compile/node'
import { joinTypeScriptPrelude, nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { splitUnits } from '@term/make/code/compile/unit-split'

export const EMIT_TARGETS = ['node', 'rust', 'swift', 'kotlin'] as const

export type EmitTarget = (typeof EMIT_TARGETS)[number]

export function isEmitTarget(value: string): value is EmitTarget {
  return (EMIT_TARGETS as readonly string[]).includes(value)
}

// the source for one target. `typescript` is the compile's own TypeScript, which the `node` target uses as it is; the
// native targets emit from `program`. The compile must have been run with `env` set to the same target, because the
// env decides which `{platform}` modules the program was built from.
export function emitTarget(input: {
  program: Program
  typescript: string
  target: EmitTarget
  readRuntime: (path: string) => string | undefined
}): string {
  const prelude = nativePrelude(input.program, input.target, input.readRuntime)

  switch (input.target) {
    case 'node':
      return joinTypeScriptPrelude(prelude, input.typescript)
    case 'rust':
      return `${prelude}\n${emitRust(input.program)}`
    case 'swift':
      return `${prelude}\n${emitSwift(input.program)}`
    case 'kotlin':
      return hoistKotlinImports(`${prelude}\n${emitKotlin(input.program)}`)
  }
}

// THE SAME PROGRAM AS FILES, ONE PER TERM MODULE (compile/unit-split.ts, note/term/plan/incremental-best-in-class.md,
// step 15): every decision still made over the whole program, and each module's statements in a file of their own
// beside one shared file, so an edit to a module changes that module's file alone and the toolchain's incremental
// build redoes what it holds. `main` is the file a toolchain starts from:
//
//   rust     main.rs, the runtime and every `include!("u_<module>.rs")`: one crate, one namespace, as the one file was
//   swift    Term.swift and U_<module>.swift, one module: every file of it shares one namespace
//   kotlin   Term.kt and U_<module>.kt, one package, every file with every import hoisted
export type UnitFiles = { main: string; files: [string, string][] }

export function emitTargetUnits(input: {
  program: Program
  target: Exclude<EmitTarget, 'node'>
  readRuntime: (path: string) => string | undefined
}): UnitFiles {
  const prelude = nativePrelude(input.program, input.target, input.readRuntime)

  switch (input.target) {
    case 'rust': {
      const { shared, units } = splitUnits(`${prelude}\n${emitRust(input.program, { units: true })}`)
      const named = units.map(([file, text]) => [`u_${unitName(file)}.rs`, text] as const)
      const main = `${shared.trimEnd()}\n\n${named.map(([name]) => `include!("${name}");`).join('\n')}\n`

      return { main: 'main.rs', files: [['main.rs', main], ...named] }
    }
    case 'swift': {
      const { shared, units } = splitUnits(`${prelude}\n${emitSwift(input.program, { units: true })}`)
      const imports = importLines(shared, /^import .+$/gm)

      return { main: 'Term.swift', files: [['Term.swift', shared], ...units.map(([file, text]) => [`U_${unitName(file)}.swift`, `${imports}${text}`] as [string, string])] }
    }
    case 'kotlin': {
      const { shared, units } = splitUnits(hoistKotlinImports(`${prelude}\n${emitKotlin(input.program, { units: true })}`))
      const imports = importLines(shared, /^(package|import) .+$/gm)

      return { main: 'Term.kt', files: [['Term.kt', shared], ...units.map(([file, text]) => [`U_${unitName(file)}.kt`, `${imports}${text}`] as [string, string])] }
    }
  }
}

// a module's file name: the end of its path in identifier characters, and a short hash of the whole path, so two
// modules of one name in two folders never meet and the name stays readable (a Kotlin file names a JVM class)
function unitName(file: string): string {
  const tail = file
    .replace(/\.tree$/, '')
    .split('/')
    .slice(-3)
    .join('_')
    .replace(/[^A-Za-z0-9]/g, '_')
  let hash = 5381

  for (let at = 0; at < file.length; at++) {
    hash = ((hash * 33) ^ file.charCodeAt(at)) >>> 0
  }

  return `${tail}_${hash.toString(36)}`
}

// the import lines of a file, each unit file's head: a Swift or Kotlin file sees only the modules it imports itself
function importLines(text: string, pattern: RegExp): string {
  const lines = text.match(pattern) ?? []

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : ''
}
