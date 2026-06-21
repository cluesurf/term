/**
 * Structure-aware coverage-guided fuzzing: fuzz TYPED Seed values
 * (records, lists, nested) instead of raw integer tuples, mutating the
 * structure type-directed. This is the Hypothesis / Fuzzilli /
 * libFuzzer-structured lever - spend the budget on well-typed inputs so
 * the fuzzer reaches deep states past the shape, not on bytes the parser
 * rejects.
 *
 * The input is described by a `SeedType` (./type), so the fuzzer knows
 * how to mutate each sub-part: an int gets arithmetic / interesting
 * values, a list grows / shrinks / duplicates, a record's field is
 * recursed into. Coverage feedback (edge + value profile) drives the
 * corpus exactly as in the flat fuzzer (./fuzz).
 */

import { makeRng, type Rng } from './property'
import { genForType } from './type'
import type { SeedType } from './type'
import type { Sink } from './fuzz'

const INTERESTING = [0, 1, -1, 2, 7, 8, 16, 32, 42, 64, 100, 127, 128, 255, -128, 1000]

/** An instrumented target over a typed value. */
export type StructTarget = (value: unknown, sink: Sink) => void

export type StructFuzzResult = {
  crash?: unknown
  execs: number
  edgesFound: number
  corpusSize: number
}

/** Type-directed mutation: perturb one part of a value per its type. */
function mutate(value: unknown, type: SeedType, rng: Rng): unknown {
  switch (type.form) {
    case 'whole':
    case 'int': {
      const roll = rng.next()
      const n = value as number
      if (roll < 0.4) return INTERESTING[Math.floor(rng.next() * INTERESTING.length)]
      if (roll < 0.7) return n + Math.floor(rng.next() * 7) - 3
      return n ^ (1 << Math.floor(rng.next() * 16))
    }
    case 'wave':
      return !(value as boolean)
    case 'text': {
      const s = value as string
      if (s.length === 0 || rng.next() < 0.4) return s + 'x'
      return s.slice(0, -1)
    }
    case 'list': {
      const list = (value as unknown[]).slice()
      const op = Math.floor(rng.next() * 4)
      if (op === 0 || list.length === 0) {
        // grow: append a fresh element
        list.push(genForType(type.item).sample(rng, 8))
      } else if (op === 1) {
        // shrink: drop one
        list.splice(Math.floor(rng.next() * list.length), 1)
      } else if (op === 2) {
        // duplicate one
        const i = Math.floor(rng.next() * list.length)
        list.splice(i, 0, list[i])
      } else {
        // mutate one element
        const i = Math.floor(rng.next() * list.length)
        list[i] = mutate(list[i], type.item, rng)
      }
      return list
    }
    case 'record': {
      const rec = { ...(value as Record<string, unknown>) }
      const field = type.fields[Math.floor(rng.next() * type.fields.length)]
      rec[field.name] = mutate(rec[field.name], field.type, rng)
      return rec
    }
    case 'pick':
      // re-sample a whole arm
      return genForType(type).sample(rng, 8)
  }
}

/** Coverage-guided fuzz over a typed input. */
export function fuzzStruct(input: {
  target: StructTarget
  type: SeedType
  iterations?: number
  seed?: number
}): StructFuzzResult {
  const { target, type } = input
  const iterations = input.iterations ?? 50_000
  const rng = makeRng(input.seed ?? 1)
  const gen = genForType(type)

  const globalEdges = new Set<number>()
  const corpus: { value: unknown; novelty: number; chosen: number }[] = []
  let execs = 0

  function run(value: unknown): { crashed: boolean; newEdges: number } {
    execs++
    const hit = new Set<number>()
    let crashed = false
    let cmpSite = 0
    const sink: Sink = {
      edge: id => hit.add(id),
      cmp: (a, b) => {
        let x = (a ^ b) >>> 0
        let bits = 32
        if (x !== 0) { bits = 0; while ((x & 0x8000_0000) === 0) { bits++; x = (x << 1) >>> 0 } }
        hit.add(0x4000_0000 + cmpSite * 64 + bits)
        cmpSite++
      },
    }
    try { target(value, sink) } catch { crashed = true }
    let newEdges = 0
    for (const e of hit) if (!globalEdges.has(e)) { globalEdges.add(e); newEdges++ }
    return { crashed, newEdges }
  }

  // seed with a few generated values
  for (let i = 0; i < 4; i++) {
    const value = gen.sample(rng, 4)
    const r = run(value)
    if (r.crashed) return done(value)
    corpus.push({ value, novelty: r.newEdges + 1, chosen: 0 })
  }

  while (execs < iterations) {
    // power schedule: favor novel, rarely-chosen
    let parent = corpus[0]
    let bestKey = -1
    for (const entry of corpus) {
      const weight = entry.novelty / (entry.chosen + 1)
      const key = rng.next() ** (1 / Math.max(weight, 0.01))
      if (key > bestKey) { bestKey = key; parent = entry }
    }
    parent.chosen++

    const energy = 1 + Math.floor(parent.novelty / (parent.chosen + 1))
    for (let i = 0; i < energy && execs < iterations; i++) {
      const child = mutate(parent.value, type, rng)
      const r = run(child)
      if (r.crashed) return done(child)
      if (r.newEdges > 0) corpus.push({ value: child, novelty: r.newEdges, chosen: 0 })
    }
  }

  return { execs, edgesFound: globalEdges.size, corpusSize: corpus.length }

  function done(crash: unknown): StructFuzzResult {
    return { crash, execs, edgesFound: globalEdges.size, corpusSize: corpus.length }
  }
}
