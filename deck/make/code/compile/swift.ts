// The Swift backend: emit the language as idiomatic, type-static Swift. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE generic enums (`enum Maybe<T> { case some(value: T); case none }`),
// `match` to native `if case let` pattern binding, and struct forms to `struct`s. Construction uses leading-dot syntax so
// Swift infers the type parameter from context. Pure, browser-safe. See note/project/term/archive/computation/plans/07-codegen.md.
//
// THE FACE (self-hosting, item term-self-host-001-0066). The emitter is Term: the program pass, the analyses keyed by a
// node's place, the preludes, the conformances and the wake chain (compile/swift-program.tree), the helpers that read
// no emitter state (compile/swift-names.tree), and every statement and expression (compile/swift-emit.tree). This face
// keeps the names callers import and hands the wake chain the roll values the port reads (decision 040) while
// compile.ts still hands it the plain groups compile/wake.ts names.
// The emitter before the collapse is tmp/retired/make/compile/swift-face.ts.

import type { Program } from '@term/make/code/compile/node'
import type { WakeGroup } from '@term/make/code/compile/wake'
import * as port from '@term/make/code/compile/swift-program'

type RollValue =
  | { form: 'no-value' }
  | { form: 'null-value' }
  | { form: 'text-value'; value: string }
  | { form: 'number-value'; value: number }
  | { form: 'flag-value'; value: boolean }
  | { form: 'item-values'; values: RollValue[] }
  | { form: 'pair-values'; pairs: { key: string; value: RollValue }[] }

// a plain wake entry as the roll value it was made from (compile.ts `plainValue` read backwards)
function rollValue(value: unknown): RollValue {
  if (value === undefined) return { form: 'no-value' }
  if (value === null) return { form: 'null-value' }
  if (typeof value === 'string') return { form: 'text-value', value }
  if (typeof value === 'number') return { form: 'number-value', value }
  if (typeof value === 'boolean') return { form: 'flag-value', value }
  if (Array.isArray(value)) return { form: 'item-values', values: value.map(rollValue) }

  return { form: 'pair-values', pairs: Object.entries(value as object).map(([key, one]) => ({ key, value: rollValue(one) })) }
}

const wakeGroupOf = (group: WakeGroup): unknown => ({
  deck: group.deck,
  entries: group.entries.map(rollValue),
  exceptions: (group.typed?.exceptions ?? []).map(rollValue),
  tells: (group.typed?.tells ?? []).map(rollValue),
  docks: (group.typed?.docks ?? []).map(rollValue),
})

// The text operations by code point (note/project/term/stdlib/semantics.md), as the program's prelude writes them
export const SWIFT_TEXT: string = port.swiftTextText()

// with `units`, each module's statements stay marked, for the caller to write one file per module
// (compile/unit-split.tree)
export function emitSwift(written: Program, options?: { wake?: WakeGroup[]; units?: boolean }): string {
  return port.emitSwift(written as never, (options?.wake ?? []).map(wakeGroupOf) as never, Boolean(options?.units))
}
