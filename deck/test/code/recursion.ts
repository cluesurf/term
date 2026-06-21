/**
 * More recursion schemes: map and filter, distinct from the fold in
 * ir-synth.ts. Each is a different way to recurse over a list, and each
 * reduces synthesis to a small per-element sub-problem the existing
 * grammar already handles:
 *   - map:    synthesize the element transform `f(elem)`; map applies it.
 *   - filter: synthesize the keep-predicate `p(elem)`; filter applies it.
 *
 * So list -> list functions (increment-all, double-all) and selective
 * functions (keep-nonneg, drop-zeros) are synthesized from input/output
 * behavior alone. A step further into general recursion: synthesis now
 * covers fold, map, and filter schemes over lists.
 */

import { enumerate, evalExpr, showExpr, type Expr } from './synthesize'
import { enumeratePreds, evalPred, showPred, type Pred } from './predicate'
import { makeRng } from './property'

function randomList(seed: number, count: number): number[][] {
  const rng = makeRng(seed)
  const lists: number[][] = []
  for (let i = 0; i < count; i++) {
    const len = Math.floor(rng.next() * 6)
    lists.push(Array.from({ length: len }, () => Math.floor(rng.next() * 12) - 4))
  }
  return lists
}

const eq = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

// --- map: synthesize the element transform ---

export type MapResult =
  | { ok: true; transform: Expr; counterexamples: number[][] }
  | { ok: false; reason: string }

/** Synthesize `f` so that `list.map(f)` equals `spec(list)`. */
export function synthesizeMap(input: {
  spec: (list: number[]) => number[]
  maxSize?: number
  seed?: number
}): MapResult {
  const { spec } = input
  const candidates = enumerate(input.maxSize ?? 4, 1) // f(elem), elem = var 0
  const probes = randomList(input.seed ?? 1, 400)
  const counterexamples: number[][] = []

  for (let round = 0; round <= candidates.length; round++) {
    const pick = candidates.find(f =>
      counterexamples.every(list => eq(list.map(e => evalExpr(f, [e])), spec(list))),
    )
    if (!pick) return { ok: false, reason: 'no element transform fits' }

    const counter = probes.find(list => !eq(list.map(e => evalExpr(pick, [e])), spec(list)))
    if (!counter) return { ok: true, transform: pick, counterexamples }
    counterexamples.push(counter)
  }
  return { ok: false, reason: 'did not converge' }
}

// --- filter: synthesize the keep-predicate ---

export type FilterResult =
  | { ok: true; keep: Pred; counterexamples: number[][] }
  | { ok: false; reason: string }

/** Synthesize `p` so that `list.filter(p)` equals `spec(list)`. */
export function synthesizeFilter(input: {
  spec: (list: number[]) => number[]
  seed?: number
}): FilterResult {
  const { spec } = input
  const preds = enumeratePreds(1, 2, 2) // p(elem), elem = var 0
  const probes = randomList(input.seed ?? 2, 400)
  const counterexamples: number[][] = []

  for (let round = 0; round <= preds.length; round++) {
    const pick = preds.find(p =>
      counterexamples.every(list => eq(list.filter(e => evalPred(p, [e])), spec(list))),
    )
    if (!pick) return { ok: false, reason: 'no keep-predicate fits' }

    const counter = probes.find(list => !eq(list.filter(e => evalPred(pick, [e])), spec(list)))
    if (!counter) return { ok: true, keep: pick, counterexamples }
    counterexamples.push(counter)
  }
  return { ok: false, reason: 'did not converge' }
}

export { showExpr, showPred }
