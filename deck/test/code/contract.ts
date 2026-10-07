/**
 * Contracts and refinement checking: Layers 1-2 of the system
 * (note/project/term/verification/seed-verification-system.md). A
 * `Contract` is a function's specification - parameter refinements
 * (preconditions on inputs) plus a postcondition on the result.
 *
 * A contract with a HOLE for its body is a synthesis problem: `verifyContract`
 * checks a body, `synthesizeContract` writes one the prover then certifies.
 *
 * Term since 2026-10-05 (deck/test/code/contract-form.tree and
 * contract-check.tree, which hold demo-contract.ts's every answer). This is
 * its face: a contract here is converted to the port's, whose refinements and
 * precondition are always present, and whose spec is the contract as data.
 */

import { admits as admitsPort, meetsContract } from '@term/test/code/contract-form'
import { verifyContract as verifyPort, synthesizeContract as synthesizePort, contractGap as gapPort } from '@term/test/code/contract-check'
import { fromTermGap, termProposer, type GapReport, type RepairResult, type Proposer } from './gap'
import { evalExpr, type Expr, type Spec } from './synthesize'
import type { ProveResult } from './prove'

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

/** The port's contract: every refinement and the precondition present. */
function toTerm(contract: Contract): never {
  return {
    name: contract.name,
    names: contract.params.map(p => p.name),
    refines: contract.params.map(p => p.refine ?? (() => true)),
    pre: contract.pre ?? (() => true),
    post: contract.post,
  } as never
}

/** Does this input tuple satisfy the contract's precondition? */
export function admits(contract: Contract, inputs: number[]): boolean {
  return admitsPort(toTerm(contract), inputs)
}

/**
 * The verification condition for a contract + body, as a single spec:
 * on every admitted input, the body's output satisfies the postcondition.
 */
export function conditionFor(contract: Contract, body: Expr): Spec {
  const terms = toTerm(contract)

  return inputs => meetsContract(terms, inputs, evalExpr(body, inputs))
}

/** VERIFY a body against a contract by exhaustive proof over the bound. */
export function verifyContract(body: Expr, contract: Contract, bound = 8): ProveResult {
  return verifyPort(body, toTerm(contract), bound) as ProveResult
}

/** The synthesis spec for a contract: post must hold on admitted inputs. */
export function specFor(contract: Contract): Spec {
  const terms = toTerm(contract)

  return (inputs, output) => meetsContract(terms, inputs, output)
}

/** The GapReport a checker would emit for an unfilled contract body. */
export function contractGap(contract: Contract, bound = 8): GapReport {
  return fromTermGap(gapPort(toTerm(contract), bound))
}

/**
 * SYNTHESIZE a body satisfying the contract, through the repair loop.
 * Extra proposers (an AI hint) can be passed; CEGIS is always the net.
 */
export function synthesizeContract(
  contract: Contract,
  options: { bound?: number; maxSize?: number; proposers?: Proposer[] } = {},
): RepairResult {
  return synthesizePort(
    toTerm(contract),
    options.bound ?? 8,
    options.maxSize ?? 6,
    (options.proposers ?? []).map(termProposer),
  ) as RepairResult
}
