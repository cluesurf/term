/**
 * The unified automated pipeline: from a contract (a spec, possibly
 * for a hole in a program) to verified, compiling Seed source, in one
 * call. This ties the whole system together - proposers (the AI plug
 * point first, CEGIS as the net), the bounded prover, the Seed emitter,
 * and the live compiler - into the single loop the synthesis design
 * describes (note/methodology/verification/synthesis.md).
 *
 * `autocomplete` is the function a checker would call on an unfilled
 * task: hand it the spec, get back proven, compilable Seed code, with
 * the record of which proposer answered. A wrong proposal (even from
 * the AI) is rejected by the proof and the loop falls back, so the
 * output is always verified.
 */

import { compile } from '@cluesurf/make/code/compile/compile'
import { emitSeed } from './emit'
import { synthesizeContract, verifyContract, type Contract } from './contract'
import { type Proposer } from './gap'
import { type Expr } from './synthesize'

/** A module resolver, as compile() expects. */
export type Resolve = (importPath: string, fromFile: string) => unknown

export type Completion =
  | {
      ok: true
      taskName: string
      expr: Expr
      source: string
      proposer: string
      verified: boolean
      compiles: boolean
    }
  | { ok: false; taskName: string; reason: string }

/**
 * Complete a task body from its contract: synthesize (trying any
 * given proposers, then CEGIS), prove the result over the bound, emit
 * it as Seed, and compile that Seed against the live compiler. The
 * whole loop, certified end to end.
 */
export function autocomplete(input: {
  taskName: string
  contract: Contract
  resolve: Resolve
  proposers?: Proposer[]
  bound?: number
  maxSize?: number
}): Completion {
  const { taskName, contract, resolve } = input

  // 1-2. synthesize + prove (the repair loop, proposers then CEGIS)
  const synth = synthesizeContract(contract, {
    bound: input.bound,
    maxSize: input.maxSize,
    proposers: input.proposers,
  })
  if (!synth.ok) {
    return { ok: false, taskName, reason: synth.reason }
  }

  // 3. independent proof of the chosen body over the bound
  const verified = verifyContract(synth.expr, contract, input.bound).ok

  // 4. emit as real Seed source
  const source = emitSeed({
    name: taskName,
    params: contract.params.map(p => p.name),
    body: synth.expr,
  })

  // 5. compile the emitted Seed against the live compiler
  const compiled = compile({ file: `${taskName}.tree`, text: source }, { resolve })

  return {
    ok: true,
    taskName,
    expr: synth.expr,
    source,
    proposer: synth.proposer,
    verified,
    compiles: compiled.ok,
  }
}

/** Whether a completion is fully sound: synthesized, proven, and compiles. */
export function isSound(completion: Completion): boolean {
  return completion.ok && completion.verified && completion.compiles
}
