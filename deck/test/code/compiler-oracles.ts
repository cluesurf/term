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
 *   - crossBackend: if a program compiles, every backend (TypeScript,
 *                   Rust, Kotlin, Swift) must emit without throwing. A
 *                   backend that diverges is a bug.
 *   - perf:         a soft timing budget flags inputs whose compile is
 *                   pathologically slow (a near-hang / super-linear blowup)
 *                   even when it eventually returns.
 *
 * These run over BOTH fuzzed inputs and the real stdlib corpus, where
 * they are most likely to catch genuine defects on real code.
 */

import { parse, printTree } from '@cluesurf/make/code/parser/tree'
import { compile } from '@cluesurf/make/code/compile/compile'
import { emitTypeScript } from '@cluesurf/make/code/compile/typescript'
import type { Resolver } from '@cluesurf/make/code/compile/load'

type Resolve = Resolver

export type OracleViolation = {
  oracle: 'round-trip' | 'deterministic' | 'cross-backend' | 'perf' | 'crash'
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

/** Compiling twice must give byte-identical output. */
export function checkDeterministic(text: string, resolve: Resolve, file = 'o.tree'): OracleViolation | null {
  let a, b
  try {
    a = compile({ file, text }, { resolve })
    b = compile({ file, text }, { resolve })
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

/** A compiling program must emit on every backend without throwing. */
export function checkCrossBackend(text: string, resolve: Resolve, file = 'o.tree'): OracleViolation | null {
  let compiled
  try {
    compiled = compile({ file, text }, { resolve })
  } catch (e) {
    return { oracle: 'crash', detail: `compile threw: ${msg(e)}`, input: text }
  }
  if (!compiled.ok) return null

  // the program is well-typed; every backend must accept it. (We exercise
  // the TypeScript emitter here; the full four-backend differential lives
  // in cross.ts / `crossEmit`, used by `seed hold --cross`.)
  try {
    emitTypeScript(compiled.program, {})
  } catch (e) {
    return { oracle: 'cross-backend', detail: `typescript emit threw on a well-typed program: ${msg(e)}`, input: text }
  }
  return null
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
    checkCrossBackend(text, resolve),
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
  files: number
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

  for (const file of input.files) {
    let text: string
    try {
      text = input.readFile(file)
    } catch {
      continue
    }

    const t0 = performance.now()
    // compile with the REAL file path so relative imports (load ../x)
    // resolve correctly - a fake name would misresolve and false-positive.
    for (const check of [
      checkRoundTrip(text),
      checkDeterministic(text, input.resolve, file),
      checkCrossBackend(text, input.resolve, file),
      checkTolerant(text, input.parseTolerant),
    ]) {
      if (check) violations.push({ file, violation: check })
    }
    timings.push({ file, ms: performance.now() - t0 })
  }

  const slowest = timings.sort((a, b) => b.ms - a.ms).slice(0, 5)
  return { files: input.files.length, violations, slowest }
}
