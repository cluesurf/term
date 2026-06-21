/**
 * CTL model checking as BDD fixpoints over a transition relation. Each
 * temporal operator is a set of states, computed symbolically:
 *
 *   EX p   one step: a successor satisfies p        (preimage)
 *   EF p   some path eventually reaches p           (least fixpoint)
 *   EG p   some path keeps p forever                (greatest fixpoint)
 *   EU p q some path holds p until q                (least fixpoint)
 *   AG p   every path keeps p forever  = !EF !p     (safety)
 *   AF p   every path eventually reaches p = !EG !p (liveness/inevitability)
 *
 * This is how "eventually" and "always" become decidable on a finite
 * state space (concepts.md): each operator is a BDD fixpoint, and
 * canonicity makes "did the fixpoint converge?" a pointer compare.
 */

import { BddManager, type Bdd } from './bdd'

export class CtlChecker {
  constructor(
    readonly mgr: BddManager,
    readonly bits: number,
    /** the transition relation, over current 0..bits-1 and next bits..2*bits-1 */
    readonly trans: Bdd,
  ) {}

  private nextVars(): number[] {
    return Array.from({ length: this.bits }, (_, i) => this.bits + i)
  }

  /** Substitute each current var i with the next var bits+i. */
  private toNext(p: Bdd): Bdd {
    let r = p
    for (let i = 0; i < this.bits; i++) {
      r = this.mgr.ite(
        this.mgr.variable(this.bits + i),
        this.mgr.restrict(r, i, true),
        this.mgr.restrict(r, i, false),
      )
    }
    return r
  }

  /** EX p: states with a successor in p (the preimage of p). */
  ex(p: Bdd): Bdd {
    const pNext = this.toNext(p)
    const conj = this.mgr.and(this.trans, pNext)
    return this.mgr.existsMany(conj, this.nextVars())
  }

  /** EF p: least fixpoint of p OR EX(X). */
  ef(p: Bdd): Bdd {
    let x = p
    for (;;) {
      const next = this.mgr.or(x, this.ex(x))
      if (next === x) return x
      x = next
    }
  }

  /** EG p: greatest fixpoint of p AND EX(X). */
  eg(p: Bdd): Bdd {
    let x = p
    for (;;) {
      const next = this.mgr.and(p, this.ex(x))
      if (next === x) return x
      x = next
    }
  }

  /** E[p U q]: least fixpoint of q OR (p AND EX(X)). */
  eu(p: Bdd, q: Bdd): Bdd {
    let x = q
    for (;;) {
      const next = this.mgr.or(q, this.mgr.and(p, this.ex(x)))
      if (next === x) return x
      x = next
    }
  }

  /** AG p: p holds on every path forever = !EF !p (safety). */
  ag(p: Bdd): Bdd {
    return this.mgr.not(this.ef(this.mgr.not(p)))
  }

  /** AF p: every path eventually reaches p = !EG !p (inevitability). */
  af(p: Bdd): Bdd {
    return this.mgr.not(this.eg(this.mgr.not(p)))
  }

  /** Does the formula hold in every initial state? (init implies sat-set). */
  holdsInitially(init: Bdd, formula: Bdd): boolean {
    // init AND NOT formula must be unsatisfiable
    return !this.mgr.satisfiable(this.mgr.and(init, this.mgr.not(formula)))
  }
}
