/**
 * The AI proposer, made real: an async proposer interface and an
 * async repair loop, so a language model can be plugged into the
 * synthesis loop directly. The model proposes; the proof disposes. A
 * wrong model proposal is rejected by the prover and the loop falls
 * back to CEGIS, so the model can never ship an unverified fix - the
 * Level-4 design from synthesis.md, with the only external dependency
 * being the model call itself.
 *
 * `modelProposer(ask)` is the production plug: `ask` is the function
 * that calls the LLM with the gap report and returns a candidate. In a
 * deployment `ask` hits a real model API; here a demo passes an async
 * stand-in. Everything around it - the prompt construction, the proof-
 * gated re-verification, the CEGIS fallback - is built and runnable.
 */

import { prove } from './prove'
import {
  cegisProposer,
  type GapReport,
  type Candidate,
  type RepairResult,
} from './gap'
import { enumerate, evalExpr, type Expr, type Spec } from './synthesize'

/** An async proposer: given a gap, return a candidate (or null). The
 * one interface a model, a remote service, or any slow source uses. */
export type AsyncProposer = {
  name: string
  propose: (gap: GapReport) => Promise<Candidate | null>
}

/** Build the prompt a model sees for a gap: the goal and the inputs
 * known to break a wrong answer. This is the gap report, serialized. */
export function gapPrompt(gap: GapReport): string {
  const lines = [
    `Synthesize a function body named "${gap.goal}" over ${gap.varCount} integer inputs.`,
    `It must satisfy the specification for all inputs.`,
  ]
  if (gap.counterexamples.length) {
    lines.push(`Known failing inputs of earlier wrong attempts: ${JSON.stringify(gap.counterexamples)}.`)
  }
  return lines.join('\n')
}

/**
 * A model-backed proposer. `ask` receives the gap prompt and returns a
 * candidate expression, or null if it has nothing. In production `ask`
 * calls the LLM and parses its reply into an `Expr`; the same loop then
 * proves the candidate, so a hallucinated answer is simply rejected.
 */
export function modelProposer(
  ask: (prompt: string) => Promise<Expr | null>,
): AsyncProposer {
  return {
    name: 'model',
    propose: gap => ask(gapPrompt(gap)),
  }
}

/** Wrap the synchronous CEGIS proposer as an async one (the net). */
export function asyncCegis(maxSize = 6): AsyncProposer {
  const sync = cegisProposer(maxSize)
  return { name: 'cegis', propose: async gap => sync.propose(gap) }
}

/**
 * The async repair loop. Like `repair`, but awaits each proposer, so a
 * model call fits naturally. Each candidate is proven over the bound
 * before acceptance; a candidate already refuted by a known
 * counterexample is skipped so a stubborn wrong proposal falls back.
 */
export async function repairAsync(
  gap: GapReport,
  proposers: AsyncProposer[],
  options: { maxRounds?: number } = {},
): Promise<RepairResult & { proposer?: string }> {
  const maxRounds = options.maxRounds ?? 64
  const counterexamples = gap.counterexamples.slice()
  const jsSpec: Spec = gap.spec

  for (let round = 0; round < maxRounds; round++) {
    const working: GapReport = { ...gap, counterexamples }

    let candidate: Candidate | null = null
    let who = ''
    for (const proposer of proposers) {
      const proposed = await proposer.propose(working)
      if (!proposed) continue
      const consistent = counterexamples.every(ce => jsSpec(ce, evalExpr(proposed, ce)))
      if (!consistent) continue
      candidate = proposed
      who = proposer.name
      break
    }

    if (!candidate) {
      return { ok: false, reason: 'no proposer produced a usable candidate', counterexamples }
    }

    const verdict = prove({
      arity: gap.varCount,
      claim: inputs => gap.spec(inputs, evalExpr(candidate as Expr, inputs)),
      bound: gap.bound,
    })

    if (verdict.ok) {
      return { ok: true, expr: candidate, proposer: who, rounds: round + 1, counterexamples }
    }

    counterexamples.push(verdict.counterexample)
  }

  return { ok: false, reason: 'did not converge within the round budget', counterexamples }
}

// re-export so callers can build grammars for a stand-in `ask`
export { enumerate, evalExpr }
