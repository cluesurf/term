/**
 * Synthesis over sum types (tagged unions / ADTs): a function that
 * dispatches on a variant's tag and computes a per-variant result. This
 * is a step toward full algebraic-data-type synthesis - with the record
 * (product) synthesis in ir-synth.ts, synthesis now covers both halves
 * of an ADT: products (records/tuples) and sums (variants).
 *
 * The function is synthesized by synthesizing one handler expression
 * per variant, each over that variant's payload. Dispatch is the `fork
 * case` the result lowers to.
 */

import { enumerate, evalExpr, showExpr, type Expr } from './synthesize'

/** A tagged value: which variant, and its integer payload(s). */
export type Tagged = { tag: string; payload: number[] }

/** One variant of the input sum type: a tag and its payload arity. */
export type Variant = { tag: string; arity: number }

export type VariantResult =
  | { ok: true; handlers: Record<string, Expr> }
  | { ok: false; reason: string }

/**
 * Synthesize a function over a sum type. `spec(value, out)` says whether
 * `out` is correct for the tagged input. Each variant's handler is
 * synthesized independently over its own payload, against the spec
 * restricted to that tag.
 */
export function synthesizeVariant(input: {
  variants: Variant[]
  spec: (value: Tagged, out: number) => boolean
  maxSize?: number
  bound?: number
}): VariantResult {
  const { variants, spec } = input
  const maxSize = input.maxSize ?? 4
  const bound = input.bound ?? 6

  const handlers: Record<string, Expr> = {}

  for (const variant of variants) {
    const candidates = enumerate(maxSize, Math.max(1, variant.arity))
    const pick = candidates.find(handler =>
      provedOverBound(variant.arity, bound, payload =>
        spec({ tag: variant.tag, payload }, evalExpr(handler, payload)),
      ),
    )
    if (!pick) return { ok: false, reason: `variant ${variant.tag} had no handler in the grammar` }
    handlers[variant.tag] = pick
  }

  return { ok: true, handlers }
}

/** Evaluate the synthesized dispatch on a tagged value. */
export function runVariant(handlers: Record<string, Expr>, value: Tagged): number {
  const handler = handlers[value.tag]
  return evalExpr(handler, value.payload)
}

function provedOverBound(arity: number, bound: number, holds: (payload: number[]) => boolean): boolean {
  const width = Math.max(1, arity)
  const point = new Array<number>(width).fill(-bound)
  for (;;) {
    if (!holds(point.slice(0, arity))) return false
    let i = width - 1
    for (; i >= 0; i--) {
      if (point[i] < bound) { point[i]++; break }
      point[i] = -bound
    }
    if (i < 0) return true
  }
}

/** Render the dispatch as Seed-ish pseudocode. */
export function showVariant(handlers: Record<string, Expr>, payloadNames: string[]): string {
  return Object.entries(handlers)
    .map(([tag, h]) => `  case ${tag}: ${showExpr(h, payloadNames)}`)
    .join('\n')
}

export { showExpr }
