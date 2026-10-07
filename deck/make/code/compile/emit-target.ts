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
//
// Which target runs what, how the texts are put together and how a program is cut into one file per module are Term,
// compile/target-source.tree (self-hosting, 2026-10-07). This face hands that module the emitters, which are
// TypeScript today, and the prelude closed over the caller's way to read a shim.

import type { Program } from '@term/make/code/compile/node'
import { joinTypeScriptPrelude, nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import * as source from '@term/make/code/compile/target-source'

export type EmitTarget = 'node' | 'rust' | 'swift' | 'kotlin'

export const EMIT_TARGETS = source.listEmitTargets() as unknown as readonly EmitTarget[]

export function isEmitTarget(value: string): value is EmitTarget {
  return source.isEmitTarget(value)
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
  return source.emitTarget(
    input.program,
    input.typescript,
    input.target,
    (program, target) => nativePrelude(program, target, input.readRuntime),
    joinTypeScriptPrelude,
    program => emitRust(program),
    program => emitSwift(program),
    program => emitKotlin(program),
    hoistKotlinImports,
  )
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
  const written = source.emitTargetUnits(
    input.program,
    input.target,
    (program, target) => nativePrelude(program, target, input.readRuntime),
    program => emitRust(program, { units: true }),
    program => emitSwift(program, { units: true }),
    program => emitKotlin(program, { units: true }),
    hoistKotlinImports,
  )

  return { main: written.main, files: written.files.map(file => [file.name, file.text] as [string, string]) }
}
