/**
 * Counterexample-Guided Inductive Synthesis (CEGIS): synthesize a
 * function body from a specification, automatically, by letting the
 * verifier hand back counterexamples that carve away the wrong-program
 * space until a correct program remains.
 *
 * This is Level 3 of the synthesis design (note/methodology/
 * verification/synthesis.md), and the runnable proof that "the verifier
 * figures out what code to add" is real: you give it the spec (what
 * correct means) and a grammar (the shape of allowed code), and it
 * returns a program the verifier accepts.
 *
 * The grammar here is a small integer-expression language over named
 * inputs. The verifier is the property engine in ./property. The loop
 * is the classic CEGIS skeleton, deterministic throughout.
 */

import { check, genInt, genTuple, type Gen } from './property'

// --- the expression grammar (the synthesis target) ---

export type Expr =
  | { form: 'var'; index: number }
  | { form: 'const'; value: number }
  | { form: 'add'; left: Expr; right: Expr }
  | { form: 'sub'; left: Expr; right: Expr }
  | { form: 'min'; left: Expr; right: Expr }
  | { form: 'max'; left: Expr; right: Expr }
  | { form: 'ite'; test: Cond; then: Expr; else: Expr }

/** A boolean condition over two expressions. */
export type Cond =
  | { form: 'ge'; left: Expr; right: Expr }
  | { form: 'gt'; left: Expr; right: Expr }
  | { form: 'eq'; left: Expr; right: Expr }

/** Evaluate an expression against a tuple of input values. */
export function evalExpr(expr: Expr, inputs: number[]): number {
  switch (expr.form) {
    case 'var':
      return inputs[expr.index]
    case 'const':
      return expr.value
    case 'add':
      return evalExpr(expr.left, inputs) + evalExpr(expr.right, inputs)
    case 'sub':
      return evalExpr(expr.left, inputs) - evalExpr(expr.right, inputs)
    case 'min':
      return Math.min(evalExpr(expr.left, inputs), evalExpr(expr.right, inputs))
    case 'max':
      return Math.max(evalExpr(expr.left, inputs), evalExpr(expr.right, inputs))
    case 'ite':
      return evalCond(expr.test, inputs)
        ? evalExpr(expr.then, inputs)
        : evalExpr(expr.else, inputs)
  }
}

function evalCond(cond: Cond, inputs: number[]): boolean {
  const l = evalExpr(cond.left, inputs)
  const r = evalExpr(cond.right, inputs)
  switch (cond.form) {
    case 'ge':
      return l >= r
    case 'gt':
      return l > r
    case 'eq':
      return l === r
  }
}

/** Render an expression as readable Seed-ish pseudocode. */
export function showExpr(expr: Expr, names: string[]): string {
  switch (expr.form) {
    case 'var':
      return names[expr.index]
    case 'const':
      return String(expr.value)
    case 'add':
      return `(${showExpr(expr.left, names)} + ${showExpr(expr.right, names)})`
    case 'sub':
      return `(${showExpr(expr.left, names)} - ${showExpr(expr.right, names)})`
    case 'min':
      return `min(${showExpr(expr.left, names)}, ${showExpr(expr.right, names)})`
    case 'max':
      return `max(${showExpr(expr.left, names)}, ${showExpr(expr.right, names)})`
    case 'ite':
      return `(${showCond(expr.test, names)} ? ${showExpr(expr.then, names)} : ${showExpr(expr.else, names)})`
  }
}

function showCond(cond: Cond, names: string[]): string {
  const op = cond.form === 'ge' ? '>=' : cond.form === 'gt' ? '>' : '=='
  return `${showExpr(cond.left, names)} ${op} ${showExpr(cond.right, names)}`
}

// --- the enumerator: all expressions up to a size, smallest first ---

const CONSTS = [0, 1]

