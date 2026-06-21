/**
 * Contracts and refinement checking: Layers 1-2 of the system
 * (note/methodology/verification/seed-verification-system.md). A
 * `Contract` is a function's specification - parameter refinements
 * (preconditions on inputs) plus a postcondition on the result. The
 * VCG turns it into proof obligations, and the bounded prover (./prove)
 * discharges them.
 *
 * This is also where the whole system closes: a contract with a HOLE
 * for its body is a synthesis problem. `verifyContract` checks a body;
 * `synthesizeContract` writes one that the prover then certifies. The
 * precondition is the key new power over plain CEGIS: the body only has
 * to be correct on inputs the precondition admits, exactly like a
 * refinement-typed parameter.
 */

import { prove, type ProveResult } from './prove'
import { repair, cegisProposer, type GapReport, type RepairResult, type Proposer } from './gap'
import { evalExpr, type Expr, type Spec } from './synthesize'

/** A predicate refining a single value (a refinement type's body). */
export type Refinement = (value: number) => boolean

/** A function parameter, optionally refined (e.g. "must be positive"). */
export type Param = { name: string; refine?: Refinement }

/** A function specification. */
export type Contract = {
  name: string
  params: Param[]
  /** Joint precondition over all params (beyond the per-param refinements). */
  pre?: (inputs: number[]) => boolean
  /** What the result must satisfy, given the inputs. */
  post: (inputs: number[], output: number) => boolean
}

/** Does this input tuple satisfy the contract's precondition? */
export function admits(contract: Contract, inputs: number[]): boolean {
  for (let i = 0; i < contract.params.length; i++) {
    const refine = contract.params[i].refine
    if (refine && !refine(inputs[i])) return false
  }
  return contract.pre ? contract.pre(inputs) : true
}

/**
 * The verification condition for a contract + body, as a single spec:
 * on every admitted input, the body's output satisfies the
 * postcondition. Inputs the precondition rejects are vacuously fine -
 * the body is not responsible for them. This IS the refinement: the
 * obligation is weakened by the precondition.
 */
export function conditionFor(contract: Contract, body: Expr): Spec {
  return (inputs, _out) =>
    !admits(contract, inputs) || contract.post(inputs, evalExpr(body, inputs))
}

/**
 * VERIFY a body against a contract by exhaustive proof over the bound.
 * Returns a proof, or the exact admitted input where the body violates
 * the postcondition.
 */
export function verifyContract(
  body: Expr,
  contract: Contract,
  bound = 8,
): ProveResult {
  return prove({
    arity: contract.params.length,
    bound,
    claim: inputs =>
      !admits(contract, inputs) ||
      contract.post(inputs, evalExpr(body, inputs)),
  })
}

/** The synthesis spec for a contract: post must hold on admitted inputs. */
export function specFor(contract: Contract): Spec {
  return (inputs, output) =>
    !admits(contract, inputs) || contract.post(inputs, output)
}

/**
 * The GapReport a checker would emit for an unfilled contract body.
 * The one interface the proposers (CEGIS, AI) consume.
 */
export function contractGap(contract: Contract, bound = 8): GapReport {
  return {
    goal: contract.name,
    varCount: contract.params.length,
    spec: specFor(contract),
    counterexamples: [],
    bound,
  }
}

/**
 * SYNTHESIZE a body satisfying the contract, through the repair loop.
 * The result is proven over the bound. This is the sketch-fill: the
 * body is a hole, the contract is the spec, the system writes the code.
 * Extra proposers (an AI hint) can be passed; CEGIS is always the net.
 */
export function synthesizeContract(
  contract: Contract,
  options: { bound?: number; maxSize?: number; proposers?: Proposer[] } = {},
): RepairResult {
  const bound = options.bound ?? 8
  const proposers = [
    ...(options.proposers ?? []),
    cegisProposer(options.maxSize ?? 6),
  ]
  return repair(contractGap(contract, bound), proposers)
}
