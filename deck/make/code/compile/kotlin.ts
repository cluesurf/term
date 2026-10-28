// The Kotlin backend: emit the language as idiomatic, type-static Kotlin. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE sealed-class hierarchies (`sealed class Maybe<out T>` with a
// subclass per variant), `match` to an exhaustive `when (subject) { is MaybeSome -> ... }` whose smart-casts make a
// variant's fields directly accessible, and struct forms to `data class`es. Pure, browser-safe. See
// note/project/term/archive/computation/plans/07-codegen.md.
//
// THE FACE (self-hosting, item term-self-host-001-0067). The emitter is Term: the program pass, the analyses keyed by a
// node's place, the runtime texts and the import hoist (compile/kotlin-program.tree), the helpers that read no emitter
// state (compile/kotlin-names.tree), the analyses the emitter reads (compile/kotlin-facts.tree), and every statement
// and expression (compile/kotlin-emit.tree). This face keeps the names callers import, hands the port a failure as a
// thrown `Error`, and hands the wake chain the roll values the port reads (decision 040) while compile.ts still hands it
// the plain groups compile/wake.ts names.
// The emitter before the collapse is tmp/retired/make/compile/kotlin-face.ts.

import type { Program } from '@term/make/code/compile/node'
import type { WakeGroup } from '@term/make/code/compile/wake'
import * as port from '@term/make/code/compile/kotlin-program'

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

const fail = (reason: string): boolean => {
  throw new Error(reason)
}

// The text operations by code point (note/project/term/stdlib/semantics.md), as the program's prelude writes them
export const KOTLIN_TEXT: string = port.kotlinTextText()

// A list of integers held in one LongArray (test/compile/kotlin-longs.ts holds it against ArrayList)
export const KOTLIN_LONGS: string = port.kotlinLongsText()

// every `import` line of a built program's FINAL `prelude + program` text at the top, deduplicated, in order
export function hoistKotlinImports(source: string): string {
  return port.hoistKotlinImports(source)
}

// with `units`, each module's statements stay marked, for the caller to write one file per module
// (compile/unit-split.tree)
export function emitKotlin(written: Program, options?: { wake?: WakeGroup[]; units?: boolean }): string {
  return port.emitKotlin(written as never, (options?.wake ?? []).map(wakeGroupOf) as never, Boolean(options?.units), fail)
}
