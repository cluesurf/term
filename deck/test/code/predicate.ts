/**
 * Synthesis beyond integer arithmetic: boolean-valued PREDICATES. A
 * step in lifting CEGIS off the integer-expression grammar toward the
 * full Seed IR. The grammar is comparisons over the integer expressions
 * (./synthesize) combined with boolean connectives, so the synthesizer
 * can now produce functions like `in-range`, `is-positive`, `ordered`.
 *
 * Same CEGIS loop, new output type. The synthesized predicate lowers to
 * a Seed boolean expression (`fork test` / `and` / `or` / `not`).
 */

import { enumerate, evalExpr, showExpr, type Expr } from './synthesize'

/** A boolean predicate over the integer inputs. */
export type Pred =
  | { form: 'ge'; left: Expr; right: Expr }
  | { form: 'le'; left: Expr; right: Expr }
  | { form: 'eq'; left: Expr; right: Expr }
  | { form: 'and'; left: Pred; right: Pred }
  | { form: 'or'; left: Pred; right: Pred }
  | { form: 'not'; inner: Pred }

export function evalPred(pred: Pred, inputs: number[]): boolean {
  switch (pred.form) {
    case 'ge':
      return evalExpr(pred.left, inputs) >= evalExpr(pred.right, inputs)
    case 'le':
      return evalExpr(pred.left, inputs) <= evalExpr(pred.right, inputs)
    case 'eq':
      return evalExpr(pred.left, inputs) === evalExpr(pred.right, inputs)
    case 'and':
      return evalPred(pred.left, inputs) && evalPred(pred.right, inputs)
    case 'or':
      return evalPred(pred.left, inputs) || evalPred(pred.right, inputs)
    case 'not':
      return !evalPred(pred.inner, inputs)
  }
}

export function showPred(pred: Pred, names: string[]): string {
  switch (pred.form) {
    case 'ge':
      return `${showExpr(pred.left, names)} >= ${showExpr(pred.right, names)}`
    case 'le':
      return `${showExpr(pred.left, names)} <= ${showExpr(pred.right, names)}`
    case 'eq':
      return `${showExpr(pred.left, names)} == ${showExpr(pred.right, names)}`
    case 'and':
      return `(${showPred(pred.left, names)} and ${showPred(pred.right, names)})`
    case 'or':
      return `(${showPred(pred.left, names)} or ${showPred(pred.right, names)})`
    case 'not':
      return `not ${showPred(pred.inner, names)}`
  }
}

/** Enumerate predicates up to a size: atoms (comparisons of small exprs)
 * combined by and/or/not. Smallest first. */
export function enumeratePreds(varCount: number, exprSize = 2, predSize = 3): Pred[] {
  const exprs = enumerate(exprSize, varCount)
  const atoms: Pred[] = []
  for (const left of exprs) {
    for (const right of exprs) {
      atoms.push({ form: 'ge', left, right })
      atoms.push({ form: 'le', left, right })
      atoms.push({ form: 'eq', left, right })
    }
  }

  const bySize = new Map<number, Pred[]>()
  bySize.set(1, atoms)

  for (let size = 2; size <= predSize; size++) {
    const here: Pred[] = []
    // not of a smaller predicate
    for (const inner of bySize.get(size - 1) ?? []) here.push({ form: 'not', inner })
    // and / or of two smaller predicates summing to size-1
    for (let a = 1; a < size; a++) {
      const b = size - 1 - a
      if (b < 1) continue
      for (const left of bySize.get(a) ?? []) {
        for (const right of bySize.get(b) ?? []) {
          here.push({ form: 'and', left, right })
          here.push({ form: 'or', left, right })
        }
      }
    }
    bySize.set(size, here)
  }

  const out: Pred[] = []
  for (let size = 1; size <= predSize; size++) out.push(...(bySize.get(size) ?? []))
  return out
}

/** A boolean spec: does this predicate's value match the intended one? */
export type PredSpec = (inputs: number[], out: boolean) => boolean

export type PredSynthResult =
  | { ok: true; pred: Pred; counterexamples: number[][] }
  | { ok: false; reason: string }

/** CEGIS for predicates: smallest predicate consistent with the
 * counterexamples, verified exhaustively over the bound, refined on
 * failure. */
export function synthesizePred(input: {
  varCount: number
  spec: PredSpec
  bound?: number
  exprSize?: number
  predSize?: number
}): PredSynthResult {
  const { varCount, spec } = input
  const bound = input.bound ?? 6
  const candidates = enumeratePreds(varCount, input.exprSize, input.predSize)
  const counterexamples: number[][] = []

  for (let round = 0; round <= candidates.length; round++) {
    const pick = candidates.find(p => counterexamples.every(ce => spec(ce, evalPred(p, ce))))
    if (!pick) return { ok: false, reason: 'no predicate in the grammar fits' }

    // exhaustive check over the bounded domain
    const counter = findCounterexample(varCount, bound, ce => spec(ce, evalPred(pick, ce)))
    if (!counter) return { ok: true, pred: pick, counterexamples }
    counterexamples.push(counter)
  }
  return { ok: false, reason: 'did not converge' }
}

/** Enumerate the bounded domain for the first failing input. */
function findCounterexample(
  arity: number,
  bound: number,
  holds: (inputs: number[]) => boolean,
): number[] | null {
  const point = new Array<number>(arity).fill(-bound)
  for (;;) {
    if (!holds(point)) return point.slice()
    let i = arity - 1
    for (; i >= 0; i--) {
      if (point[i] < bound) { point[i]++; break }
      point[i] = -bound
    }
    if (i < 0) return null
  }
}
