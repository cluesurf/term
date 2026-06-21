/**
 * Symbolic model checking over BDDs: represent the set of reachable
 * states as a BDD and grow it by IMAGE COMPUTATION until a fixpoint.
 * This is the canonical symbolic algorithm (concepts.md) - no state is
 * ever enumerated; the whole reachable set is one BDD.
 *
 * A system has `bits` boolean state variables. Current-state variables
 * are 0..bits-1; next-state variables are bits..2*bits-1. The
 * transition relation is a BDD over both. Reachability iterates
 *   reach <- reach OR image(reach)
 * where image(S) = rename_{next->current}( exists current. (S /\ T) ).
 */

import { BddManager, type Bdd } from './bdd'

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

export class SymbolicChecker {
  constructor(
    readonly mgr: BddManager,
    readonly bits: number,
  ) {}

  private currentVars(): number[] {
    return Array.from({ length: this.bits }, (_, i) => i)
  }

  /** Substitute each next var (bits+i) with the current var (i). */
  private renameNextToCurrent(b: Bdd): Bdd {
    let r = b
    for (let i = 0; i < this.bits; i++) {
      const next = this.bits + i
      // r := ite(current_i, r[next=1], r[next=0])  -- substitutes next->current
      r = this.mgr.ite(
        this.mgr.variable(i),
        this.mgr.restrict(r, next, true),
        this.mgr.restrict(r, next, false),
      )
    }
    return r
  }

  /** Image: the set of states reachable in one step from S. */
  image(s: Bdd, trans: Bdd): Bdd {
    const conj = this.mgr.and(s, trans) // over current + next
    const proj = this.mgr.existsMany(conj, this.currentVars()) // exists current
    return this.renameNextToCurrent(proj) // next -> current
  }

  /** The set of all reachable states (least fixpoint of init OR image). */
  reachable(system: SymSystem): Bdd {
    let reach = system.init
    for (;;) {
      const next = this.mgr.or(reach, this.image(reach, system.trans))
      if (next === reach) return reach // fixpoint (canonical: pointer equal)
      reach = next
    }
  }

  /** Safety: is any bad state reachable? */
  check(system: SymSystem): { safe: boolean } {
    const reach = this.reachable(system)
    const badReachable = this.mgr.and(reach, system.bad)
    return { safe: !this.mgr.satisfiable(badReachable) }
  }
}
