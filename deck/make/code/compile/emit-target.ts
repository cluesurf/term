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
