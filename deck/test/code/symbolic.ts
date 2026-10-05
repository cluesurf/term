/**
 * Symbolic model checking over BDDs: represent the set of reachable
 * states as a BDD and grow it by IMAGE COMPUTATION until a fixpoint.
 * This is the canonical symbolic algorithm (concepts.md) - no state is
 * ever enumerated; the whole reachable set is one BDD.
 *
 * A system has `bits` boolean state variables. Current-state variables
 * are 0..bits-1; next-state variables are bits..2*bits-1. The
 * transition relation is a BDD over both.
 *
 * The algorithm is Term since 2026-10-04, deck/test/code/reachability.tree.
 * This class is the face its callers were written against.
 */

import { BddManager, type Bdd } from './bdd'
import { image, isSafe, reachableStates } from '@term/test/code/reachability'
import type { SymbolicSystem } from '@term/test/code/reachability'

/** A finite-state system over boolean variables, as BDDs. */
export type SymSystem = {
  bits: number
  /** initial states, over current vars 0..bits-1 */
  init: Bdd
  /** transition relation, over current 0..bits-1 and next bits..2*bits-1 */
  trans: Bdd
  /** unsafe states, over current vars */
  bad: Bdd
}

function systemOf(system: SymSystem): SymbolicSystem {
  return { bits: system.bits, init: system.init, transition: system.trans, bad: system.bad }
}

export class SymbolicChecker {
  constructor(
    readonly mgr: BddManager,
    readonly bits: number,
  ) {}

  /** Image: the set of states reachable in one step from S. */
  image(s: Bdd, trans: Bdd): Bdd {
    return image(this.mgr.state, this.bits, s, trans)
  }

  /** The set of all reachable states (least fixpoint of init OR image). */
  reachable(system: SymSystem): Bdd {
    return reachableStates(this.mgr.state, this.bits, systemOf(system))
  }

  /** Safety: is any bad state reachable? */
  check(system: SymSystem): { safe: boolean } {
    return { safe: isSafe(this.mgr.state, this.bits, systemOf(system)) }
  }
}
