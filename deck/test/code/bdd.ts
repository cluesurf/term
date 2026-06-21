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
 * Pure TypeScript, no dependencies - this is the symbolic engine
 * itself, not a call to one.
 */

/** A BDD node id. 0 = false terminal, 1 = true terminal, else an index. */
export type Bdd = number

type Node = { variable: number; low: Bdd; high: Bdd }

/** A BDD manager: the unique table + caches. Variables are ordered by
 * their integer index (lower index = nearer the root). */
export class BddManager {
  private nodes: Node[] = []
  private unique = new Map<string, Bdd>()
  private iteCache = new Map<string, Bdd>()

  readonly FALSE: Bdd = 0
  readonly TRUE: Bdd = 1

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

  private varOf(b: Bdd): number {
    return this.isTerminal(b) ? Number.MAX_SAFE_INTEGER : this.node(b).variable
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

    // split on the topmost variable among f, g, h
    const top = Math.min(this.varOf(f), this.varOf(g), this.varOf(h))
    const lo = this.ite(this.restrictTop(f, top, false), this.restrictTop(g, top, false), this.restrictTop(h, top, false))
    const hi = this.ite(this.restrictTop(f, top, true), this.restrictTop(g, top, true), this.restrictTop(h, top, true))
    const result = this.mk(top, lo, hi)
    this.iteCache.set(key, result)
    return result
  }

  /** Cofactor of b w.r.t. setting variable `v` to value. */
  private restrictTop(b: Bdd, v: number, value: boolean): Bdd {
    if (this.varOf(b) !== v) return b
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
    if (n.variable > v) return b
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

  /** Count of live BDD nodes (a size measure). */
  size(): number {
    return this.nodes.length
  }
}
