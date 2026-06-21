/**
 * The property-testing engine: type-derived generators, shrinking,
 * and a runner that returns a counterexample. This is Layer 3 of the
 * Seed verification system (note/methodology/verification/
 * seed-verification-system.md) AND the verifier half of the synthesis
 * loop: it is what finds the hole and hands back the exact input that
 * breaks a claim.
 *
 * Deterministic by construction: a seeded PRNG drives generation, so
 * a failing run reproduces exactly. No Math.random.
 */

/** A generator samples a value from a seeded PRNG and shrinks it. */
export type Gen<T> = {
  /** Produce a value at the given size (larger size = bigger value). */
  sample: (rng: Rng, size: number) => T
  /** Smaller variants of a value, tried in order, to minimize a failure. */
  shrink: (value: T) => T[]
}

/** A tiny deterministic PRNG (mulberry32). Seeded, reproducible. */
export type Rng = { next: () => number }

export function makeRng(seed: number): Rng {
  let state = seed >>> 0

  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/** Integer in [lo, hi]. */
function intBetween(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng.next() * (hi - lo + 1))
}

/** Generator for whole numbers, biased toward small + boundary values. */
export const genWhole: Gen<number> = {
  sample(rng, size) {
    // bias toward boundaries (0, 1) where bugs cluster
    const roll = rng.next()
    if (roll < 0.2) return 0
    if (roll < 0.35) return 1
    return intBetween(rng, 0, Math.max(1, size))
  },
  shrink(value) {
    if (value === 0) return []
    const out = [0]
    if (value > 1) out.push(Math.floor(value / 2), value - 1)
    return out
  },
}

/** Generator for integers (can be negative), boundary-biased. */
export const genInt: Gen<number> = {
  sample(rng, size) {
    const roll = rng.next()
    if (roll < 0.15) return 0
    if (roll < 0.25) return -1
    if (roll < 0.35) return 1
    return intBetween(rng, -size, size)
  },
  shrink(value) {
    if (value === 0) return []
    const out = [0]
    if (Math.abs(value) > 1) out.push(value > 0 ? value - 1 : value + 1)
    if (value < 0) out.push(-value)
    return out
  },
}

/** Tuple generator: the canonical derivation for a record of fields. */
export function genTuple<T extends unknown[]>(
  ...gens: { [K in keyof T]: Gen<T[K]> }
): Gen<T> {
  return {
    sample(rng, size) {
      return gens.map(g => g.sample(rng, size)) as T
    },
    shrink(value) {
      // shrink one component at a time, holding the others
      const out: T[] = []
      for (let i = 0; i < value.length; i++) {
        const gen = gens[i]
        if (!gen) continue
        for (const smaller of gen.shrink(value[i])) {
          const copy = value.slice() as T
          copy[i] = smaller
          out.push(copy)
        }
      }
      return out
    },
  }
}

/** Generator for a list of T, length scaling with size. */
export function genList<T>(item: Gen<T>): Gen<T[]> {
  return {
    sample(rng, size) {
      const length = intBetween(rng, 0, size)
      const out: T[] = []
      for (let i = 0; i < length; i++) out.push(item.sample(rng, size))
      return out
    },
    shrink(value) {
      if (value.length === 0) return []
      const out: T[][] = [[]]
      // drop one element
      for (let i = 0; i < value.length; i++) {
        out.push(value.slice(0, i).concat(value.slice(i + 1)))
      }
      // halve
      if (value.length > 2) out.push(value.slice(0, Math.floor(value.length / 2)))
      return out
    },
  }
}

/** The outcome of running a property. */
export type CheckResult<T> =
  | { ok: true; runs: number }
  | { ok: false; counterexample: T; shrinks: number; runs: number }

/**
 * Run `claim` over generated inputs. On the first failure, shrink the
 * counterexample to the smallest input that still fails, and return
 * it. This minimized input is the gap report's `counterexample`.
 */
export function check<T>(
  gen: Gen<T>,
  claim: (value: T) => boolean,
  options: { runs?: number; seed?: number; maxSize?: number } = {},
): CheckResult<T> {
  const runs = options.runs ?? 200
  const maxSize = options.maxSize ?? 64
  const rng = makeRng(options.seed ?? 1)

  for (let i = 0; i < runs; i++) {
    const size = 1 + Math.floor((i / runs) * maxSize)
    const value = gen.sample(rng, size)

    if (!safeClaim(claim, value)) {
      const { minimal, shrinks } = minimize(gen, claim, value)
      return { ok: false, counterexample: minimal, shrinks, runs: i + 1 }
    }
  }

  return { ok: true, runs }
}

/** A claim that throws counts as a failure, not a crash. */
function safeClaim<T>(claim: (value: T) => boolean, value: T): boolean {
  try {
    return claim(value)
  } catch {
    return false
  }
}

/** Greedily shrink a failing value to a local minimum. */
function minimize<T>(
  gen: Gen<T>,
  claim: (value: T) => boolean,
  start: T,
): { minimal: T; shrinks: number } {
  let current = start
  let shrinks = 0

  for (;;) {
    let progressed = false

    for (const candidate of gen.shrink(current)) {
      if (!safeClaim(claim, candidate)) {
        current = candidate
        shrinks++
        progressed = true
        break
      }
    }

    if (!progressed) return { minimal: current, shrinks }
  }
}
