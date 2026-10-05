/**
 * A coverage-guided fuzzer, modeled on the best in the field (AFL++,
 * libFuzzer, honggfuzz): edge coverage, a value profile, havoc mutators, a
 * power schedule, and crash minimization. Inputs are integer tuples, and the
 * target is "instrumented" by calling `sink.edge(id)` as it branches.
 *
 * Term since 2026-10-05 (deck/test/code/coverage-fuzz.tree, paired against
 * this file's original over 30 random targets by tmp/pair-fuzz.ts). This is
 * its face: a TypeScript target still reports through a closure sink and
 * crashes by throwing, and the face turns both into what the port takes.
 */

import { fuzz as search, coverEdge, coverCompare } from '@term/test/code/coverage-fuzz'

/**
 * The coverage sink an instrumented target reports to:
 *   - `edge(id)`: a branch was taken (AFL edge coverage).
 *   - `cmp(a, b)`: a comparison was evaluated (libFuzzer value profile).
 */
export type Sink = {
  edge: (id: number) => void
  cmp: (a: number, b: number) => void
}

/** A coverage sink the target calls; `edge` only, for simple targets. */
export type Cover = (edge: number) => void

/**
 * An instrumented target: run on an input, reporting coverage via the
 * sink. Throwing (or the caller's oracle failing) is a crash.
 */
export type Target = (input: number[], sink: Sink) => void

export type FuzzResult = {
  crash?: number[]
  execs: number
  edgesFound: number
  corpusSize: number
}

/**
 * Fuzz `target` starting from `seeds`, for up to `iterations` execs or
 * until a crash. Returns the crashing input (minimized) if found.
 */
export function fuzz(input: {
  target: Target
  arity: number
  seeds?: number[][]
  iterations?: number
  seed?: number
}): FuzzResult {
  const failed = (candidate: number[], sink: never): boolean => {
    try {
      input.target(candidate, { edge: id => coverEdge(sink, id), cmp: (a, b) => coverCompare(sink, a, b) })

      return false
    } catch {
      return true
    }
  }
  const found = search(failed as never, input.arity, input.seeds ?? [], input.iterations ?? 50_000, input.seed ?? 1) as {
    crashed: boolean
    crash: number[]
    execs: number
    edgesFound: number
    corpusSize: number
  }

  return {
    ...(found.crashed ? { crash: found.crash } : {}),
    execs: found.execs,
    edgesFound: found.edgesFound,
    corpusSize: found.corpusSize,
  }
}
