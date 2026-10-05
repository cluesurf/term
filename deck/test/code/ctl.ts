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
 * The operators are Term since 2026-10-04, deck/test/code/temporal.tree.
 * This class is the face its callers were written against.
 */

import { BddManager, type Bdd } from './bdd'
import { af, ag, eg, ef, eu, ex, holdsInitially, makeCtlChecker } from '@term/test/code/temporal'
import type { CtlChecker as Checker } from '@term/test/code/temporal'

export class CtlChecker {
  private readonly checker: Checker

  constructor(
    readonly mgr: BddManager,
    readonly bits: number,
    /** the transition relation, over current 0..bits-1 and next bits..2*bits-1 */
    readonly trans: Bdd,
  ) {
    this.checker = makeCtlChecker(mgr.state, bits, trans)
  }

  /** EX p: states with a successor in p (the preimage of p). */
  ex(p: Bdd): Bdd {
    return ex(this.checker, p)
  }

  /** EF p: least fixpoint of p OR EX(X). */
  ef(p: Bdd): Bdd {
    return ef(this.checker, p)
  }

  /** EG p: greatest fixpoint of p AND EX(X). */
  eg(p: Bdd): Bdd {
    return eg(this.checker, p)
  }

  /** E[p U q]: least fixpoint of q OR (p AND EX(X)). */
  eu(p: Bdd, q: Bdd): Bdd {
    return eu(this.checker, p, q)
  }

  /** AG p: p holds on every path forever = !EF !p (safety). */
  ag(p: Bdd): Bdd {
    return ag(this.checker, p)
  }

  /** AF p: every path eventually reaches p = !EG !p (inevitability). */
  af(p: Bdd): Bdd {
    return af(this.checker, p)
  }

  /** Does the formula hold in every initial state? (init implies sat-set). */
  holdsInitially(init: Bdd, formula: Bdd): boolean {
    return holdsInitially(this.checker, init, formula)
  }
}
