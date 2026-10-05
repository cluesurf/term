/**
 * Reduced Ordered Binary Decision Diagrams (ROBDDs): a canonical,
 * compressed representation of a boolean function as a DAG. The
 * breakthrough behind SYMBOLIC model checking (concepts.md) - you
 * manipulate SETS of states as one BDD instead of enumerating them, so
 * billions of states fit. Canonicity (from the two reduction rules +
 * hash-consing) makes equivalence a pointer compare.
 *
 * The diagrams are Term since 2026-10-04: deck/test/code/decision-diagram.tree
 * holds the manager and every operation, sifting included. This class is
 * the face its callers (ctl.ts, symbolic.ts, the demos) were written
 * against, a method per task.
 */

import {
  copyUnder,
  diagramAnd,
  diagramImplies,
  diagramNot,
  diagramOr,
  diagramXor,
  exists,
  existsMany,
  ifThenElse,
  makeManager,
  makeManagerOrdered,
  nodeCount,
  orderOf,
  reachable,
  restrict,
  siftReorder as siftDiagrams,
  variableOf,
  variablesIn,
} from '@term/test/code/decision-diagram'
import type { DiagramManager } from '@term/test/code/decision-diagram'

/** A BDD node id. 0 = false terminal, 1 = true terminal, else an index. */
export type Bdd = number

/** A BDD manager: the unique table + caches. Variables are ordered by
 * their LEVEL (position in the manager's order); a lower level is nearer
 * the root. Without an explicit order, a variable's level is its own
 * integer index (the natural order). */
export class BddManager {
  readonly state: DiagramManager

  readonly FALSE: Bdd = 0
  readonly TRUE: Bdd = 1

  /** @param order variables listed root-to-leaf; index i gets level i.
   * Omit for the natural index order. */
  constructor(order?: number[], state?: DiagramManager) {
    this.state = state ?? (order ? makeManagerOrdered(order) : makeManager())
  }

  /** The BDD for a single variable (its positive literal). */
  variable(index: number): Bdd {
    return variableOf(this.state, index)
  }

  /** if-then-else: the universal BDD operator. Every other op reduces to it. */
  ite(f: Bdd, g: Bdd, h: Bdd): Bdd {
    return ifThenElse(this.state, f, g, h)
  }

  not(f: Bdd): Bdd {
    return diagramNot(this.state, f)
  }
  and(f: Bdd, g: Bdd): Bdd {
    return diagramAnd(this.state, f, g)
  }
  or(f: Bdd, g: Bdd): Bdd {
    return diagramOr(this.state, f, g)
  }
  xor(f: Bdd, g: Bdd): Bdd {
    return diagramXor(this.state, f, g)
  }
  implies(f: Bdd, g: Bdd): Bdd {
    return diagramImplies(this.state, f, g)
  }

  /** Restrict variable `v` to a concrete value (cofactor), recursively. */
  restrict(b: Bdd, v: number, value: boolean): Bdd {
    return restrict(this.state, b, v, value)
  }

  /** Existential quantification: exists v. f  =  f[v=0] OR f[v=1]. The
   * core of image computation in symbolic model checking. */
  exists(b: Bdd, v: number): Bdd {
    return exists(this.state, b, v)
  }

  /** Quantify out a whole set of variables. */
  existsMany(b: Bdd, vars: number[]): Bdd {
    return existsMany(this.state, b, vars)
  }

  /** Whether f is satisfiable (not the false terminal). */
  satisfiable(f: Bdd): boolean {
    return f !== this.FALSE
  }

  /** Count of live BDD nodes (a size measure for the whole manager). */
  size(): number {
    return nodeCount(this.state)
  }

  /** The distinct non-terminal nodes reachable from the given roots. */
  reachable(roots: Bdd[]): number {
    return reachable(this.state, roots)
  }

  /** Every variable appearing under the given roots. */
  variablesIn(roots: Bdd[]): number[] {
    return variablesIn(this.state, roots)
  }

  /** Rebuild the given roots into a fresh manager under `order`. The
   * functions are preserved exactly; only the variable order (and so the
   * node count) changes. */
  copyUnder(order: number[], roots: Bdd[]): { manager: BddManager; roots: Bdd[] } {
    const copied = copyUnder(this.state, order, roots)

    return { manager: new BddManager(undefined, copied.manager), roots: copied.roots }
  }

  /** This manager's current variable order (root-to-leaf), for the
   * variables under `roots`. */
  orderOf(roots: Bdd[]): number[] {
    return orderOf(this.state, roots)
  }
}

/**
 * Sifting (Rudell): search for a variable order that minimizes the BDD
 * size for the given roots. Returns a fresh manager holding the roots
 * under the best order found, plus the before/after sizes so the win is
 * measurable.
 */
export function siftReorder(
  mgr: BddManager,
  roots: Bdd[],
): { manager: BddManager; roots: Bdd[]; order: number[]; before: number; after: number } {
  const found = siftDiagrams(mgr.state, roots)

  return { manager: new BddManager(undefined, found.manager), roots: found.roots, order: found.order, before: found.before, after: found.after }
}
