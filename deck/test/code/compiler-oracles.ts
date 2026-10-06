/**
 * Metamorphic + differential oracles for the Seed compiler. A fuzzer
 * that only checks "did it crash?" misses bugs where the compiler
 * returns the WRONG answer without crashing. These oracles encode
 * properties a correct compiler must satisfy on EVERY input, so a
 * violation is a real bug even when nothing throws:
 *
 *   - roundTrip:    the canonical printed form is a fixpoint of parse.
 *                   printTree(parse(printTree(parse(x)))) must equal
 *                   printTree(parse(x)). A mismatch is a parser/printer
 *                   bug (the printed tree reparses to a different tree).
 *   - deterministic: compiling the same source twice yields identical
 *                   output. Non-determinism is a bug (and breaks caching).
 *   - backendEmit:  if a program compiles, every backend (TypeScript,
 *                   Rust, Kotlin, Swift) must emit non-empty code without
 *                   throwing. EMIT ONLY: the outputs are not built, run or
 *                   compared with each other. This was called
 *                   `cross-backend` and exercised the TypeScript emitter
 *                   alone, so the name claimed a comparison it never made.
 *                   A run-and-compare across toolchains is
 *                   test/compile/host-native.ts.
 *   - perf:         a soft timing budget flags inputs whose compile is
 *                   pathologically slow (a near-hang / super-linear blowup)
 *                   even when it eventually returns.
 *
 * These run over BOTH fuzzed inputs and the real stdlib corpus, where
 * they are most likely to catch genuine defects on real code.
 */

import { parse, printTree } from '@term/make/code/parser/tree'
import { compile } from '@term/make/code/compile/compile'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import { emitRust } from '@term/make/code/compile/rust'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { emitSwift } from '@term/make/code/compile/swift'
import type { Resolver } from '@term/make/code/compile/load'

type Resolve = Resolver

/** The emitters the backend-emit oracle drives, in order. */
export const EMIT_BACKENDS: { name: string; emit: (program: any) => string }[] = [
  { name: 'typescript', emit: program => emitTypeScript(program, {}) },
  { name: 'rust', emit: program => emitRust(program) },
  { name: 'kotlin', emit: program => emitKotlin(program) },
  { name: 'swift', emit: program => emitSwift(program) },
]

export type OracleViolation = {
  oracle: 'round-trip' | 'deterministic' | 'backend-emit' | 'perf' | 'crash'
  detail: string
  input: string
}

/** Canonical-form fixpoint: re-parsing the printed tree must be stable. */
export function checkRoundTrip(text: string): OracleViolation | null {
  let first
  try {
    first = parse({ file: 'o.tree', text })
  } catch (e) {
    return { oracle: 'crash', detail: `parse threw: ${msg(e)}`, input: text }
  }
  if (!first.ok) return null // only valid programs have a canonical form to compare

  let printed1: string
  try {
    printed1 = printTree(first.tree)
  } catch (e) {
    return { oracle: 'crash', detail: `printTree threw: ${msg(e)}`, input: text }
  }

  let second
  try {
    second = parse({ file: 'o.tree', text: printed1 })
  } catch (e) {
    return { oracle: 'crash', detail: `re-parse of printed form threw: ${msg(e)}`, input: printed1 }
  }
  if (!second.ok) {
    return { oracle: 'round-trip', detail: 'printed canonical form does not re-parse', input: printed1 }
  }

  const printed2 = printTree(second.tree)
  if (printed1 !== printed2) {
    return { oracle: 'round-trip', detail: 'canonical form is not a parse fixpoint', input: text }
  }
  return null
}

// a compile, and how long it took, handed to `timed` when given
function compileTimed(text: string, resolve: Resolve, file: string, timed?: (ms: number) => void): ReturnType<typeof compile> {
  const started = performance.now()
  const result = compile({ file, text }, { resolve })
  timed?.(performance.now() - started)

  return result
}

/** Compiling twice must give byte-identical output. `timed` is handed each compile's time. */
export function checkDeterministic(text: string, resolve: Resolve, file = 'o.tree', timed?: (ms: number) => void): OracleViolation | null {
  let a, b
  try {
    a = compileTimed(text, resolve, file, timed)
    b = compileTimed(text, resolve, file, timed)
  } catch (e) {
    return { oracle: 'crash', detail: `compile threw: ${msg(e)}`, input: text }
  }
  if (a.ok !== b.ok) {
    return { oracle: 'deterministic', detail: `compile ok differs across runs (${a.ok} vs ${b.ok})`, input: text }
  }
  if (a.ok && b.ok && a.typescript !== b.typescript) {
    return { oracle: 'deterministic', detail: 'emitted TypeScript differs across identical runs', input: text }
  }
  return null
}

/**
 * A compiling program must emit non-empty code on every backend without throwing. Emit only: nothing is built or
 * run, so two backends that emit different behavior both pass. Returns one violation per backend that failed.
 */
export function checkBackendEmit(text: string, resolve: Resolve, file = 'o.tree'): OracleViolation[] {
  return backendEmit(text, resolve, file).violations
}