/** Enumerate every expression of exactly `size` nodes. Memoized. */
function exprsOfSize(
  size: number,
  varCount: number,
  cache: Map<number, Expr[]>,
): Expr[] {
  const hit = cache.get(size)
  if (hit) return hit

  const out: Expr[] = []

  if (size === 1) {
    for (let i = 0; i < varCount; i++) out.push({ form: 'var', index: i })
    for (const value of CONSTS) out.push({ form: 'const', value })
    cache.set(size, out)
    return out
  }

  // binary ops: left of size a, right of size b, a + b + 1 = size
  for (let a = 1; a < size; a++) {
    const b = size - 1 - a
    if (b < 1) continue
    const lefts = exprsOfSize(a, varCount, cache)
    const rights = exprsOfSize(b, varCount, cache)
    for (const left of lefts) {
      for (const right of rights) {
        out.push({ form: 'add', left, right })
        out.push({ form: 'sub', left, right })
        out.push({ form: 'min', left, right })
        out.push({ form: 'max', left, right })
      }
    }
  }

  // if-then-else: test (cond over two size-1 exprs) + then + else
  // keep it cheap: test compares two atoms, branches are atoms
  if (size >= 4) {
    const atoms = exprsOfSize(1, varCount, cache)
    for (const tl of atoms) {
      for (const tr of atoms) {
        for (const thenE of atoms) {
          for (const elseE of atoms) {
            out.push({ form: 'ite', test: { form: 'ge', left: tl, right: tr }, then: thenE, else: elseE })
            out.push({ form: 'ite', test: { form: 'gt', left: tl, right: tr }, then: thenE, else: elseE })
          }
        }
      }
    }
  }

  cache.set(size, out)
  return out
}

/** All expressions up to `maxSize`, smallest first. */
export function enumerate(maxSize: number, varCount: number): Expr[] {
  const cache = new Map<number, Expr[]>()
  const out: Expr[] = []
  for (let size = 1; size <= maxSize; size++) {
    out.push(...exprsOfSize(size, varCount, cache))
  }
  return out
}

// --- the specification + the CEGIS loop ---

/** A spec: given the inputs and the candidate's output, is it correct? */
export type Spec = (inputs: number[], output: number) => boolean

export type SynthResult =
  | {
      ok: true
      expr: Expr
      counterexamples: number[][]
      candidatesTried: number
    }
  | { ok: false; reason: string; counterexamples: number[][] }

/**
 * Synthesize an expression over `varCount` integer inputs satisfying
 * `spec`. The loop:
 *   1. find the smallest candidate consistent with all counterexamples
 *   2. verify it with the property engine
 *   3. if the verifier finds a new counterexample, add it and repeat
 * Each counterexample removes a slice of wrong programs, so the loop
 * converges. Deterministic.
 */
export function synthesize(input: {
  varCount: number
  spec: Spec
  maxSize?: number
  inputGen?: Gen<number[]>
}): SynthResult {
  const { varCount, spec } = input
  const maxSize = input.maxSize ?? 6
  const inputGen =
    input.inputGen ??
    (genTuple(...Array.from({ length: varCount }, () => genInt)) as Gen<number[]>)

  const candidates = enumerate(maxSize, varCount)
  const counterexamples: number[][] = []
  let candidatesTried = 0

  // bound the outer loop by the number of candidates (it cannot need
  // more refinements than there are programs)
  for (let round = 0; round <= candidates.length; round++) {
    // the smallest candidate consistent with every counterexample so far
    const pick = candidates.find(expr => {
      candidatesTried++
      return counterexamples.every(ce => spec(ce, evalExpr(expr, ce)))
    })

    if (!pick) {
      return {
        ok: false,
        reason: 'no expression in the grammar satisfies the constraints',
        counterexamples,
      }
    }

    // verify the pick against random inputs; the verifier is the oracle
    const result = check(
      inputGen,
      ce => spec(ce, evalExpr(pick, ce)),
      { runs: 500, seed: 7 },
    )

    if (result.ok) {
      return { ok: true, expr: pick, counterexamples, candidatesTried }
    }

    // the verifier found a hole: add it and refine
    counterexamples.push(result.counterexample)
  }

  return {
    ok: false,
    reason: 'did not converge within the candidate budget',
    counterexamples,
  }
}
