/**
 * The server-side proof protocol: the `proof/*` request handlers an
 * LSP server (deck/flow) registers to drive a proof IDE. This is the
 * server half of the InfoView from theorem-proving-lsp.md - it runs in
 * node and is fully testable. Only the webview CLIENT that renders the
 * returned state needs an editor runtime; the substantial logic lives
 * here.
 *
 * - `proofState` answers `proof/state`: the goals in a document and
 *   their status, the data the InfoView renders.
 * - `proofHammer` answers `proof/hammer`: attempt to close one goal,
 *   returning its new state (proved with a witness, refuted with a
 *   counterexample, or open).
 *
 * Goals are proof obligations (contracts on functions). In the full
 * system they are parsed from `.tree` contract annotations; here a
 * `ProofDocument` carries them directly.
 */

import { hammer, type ProofGoal, type ProofState, type Session } from './hammer'

/** A document's proof obligations (from its contract annotations). */
export type ProofDocument = {
  uri: string
  goals: ProofGoal[]
}

/** One goal as the InfoView shows it. */
export type GoalView = {
  name: string
  status: 'open' | 'proved' | 'refuted'
  detail?: string
  counterexample?: number[]
}

/** The `proof/state` response: the InfoView's data for a document. */
export type ProofStateView = {
  uri: string
  goals: GoalView[]
  solved: number
  total: number
  done: boolean
}

/** Project a proof result into a goal view. */
function toView(name: string, result: ProofState | undefined): GoalView {
  if (!result) return { name, status: 'open' }
  switch (result.status) {
    case 'proved':
      return { name, status: 'proved', detail: result.detail }
    case 'refuted':
      return { name, status: 'refuted', counterexample: result.counterexample }
    case 'open':
      return { name, status: 'open', detail: result.reason }
  }
}

/**
 * `proof/state`: the goals in a document and their current status,
 * given the results computed so far. The InfoView calls this on cursor
 * move and after each hammer.
 */
export function proofState(
  doc: ProofDocument,
  results: Map<string, ProofState>,
): ProofStateView {
  const goals = doc.goals.map(g => toView(g.name, results.get(g.name)))
  const solved = goals.filter(g => g.status === 'proved').length

  return {
    uri: doc.uri,
    goals,
    solved,
    total: goals.length,
    done: solved === goals.length,
  }
}

/**
 * `proof/hammer`: attempt to close one goal automatically. Returns the
 * goal's new proof state, which the caller folds into the results map
 * and re-renders via `proofState`.
 */
export async function proofHammer(
  doc: ProofDocument,
  goalName: string,
  session: Session,
): Promise<ProofState> {
  const goal = doc.goals.find(g => g.name === goalName)
  if (!goal) {
    return { status: 'open', name: goalName, reason: 'no such goal in document' }
  }
  return hammer(goal, session)
}

/** Render the InfoView panel as text (what the webview would draw). */
export function renderInfoView(view: ProofStateView): string {
  const lines = [`# ${view.uri}  (${view.solved}/${view.total}${view.done ? ', done' : ''})`]
  for (const goal of view.goals) {
    const mark = goal.status === 'proved' ? 'OK ' : goal.status === 'refuted' ? 'BAD' : '...'
    let line = `  [${mark}] ${goal.name}`
    if (goal.status === 'refuted' && goal.counterexample) {
      line += `  fails at ${JSON.stringify(goal.counterexample)}`
    } else if (goal.detail) {
      line += `  ${goal.detail}`
    }
    lines.push(line)
  }
  return lines.join('\n')
}
