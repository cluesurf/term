/**
 * The proof hammer: the core a proof IDE (LSP) or terminal calls to
 * close a goal automatically. Given a goal it tries the automated
 * route first (Z3 for a verify goal, CEGIS+Z3 for a synthesis goal),
 * and returns a proof state - proved (with the witness), refuted (with
 * a counterexample), or open. This is the "hammer" of
 * note/methodology/verification/theorem-proving-lsp.md, runnable.
 *
 * The same `hammer` powers both the LSP `proof/hammer` request and the
 * terminal workflow: state a goal, hammer it, read the result.
 */

import { makeSmt, proveExpr, type SymSpec } from './smt'
import { synthesizeSmt } from './synth-smt'
import { emitSeed } from './emit'
import { showExpr, type Expr, type Spec } from './synthesize'

/** A goal the hammer can attempt. */
export type ProofGoal =
  /** Prove a given body satisfies the spec for all inputs. */
  | {
      kind: 'verify'
      name: string
      arity: number
      names: string[]
      expr: Expr
      symSpec: SymSpec
    }
  /** Find a body (a witness) satisfying the spec - synthesis as proof. */
  | {
      kind: 'synthesize'
      name: string
      varCount: number
      names: string[]
      jsSpec: Spec
      symSpec: SymSpec
    }

/** The result of a hammer attempt - the proof state to display. */
export type ProofState =
  | { status: 'proved'; name: string; detail: string; seed?: string }
  | { status: 'refuted'; name: string; counterexample: number[] }
  | { status: 'open'; name: string; reason: string }

/** A shared Z3 context (open once per session). */
export type Session = { z3: unknown }

export async function openSession(): Promise<Session> {
  return { z3: await makeSmt() }
}

/** Attempt to close a goal automatically. */
export async function hammer(goal: ProofGoal, session: Session): Promise<ProofState> {
  if (goal.kind === 'verify') {
    const verdict = await proveExpr({
      arity: goal.arity,
      expr: goal.expr,
      spec: goal.symSpec,
      z3: session.z3,
    })
    if (verdict.proven) {
      return { status: 'proved', name: goal.name, detail: `${showExpr(goal.expr, goal.names)} satisfies the spec for ALL integers` }
    }
    if ('counterexample' in verdict) {
      return { status: 'refuted', name: goal.name, counterexample: verdict.counterexample }
    }
    return { status: 'open', name: goal.name, reason: 'solver returned unknown' }
  }

  // synthesize: find a witness, which IS the proof the spec is realizable
  const synth = await synthesizeSmt({
    varCount: goal.varCount,
    jsSpec: goal.jsSpec,
    symSpec: goal.symSpec,
    z3: session.z3,
  })
  if (synth.ok) {
    const seed = emitSeed({ name: goal.name, params: goal.names, body: synth.expr })
    return {
      status: 'proved',
      name: goal.name,
      detail: `witness ${showExpr(synth.expr, goal.names)} proven for ALL integers (${synth.counterexamples.length} refinements)`,
      seed,
    }
  }
  return { status: 'open', name: goal.name, reason: synth.reason }
}

/** Render a proof state the way a terminal session would print it. */
export function showState(state: ProofState): string {
  switch (state.status) {
    case 'proved':
      return `  ${state.name}: PROVED - ${state.detail}`
    case 'refuted':
      return `  ${state.name}: REFUTED - fails at ${JSON.stringify(state.counterexample)}`
    case 'open':
      return `  ${state.name}: OPEN - ${state.reason}`
  }
}
