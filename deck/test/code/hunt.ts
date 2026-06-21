/**
 * `hunt` - a generic automated bug-hunting engine, target-agnostic so it
 * can be pointed at any codebase, app, or library, not just the Seed
 * compiler. The idea is uniform: define PROBES (properties a correct
 * system must satisfy on every input) and MUTATORS (how to perturb a
 * seed input), then run the probes over a real corpus AND over a stream
 * of mutated inputs. A probe that fires is a finding.
 *
 * A probe encodes ANY oracle: a crash check ("does it throw?"), a
 * metamorphic property ("parse∘print is a fixpoint"), a differential
 * property ("two backends agree"), a perf budget, an invariant. The
 * engine does not know what the target is; it just runs probes and
 * collects findings. The Seed-compiler instantiation lives in
 * `seed-hunt.ts`; future targets supply their own probes + mutators.
 *
 * Hang detection (a probe that never returns) cannot be done in-process;
 * a target that needs it runs its fuzz phase under an out-of-process
 * watchdog (see `seed-hunt.ts` / `fuzz-campaign.ts`). The engine here is
 * the in-process core: corpus sweep + mutation fuzz with crash capture.
 */

import { makeRng, type Rng } from './property'

/** A finding: which probe fired, why, and on what input (stringified). */
export type Finding = {
  probe: string
  detail: string
  input: string
}

/** A probe is an oracle over inputs of type I: return findings, or none. */
export type Probe<I> = {
  name: string
  // return null / [] for "no violation", or one/many findings
  check: (input: I) => Finding | Finding[] | null
}

/** A mutator perturbs a seed input to explore nearby inputs. */
export type Mutator<I> = (input: I, corpus: I[], rng: Rng) => I

function runProbe<I>(probe: Probe<I>, input: I): Finding[] {
  try {
    const r = probe.check(input)
    if (!r) return []
    return Array.isArray(r) ? r : [r]
  } catch (error) {
    // a probe that throws is itself a finding (often the target crashing)
    return [{
      probe: probe.name,
      detail: `probe threw: ${error instanceof Error ? error.message : String(error)}`,
      input: String(input),
    }]
  }
}

/** Run every probe over every corpus input. */
export function huntCorpus<I>(input: {
  inputs: I[]
  probes: Probe<I>[]
}): Finding[] {
  const findings: Finding[] = []
  for (const item of input.inputs) {
    for (const probe of input.probes) findings.push(...runProbe(probe, item))
  }
  return findings
}

/** Mutation fuzzing: perturb the corpus and probe each mutant. */
export function huntFuzz<I>(input: {
  corpus: I[]
  probes: Probe<I>[]
  mutators: Mutator<I>[]
  runs?: number
  seed?: number
  mutationsPerRun?: number
}): Finding[] {
  const runs = input.runs ?? 2000
  const rng = makeRng(input.seed ?? 1)
  const corpus = [...input.corpus]
  const findings: Finding[] = []

  for (let i = 0; i < runs; i++) {
    let item = corpus[Math.floor(rng.next() * corpus.length)]!
    const k = 1 + Math.floor(rng.next() * (input.mutationsPerRun ?? 4))
    for (let m = 0; m < k; m++) {
      const mutator = input.mutators[Math.floor(rng.next() * input.mutators.length)]!
      item = mutator(item, corpus, rng)
    }
    for (const probe of input.probes) findings.push(...runProbe(probe, item))
  }
  return findings
}

/** De-duplicate findings by (probe, detail head) - many inputs hit one bug. */
export function dedupeFindings(findings: Finding[]): { signature: string; example: Finding; count: number }[] {
  const byKey = new Map<string, { example: Finding; count: number }>()
  for (const f of findings) {
    const key = `${f.probe}:${f.detail.slice(0, 80)}`
    const hit = byKey.get(key)
    if (hit) hit.count++
    else byKey.set(key, { example: f, count: 1 })
  }
  return [...byKey.entries()].map(([signature, v]) => ({ signature, ...v }))
}

export type { Rng }
