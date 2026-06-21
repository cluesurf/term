/**
 * Reduced Ordered Binary Decision Diagrams (ROBDDs): a canonical,
 * compressed representation of a boolean function as a DAG. The
 * breakthrough behind SYMBOLIC model checking (concepts.md) - you
 * manipulate SETS of states as one BDD instead of enumerating them, so
 * billions of states fit. Canonicity (from the two reduction rules +
 * hash-consing) makes equivalence a pointer compare.
 *
 * This is a from-scratch ROBDD with the classic operations: mk (the
 * reduce rule), ite (the universal operator), and/or/not/xor, exists
 * (quantify a variable out - the engine of image computation), and
 * restrict. Built on a unique table (hash-consing) and an apply cache.
 *
 * VARIABLE ORDERING is the performance lever for BDDs: the same function
 * can be linear under one order and exponential under another. The
 * manager carries an explicit order (level = position, not the raw
 * variable index), and `siftReorder` searches for a better order by
 * moving each variable to its best level (Rudell's sifting), measuring
 * the rebuilt size. Default order = the natural index order, so existing
 * callers are unaffected.
 *
 * Pure TypeScript, no dependencies - this is the symbolic engine
 * itself, not a call to one.
 */

/** A BDD node id. 0 = false terminal, 1 = true terminal, else an index. */
export type Bdd = number

type Node = { variable: number; low: Bdd; high: Bdd }

/** A BDD manager: the unique table + caches. Variables are ordered by
 * their LEVEL (position in the manager's order); a lower level is nearer
 * the root. Without an explicit order, a variable's level is its own
 * integer index (the natural order). */
export class BddManager {
  private nodes: Node[] = []
  private unique = new Map<string, Bdd>()
  private iteCache = new Map<string, Bdd>()
  // variable index -> level (position in the order). Missing = use the index itself.
  private position = new Map<number, number>()

  readonly FALSE: Bdd = 0
  readonly TRUE: Bdd = 1

  /** @param order variables listed root-to-leaf; index i gets level i.
   * Omit for the natural index order. */
  constructor(order?: number[]) {
    if (order) order.forEach((v, level) => this.position.set(v, level))
  }

  /** The level (order rank) of a variable. Default: its own index. */
  private rankOfVar(v: number): number {
    return this.position.get(v) ?? v
  }

  /** The reduce rule + hash-consing: never create a redundant test
   * (low === high) and never duplicate an existing node. */
  private mk(variable: number, low: Bdd, high: Bdd): Bdd {
    if (low === high) return low
    const key = `${variable}:${low}:${high}`
    const hit = this.unique.get(key)
    if (hit !== undefined) return hit
    const id = this.nodes.length + 2 // 0,1 reserved for terminals
    this.nodes.push({ variable, low, high })
    this.unique.set(key, id)
    return id
  }

  private node(b: Bdd): Node {
    return this.nodes[b - 2]
  }

  private isTerminal(b: Bdd): boolean {
    return b === 0 || b === 1
  }

  /** The variable tested at b's root, or undefined for a terminal. */
  private topVar(b: Bdd): number | undefined {
    return this.isTerminal(b) ? undefined : this.node(b).variable
  }

  /** The level of b's root variable (terminals sit below everything). */
  private rankOf(b: Bdd): number {
    return this.isTerminal(b) ? Number.MAX_SAFE_INTEGER : this.rankOfVar(this.node(b).variable)
  }

  /** The BDD for a single variable (its positive literal). */
  variable(index: number): Bdd {
    return this.mk(index, this.FALSE, this.TRUE)
  }

  /** if-then-else: the universal BDD operator. Every other op reduces to it. */
  ite(f: Bdd, g: Bdd, h: Bdd): Bdd {
    if (f === this.TRUE) return g
    if (f === this.FALSE) return h
    if (g === h) return g
    if (g === this.TRUE && h === this.FALSE) return f

    const key = `${f}?${g}:${h}`
    const cached = this.iteCache.get(key)
    if (cached !== undefined) return cached

    // split on the lowest-level (topmost) variable among f, g, h
    const top = this.lowestVar(f, g, h)
    const lo = this.ite(
      this.restrictTop(f, top, false),
      this.restrictTop(g, top, false),
      this.restrictTop(h, top, false),
    )
    const hi = this.ite(
      this.restrictTop(f, top, true),
      this.restrictTop(g, top, true),
      this.restrictTop(h, top, true),
    )
    const result = this.mk(top, lo, hi)
    this.iteCache.set(key, result)
    return result
  }

  /** The variable with the smallest level among f, g, h (the split point). */
  private lowestVar(f: Bdd, g: Bdd, h: Bdd): number {
    let best: number | undefined
    for (const v of [this.topVar(f), this.topVar(g), this.topVar(h)]) {
      if (v === undefined) continue
      if (best === undefined || this.rankOfVar(v) < this.rankOfVar(best)) best = v
    }
    return best! // at least one of f,g,h is non-terminal once the shortcuts above pass
  }

  /** Cofactor of b w.r.t. setting variable `v` to value (only at the root). */
  private restrictTop(b: Bdd, v: number, value: boolean): Bdd {
    if (this.topVar(b) !== v) return b
    const n = this.node(b)
    return value ? n.high : n.low
  }

