/**
 * A coverage-guided fuzzer, modeled on the best in the field (AFL++,
 * libFuzzer, honggfuzz). The core insight those tools proved: feedback
 * beats randomness. A fuzzer that keeps the inputs which reach NEW code
 * evolves a corpus toward deep states a blind random fuzzer never finds.
 *
 * The pieces, each from a real fuzzer:
 *   - edge coverage (AFL): the target reports which branches it took;
 *     an input that hits a new edge is "interesting" and kept.
 *   - the corpus: the evolving set of interesting inputs.
 *   - havoc mutators (AFL): bit flips, arithmetic, interesting values,
 *     and splicing two corpus entries.
 *   - a power schedule (AFLFast): spend more energy on small, novel,
 *     rare-edge inputs.
 *   - crash detection: an input that throws or fails the oracle is a
 *     finding, saved and minimized.
 *
 * Inputs here are integer tuples (the verify engine's domain), and the
 * target is "instrumented" by calling `cover(edge)` as it branches -
 * the manual stand-in for compile-time instrumentation. Deterministic
 * via a seeded PRNG.
 */

import { makeRng, type Rng } from './property'

/** The coverage sink the target calls at each branch it takes. */
export type Cover = (edge: number) => void

/**
 * An instrumented target: run on an input, calling `cover` at each
 * branch. Throwing (or the caller's oracle failing) is a crash.
 */
export type Target = (input: number[], cover: Cover) => void

/** Boundary / magic values mutators love (AFL's "interesting" set). */
const INTERESTING = [0, 1, -1, 2, 7, 8, 13, 16, 32, 42, 64, 100, 127, 128, 255, 256, -128, 1000, -1000]

export type FuzzResult = {
  crash?: number[]
  execs: number
  edgesFound: number
  corpusSize: number
}

type Entry = {
  input: number[]
  /** edges this entry first discovered (rarer = more favored). */
  novelty: number
  chosen: number
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
  const { target, arity } = input
  const iterations = input.iterations ?? 50_000
  const rng = makeRng(input.seed ?? 1)

  const globalEdges = new Set<number>()
  const corpus: Entry[] = []
  let execs = 0

  // run once, recording coverage; returns {crashed, newEdges}
  function run(candidate: number[]): { crashed: boolean; newEdges: number } {
    execs++
    const hit = new Set<number>()
    let crashed = false
    try {
      target(candidate, edge => hit.add(edge))
    } catch {
      crashed = true
    }
    let newEdges = 0
    for (const e of hit) {
      if (!globalEdges.has(e)) {
        globalEdges.add(e)
        newEdges++
      }
    }
    return { crashed, newEdges }
  }

  // seed the corpus
  const startSeeds = input.seeds ?? [new Array<number>(arity).fill(0)]
  for (const seed of startSeeds) {
    const r = run(seed)
    if (r.crashed) return finding(seed)
    corpus.push({ input: seed, novelty: r.newEdges + 1, chosen: 0 })
  }

  while (execs < iterations) {
    const parent = pick(corpus, rng)
    parent.chosen++

    // energy: more mutations for small, novel, rarely-chosen inputs
    const energy = 1 + Math.floor(parent.novelty / (parent.chosen + 1))

    for (let i = 0; i < energy && execs < iterations; i++) {
      const child = mutate(parent.input, corpus, rng)
      const r = run(child)

      if (r.crashed) return finding(child)

      if (r.newEdges > 0) {
        corpus.push({ input: child, novelty: r.newEdges, chosen: 0 })
      }
    }
  }

  return { execs, edgesFound: globalEdges.size, corpusSize: corpus.length }

  function finding(crash: number[]): FuzzResult {
    return {
      crash: minimize(crash, target),
      execs,
      edgesFound: globalEdges.size,
      corpusSize: corpus.length,
    }
  }
}

/** Power-schedule pick: favor high novelty, low chosen-count (AFLFast). */
function pick(corpus: Entry[], rng: Rng): Entry {
  // weighted reservoir by novelty/(chosen+1)
  let best = corpus[0]
  let bestKey = -1
  for (const entry of corpus) {
    const weight = entry.novelty / (entry.chosen + 1)
    const key = rng.next() ** (1 / Math.max(weight, 0.01))
    if (key > bestKey) {
      bestKey = key
      best = entry
    }
  }
  return best
}

/** AFL-style havoc: apply a few random mutations, sometimes splice. */
function mutate(parent: number[], corpus: Entry[], rng: Rng): number[] {
  const child = parent.slice()
  const rounds = 1 + Math.floor(rng.next() * 4)

  for (let i = 0; i < rounds; i++) {
    const pos = Math.floor(rng.next() * child.length)
    const op = Math.floor(rng.next() * 5)
    switch (op) {
      case 0: // bit flip
        child[pos] ^= 1 << Math.floor(rng.next() * 16)
        break
      case 1: // small arithmetic
        child[pos] += Math.floor(rng.next() * 7) - 3
        break
      case 2: // interesting value
        child[pos] = INTERESTING[Math.floor(rng.next() * INTERESTING.length)]
        break
      case 3: // negate
        child[pos] = -child[pos]
        break
      case 4: // splice: copy a field from another corpus entry
        if (corpus.length > 1) {
          const other = corpus[Math.floor(rng.next() * corpus.length)].input
          child[pos] = other[pos % other.length]
        }
        break
    }
  }
  return child
}

/** Shrink a crashing input toward each component being 0, keeping the crash. */
function minimize(crash: number[], target: Target): number[] {
  const crashes = (candidate: number[]): boolean => {
    try {
      target(candidate, () => {})
      return false
    } catch {
      return true
    }
  }

  let current = crash.slice()
  for (let i = 0; i < current.length; i++) {
    for (const value of [0, 1, -1]) {
      const trial = current.slice()
      trial[i] = value
      if (crashes(trial)) {
        current = trial
        break
      }
    }
  }
  return current
}