/** The backend-emit oracle, also saying whether the program compiled (so a caller can count what was emitted). */
export function backendEmit(
  text: string,
  resolve: Resolve,
  file = 'o.tree',
  timed?: (ms: number) => void,
): { compiled: boolean; violations: OracleViolation[] } {
  let compiled
  try {
    compiled = compileTimed(text, resolve, file, timed)
  } catch (e) {
    return { compiled: false, violations: [{ oracle: 'crash', detail: `compile threw: ${msg(e)}`, input: text }] }
  }
  if (!compiled.ok) return { compiled: false, violations: [] }

  const out: OracleViolation[] = []
  for (const backend of EMIT_BACKENDS) {
    try {
      const emitted = backend.emit(compiled.program)
      if (typeof emitted !== 'string' || emitted.length === 0) {
        out.push({ oracle: 'backend-emit', detail: `${backend.name} emitted nothing for a well-typed program`, input: text })
      }
    } catch (e) {
      out.push({ oracle: 'backend-emit', detail: `${backend.name} emit threw on a well-typed program: ${msg(e)}`, input: text })
    }
  }
  return { compiled: true, violations: out }
}

/** Flag a compile that exceeds a soft time budget (near-hang / blowup). */
export function checkPerf(text: string, resolve: Resolve, budgetMs: number): OracleViolation | null {
  const t0 = performance.now()
  try {
    compile({ file: 'o.tree', text }, { resolve })
  } catch {
    return null // crashes are caught by other oracles
  }
  const ms = performance.now() - t0
  if (ms > budgetMs) {
    return { oracle: 'perf', detail: `compile took ${ms.toFixed(0)}ms (budget ${budgetMs}ms)`, input: text }
  }
  return null
}

/** Run every oracle on one input; return all violations. */
export function checkAll(input: {
  text: string
  resolve: Resolve
  perfBudgetMs?: number
}): OracleViolation[] {
  const { text, resolve } = input
  const out: OracleViolation[] = []
  for (const v of [
    checkRoundTrip(text),
    checkDeterministic(text, resolve),
    ...checkBackendEmit(text, resolve),
    checkPerf(text, resolve, input.perfBudgetMs ?? 1000),
  ]) {
    if (v) out.push(v)
  }
  return out
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Editor robustness: the tolerant parser must NEVER throw, on any
 * input - it is what powers completion on incomplete / broken code. */
export function checkTolerant(text: string, parseTolerant: (s: { file: string; text: string }) => unknown): OracleViolation | null {
  try {
    parseTolerant({ file: 'o.tree', text })
    return null
  } catch (e) {
    return { oracle: 'crash', detail: `parseTolerant threw (editor would crash): ${msg(e)}`, input: text }
  }
}

export type CorpusAudit = {
  // files actually READ and checked, never the length of the list handed in
  files: number
  // files in the list that could not be read; reported, never silently dropped
  unreadable: string[]
  // files that compiled, so the backend-emit oracle had something to emit
  compiled: number
  violations: { file: string; violation: OracleViolation }[]
  slowest: { file: string; ms: number }[]
}

/**
 * Run the metamorphic + differential oracles over a real corpus of files
 * (e.g. the stdlib). This is where the oracles catch genuine defects on
 * real code, not just fuzzed noise. `readFile` and `parseTolerant` are
 * injected so this stays free of node/compiler import coupling.
 */
export function auditCorpus(input: {
  files: string[]
  readFile: (path: string) => string
  resolve: Resolve
  parseTolerant: (s: { file: string; text: string }) => unknown
  perfBudgetMs?: number
}): CorpusAudit {
  const violations: { file: string; violation: OracleViolation }[] = []
  const timings: { file: string; ms: number }[] = []
  const unreadable: string[] = []
  let compiled = 0

  for (const file of input.files) {
    let text: string
    try {
      text = input.readFile(file)
    } catch {
      unreadable.push(file)
      continue
    }

    const t0 = performance.now()
    // the FASTEST of the file's three compiles (one to emit, two for determinism) is what is held to the budget: the
    // first pays for loading the file's imports, and a budget is about the compiler, not a cold cache. The budget
    // was taken and never read until 2026-10-05
    let fastest = Number.POSITIVE_INFINITY
    const timed = (ms: number): void => {
      fastest = Math.min(fastest, ms)
    }
    // compile with the REAL file path so relative imports (load ../x)
    // resolve correctly - a fake name would misresolve and false-positive.
    const emitted = backendEmit(text, input.resolve, file, timed)
    if (emitted.compiled) compiled++
    const deterministic = checkDeterministic(text, input.resolve, file, timed)
    const budget = input.perfBudgetMs
    const perf: OracleViolation | null =
      budget !== undefined && fastest > budget
        ? { oracle: 'perf', detail: `compile took ${fastest.toFixed(0)}ms, the fastest of three (budget ${budget}ms)`, input: text }
        : null
    for (const check of [
      checkRoundTrip(text),
      deterministic,
      ...emitted.violations,
      checkTolerant(text, input.parseTolerant),
      perf,
    ]) {
      // two oracles that both compile see the same throw; report it once per file
      if (
        check &&
        !violations.some(
          v => v.file === file && v.violation.oracle === check.oracle && v.violation.detail === check.detail,
        )
      ) {
        violations.push({ file, violation: check })
      }
    }
    timings.push({ file, ms: performance.now() - t0 })
  }

  const slowest = timings.sort((a, b) => b.ms - a.ms).slice(0, 5)
  return { files: timings.length, unreadable, compiled, violations, slowest }
}
