// The nice TypeScript emitter. Compile AST to clean, idiomatic, native TypeScript: real names (kebab to camel),
// native control flow, plain operators, native arithmetic, types from the checker, no runtime imports. Pure and
// browser-safe: returns a string. See note/project/term/archive/computation/plans/07-codegen.md.
//
// THE FACE (self-hosting, item term-self-host-001-0069). The emitter is Term: the program pass, the analyses keyed by
// a node's place and the wake chain's entries (compile/ts-program.tree), the tables and the module around the
// statements (compile/ts-assemble.tree), the helpers that read no emitter state (compile/ts-names.tree), the runtime a
// module carries (compile/ts-preludes.tree), and every statement and expression (compile/ts-emit.tree). This face keeps
// the names callers import, hands the port a failure as a thrown `Error`, and hands the wake chain the roll values the
// port reads (decision 040) while compile.ts still hands it plain groups.
// The emitter before the collapse is tmp/retired/make/compile/typescript-face.ts.

import type { Program, Type } from '@term/make/code/compile/node'
import * as tsNames from '@term/make/code/compile/ts-names'
import * as tsPreludes from '@term/make/code/compile/ts-preludes'
import * as port from '@term/make/code/compile/ts-program'

type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }
const unbox = <T>(value: Maybe<T>): T | undefined => (value.form === 'some' ? value.value : undefined)
const boxed = <T>(value: T | undefined): Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })

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

type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
  typed?: { exceptions: Record<string, unknown>[]; tells: Record<string, unknown>[]; docks: Record<string, unknown>[] }
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

// the TypeScript identifier a seed name compiles to (kebab/snake to camelCase): plain camelCase, `make-api` is `makeApi`
export function toCamel(name: string): string {
  return tsNames.toCamel(name)
}

// a kebab / snake name to a SCREAMING_SNAKE constant (`database-url` -> `DATABASE_URL`), for environment variable names
export function toConstant(name: string): string {
  return tsNames.toConstant(name)
}

// the empty value of a type: what a left-out field holds (the same rule the Rust / Swift / Kotlin backends apply)
export function tsEmptyOf(type: Type | undefined): string {
  return tsNames.tsEmptyOf(boxed(type) as never)
}

// D10: a `need false` field typed `maybe T` is `f?: T` on TypeScript. Answers the inner type, or undefined for any other
// field (test/compile/maybe-field.ts)
export function optionalMaybe(field: { type: Type; optional?: boolean } | undefined): Type | undefined {
  return field ? (unbox(tsNames.optionalMaybe(field as never)) as Type | undefined) : undefined
}

export function toPascal(name: string): string {
  return tsNames.toPascal(name)
}

// the forms whose field-less cases are only ever their constant (compile/ts-names.tree `identity-cases`)
export function identityCases(program: Program, perModule: boolean): Set<string> {
  return new Set(tsNames.identityCases(program as never, perModule))
}

// THE TEXT OPERATIONS COUNT CODE POINTS (note/project/term/stdlib/semantics.md): compile/ts-preludes.tree's runtime
export const TEXT_PRELUDE = tsPreludes.textPreludeSource()

// the text runtime a module's code needs: the methods it names, what they name in turn, and the helpers they mention
export function textPrelude(code: string): string {
  return tsPreludes.textPrelude(code)
}

export function emitTypeScript(
  program: Program,
  // `variants` carries the enum variant names defined across the WHOLE program (per-module emit)
  options?: {
    hmr?: boolean
    variants?: Set<string>
    // a library host code also builds values of: no field-less case is tested by identity (compile.ts `library`)
    library?: boolean
    env?: string
    // exception form names defined across the WHOLE program, for the same per-module reason as `variants`
    exceptions?: Set<string>
    // the roll to wake the hive with, one group per deck, when the program loads the stdlib hive
    wake?: WakeGroup[]
    // export each top-level constant too: per-module emit (compile/modules.ts), where another module reads it
    exportConstants?: boolean
    // THE WHOLE PROGRAM, read and never emitted (per-module emit)
    context?: Program
    // the render runtime's names as the build bound them (D020)
    runtime?: { name: string; bound: string }[]
  },
): string {
  return port.emitTypeScript(
    program as never,
    boxed(options?.context) as never,
    [...(options?.variants ?? [])],
    options?.variants !== undefined,
    [...(options?.exceptions ?? [])],
    options?.library ?? false,
    options?.env ?? 'node',
    options?.hmr ?? false,
    options?.exportConstants === true,
    (options?.wake ?? []).map(wakeGroupOf) as never,
    (options?.runtime ?? []) as never,
    fail,
  )
}