  not(f: Bdd): Bdd {
    return this.ite(f, this.FALSE, this.TRUE)
  }
  and(f: Bdd, g: Bdd): Bdd {
    return this.ite(f, g, this.FALSE)
  }
  or(f: Bdd, g: Bdd): Bdd {
    return this.ite(f, this.TRUE, g)
  }
  xor(f: Bdd, g: Bdd): Bdd {
    return this.ite(f, this.not(g), g)
  }
  implies(f: Bdd, g: Bdd): Bdd {
    return this.ite(f, g, this.TRUE)
  }

  /** Restrict variable `v` to a concrete value (cofactor), recursively. */
  restrict(b: Bdd, v: number, value: boolean): Bdd {
    if (this.isTerminal(b)) return b
    const n = this.node(b)
    // v sits below this node's level, so it cannot appear underneath: unaffected
    if (this.rankOfVar(n.variable) > this.rankOfVar(v)) return b
    if (n.variable === v) return value ? n.high : n.low
    return this.mk(n.variable, this.restrict(n.low, v, value), this.restrict(n.high, v, value))
  }

  /** Existential quantification: exists v. f  =  f[v=0] OR f[v=1]. The
   * core of image computation in symbolic model checking. */
  exists(b: Bdd, v: number): Bdd {
    return this.or(this.restrict(b, v, false), this.restrict(b, v, true))
  }

  /** Quantify out a whole set of variables. */
  existsMany(b: Bdd, vars: number[]): Bdd {
    let r = b
    for (const v of vars) r = this.exists(r, v)
    return r
  }

  /** Whether f is satisfiable (not the false terminal). */
  satisfiable(f: Bdd): boolean {
    return f !== this.FALSE
  }

  /** Count of live BDD nodes (a size measure for the whole manager). */
  size(): number {
    return this.nodes.length
  }

  // ---- reordering support ----

  /** The distinct non-terminal nodes reachable from the given roots. */
  reachable(roots: Bdd[]): number {
    const seen = new Set<Bdd>()
    const visit = (b: Bdd): void => {
      if (this.isTerminal(b) || seen.has(b)) return
      seen.add(b)
      const n = this.node(b)
      visit(n.low)
      visit(n.high)
    }
    for (const r of roots) visit(r)
    return seen.size
  }

  /** Every variable appearing under the given roots. */
  variablesIn(roots: Bdd[]): number[] {
    const seen = new Set<Bdd>()
    const vars = new Set<number>()
    const visit = (b: Bdd): void => {
      if (this.isTerminal(b) || seen.has(b)) return
      seen.add(b)
      const n = this.node(b)
      vars.add(n.variable)
      visit(n.low)
      visit(n.high)
    }
    for (const r of roots) visit(r)
    return [...vars]
  }

  /** Rebuild the given roots into a fresh manager under `order`. The
   * functions are preserved exactly; only the variable order (and so the
   * node count) changes. */
  copyUnder(order: number[], roots: Bdd[]): { manager: BddManager; roots: Bdd[] } {
    const target = new BddManager(order)
    const memo = new Map<Bdd, Bdd>()
    const go = (b: Bdd): Bdd => {
      if (this.isTerminal(b)) return b
      const hit = memo.get(b)
      if (hit !== undefined) return hit
      const n = this.node(b)
      // ite(var, high, low): the variable selects high when true, low when false
      const r = target.ite(target.variable(n.variable), go(n.high), go(n.low))
      memo.set(b, r)
      return r
    }
    return { manager: target, roots: roots.map(go) }
  }

  /** This manager's current variable order (root-to-leaf), for the
   * variables under `roots`. */
  orderOf(roots: Bdd[]): number[] {
    return this.variablesIn(roots).sort((a, b) => this.rankOfVar(a) - this.rankOfVar(b))
  }
}

/**
 * Sifting (Rudell): search for a variable order that minimizes the BDD
 * size for the given roots. Each variable is moved to every level; the
 * best position is kept, then the next variable is sifted, and so on.
 * Returns a fresh manager holding the roots under the best order found,
 * plus the before/after sizes so the win is measurable.
 *
 * This is the rebuild-based form (re-derive under each candidate order),
 * which is simpler and correct; production engines do it with in-place
 * adjacent swaps, but the search and the result are the same.
 */
export function siftReorder(
  mgr: BddManager,
  roots: Bdd[],
): { manager: BddManager; roots: Bdd[]; order: number[]; before: number; after: number } {
  const before = mgr.reachable(roots)
  let bestOrder = mgr.orderOf(roots)
  let best = mgr.copyUnder(bestOrder, roots)
  let bestSize = best.manager.reachable(best.roots)

  const vars = bestOrder.slice()
  for (const v of vars) {
    for (let pos = 0; pos < bestOrder.length; pos++) {
      const candidate = bestOrder.filter(x => x !== v)
      candidate.splice(pos, 0, v)
      const built = mgr.copyUnder(candidate, roots)
      const size = built.manager.reachable(built.roots)
      if (size < bestSize) {
        bestSize = size
        bestOrder = candidate
        best = built
      }
    }
  }

  return { manager: best.manager, roots: best.roots, order: bestOrder, before, after: bestSize }
}
