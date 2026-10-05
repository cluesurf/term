/**
 * The AI proposer, made real: an async proposer interface and an async
 * repair loop, so a language model can be plugged into the synthesis loop
 * directly. The model proposes; the proof disposes.
 *
 * The prompt and the async loop are Term since 2026-10-05
 * (deck/test/code/model-proposer.tree, which holds demo-ai.ts's answers). This
 * is its face: `modelProposer(ask)` and `asyncCegis` stay factories a
 * TypeScript caller hands closures to, and each proposer is adapted to the
 * port's, whose answer is a `maybe`.
 */

import { gapPrompt as prompt, repairAsync as repairPort } from '@term/test/code/model-proposer'
import { cegisProposer, toTermGap, fromTermGap, type GapReport, type Candidate, type RepairResult } from './gap'
import { enumerate, evalExpr, type Expr } from './synthesize'

/** An async proposer: given a gap, return a candidate (or null). */
export type AsyncProposer = {
  name: string
  propose: (gap: GapReport) => Promise<Candidate | null>
}

/** Build the prompt a model sees for a gap: the goal and the inputs known to break a wrong answer. */
export function gapPrompt(gap: GapReport): string {
  return prompt(toTermGap(gap))
}

/** A model-backed proposer. `ask` receives the gap prompt and returns a candidate, or null. */
export function modelProposer(ask: (prompt: string) => Promise<Expr | null>): AsyncProposer {
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

/** The async repair loop: like `repair`, but awaits each proposer. */
export async function repairAsync(
  gap: GapReport,
  proposers: AsyncProposer[],
  options: { maxRounds?: number } = {},
): Promise<RepairResult & { proposer?: string }> {
  const adapted = proposers.map(proposer => ({
    name: proposer.name,
    propose: async (termGap: never) => {
      const found = await proposer.propose(fromTermGap(termGap))

      return found ? { form: 'some', value: found } : { form: 'none' }
    },
  }))

  return (await repairPort(toTermGap(gap), adapted as never, options.maxRounds ?? 64, 0)) as RepairResult & { proposer?: string }
}

// re-export so callers can build grammars for a stand-in `ask`
export { enumerate, evalExpr }
