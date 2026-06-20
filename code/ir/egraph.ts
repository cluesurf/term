// The e-graph optimizer: the maximal-rewriting backbone from note/research/vibe/computation/plans/13-optimization.md.
// An e-graph holds every equivalent form of an expression at once. Rewrite rules are applied to saturation, then
// the cheapest form is extracted. This sidesteps phase ordering: no rule order is committed to. Browser-safe.
//
// This first version optimizes a small arithmetic expression IR (the kind the compiler's binary expressions
// lower to). It demonstrates the technique and can later subsume the simpler simplify.ts pass.

export type Expr =
  | { t: 'int'; value: number }
  | { t: 'var'; name: string }
  | { t: 'op'; op: string; left: Expr; right: Expr }

// an e-node references child e-classes by id. leaves encode their value in the key.
type ENode = { op: string; args: Array<number> }

function key(node: ENode): string {
  return `${node.op}(${node.args.join(',')})`
}

class EGraph {
  private parent: Array<number> = []
  private hashcons = new Map<string, number>()
  private classes = new Map<number, Set<string>>() // class id -> set of node keys
  private nodes = new Map<string, ENode>() // node key -> node

  private find(id: number): number {
    while (this.parent[id] !== id) {
      this.parent[id] = this.parent[this.parent[id]!]!
      id = this.parent[id]!
    }
    return id
  }

  private fresh(): number {
    const id = this.parent.length
    this.parent.push(id)
    this.classes.set(id, new Set())
    return id
  }

  // add a node, returning its (canonical) e-class id
  add(op: string, args: Array<number>): number {
    const node: ENode = { op, args: args.map(a => this.find(a)) }
    const k = key(node)
    const existing = this.hashcons.get(k)
    if (existing !== undefined) return this.find(existing)
    const id = this.fresh()
    this.hashcons.set(k, id)
    this.nodes.set(k, node)
    this.classes.get(id)!.add(k)
    return id
  }

  union(a: number, b: number): boolean {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return false
    this.parent[rb] = ra
    const setA = this.classes.get(ra)!
    for (const k of this.classes.get(rb)!) setA.add(k)
    this.classes.delete(rb)
    return true
  }

  // does this class contain the integer literal `value`?
  intValue(id: number): number | undefined {
    for (const k of this.classes.get(this.find(id))!) {
      const node = this.nodes.get(k)!
      if (node.op.startsWith('int:')) return Number(node.op.slice(4))
    }
    return undefined
  }

  // every (op-node) currently in the graph, with the class it belongs to
  opNodes(): Array<{ id: number; node: ENode }> {
    const out: Array<{ id: number; node: ENode }> = []
    for (const [id, keys] of this.classes) {
      for (const k of keys) {
        const node = this.nodes.get(k)!
        if (node.args.length === 2) out.push({ id, node })
      }
    }
    return out
  }

  // build an e-class from an expression
  build(expr: Expr): number {
    switch (expr.t) {
      case 'int':
        return this.add(`int:${expr.value}`, [])
      case 'var':
        return this.add(`var:${expr.name}`, [])
      case 'op':
        return this.add(expr.op, [
          this.build(expr.left),
          this.build(expr.right),
        ])
    }
  }

  // apply the rewrite rules once across the whole graph; return whether anything changed
  private step(): boolean {
    let changed = false
    for (const { id, node } of this.opNodes()) {
      const [l, r] = node.args as [number, number]
      const li = this.intValue(l)
      const ri = this.intValue(r)

      // constant folding
      if (li !== undefined && ri !== undefined) {
        const folded = fold(node.op, li, ri)
        if (folded !== undefined)
          changed =
            this.union(id, this.add(`int:${folded}`, [])) || changed
      }

      // commutativity
      if (node.op === '+' || node.op === '*') {
        changed = this.union(id, this.add(node.op, [r, l])) || changed
      }

      // identities
      if (node.op === '+' && ri === 0)
        changed = this.union(id, l) || changed
      if (node.op === '+' && li === 0)
        changed = this.union(id, r) || changed
      if (node.op === '-' && ri === 0)
        changed = this.union(id, l) || changed
      if (node.op === '*' && ri === 1)
        changed = this.union(id, l) || changed
      if (node.op === '*' && li === 1)
        changed = this.union(id, r) || changed
      if (node.op === '*' && (ri === 0 || li === 0))
        changed = this.union(id, this.add('int:0', [])) || changed
      if (node.op === '/' && ri === 1)
        changed = this.union(id, l) || changed

      // (a * b) / b  ->  a
      if (node.op === '/') {
        for (const inner of this.classNodes(l)) {
          if (
            inner.op === '*' &&
            this.find(inner.args[1]!) === this.find(r)
          )
            changed = this.union(id, inner.args[0]!) || changed
          if (
            inner.op === '*' &&
            this.find(inner.args[0]!) === this.find(r)
          )
            changed = this.union(id, inner.args[1]!) || changed
        }
      }

      // x - x  ->  0
      if (node.op === '-' && this.find(l) === this.find(r))
        changed = this.union(id, this.add('int:0', [])) || changed

      // constant reassociation: (a + k1) + k2  ->  a + (k1 + k2); likewise for *. With commutativity this also
      // catches (k1 + a) + k2 and the multiplicative forms, so scattered constants collapse to one.
      if ((node.op === '+' || node.op === '*') && ri !== undefined) {
        for (const inner of this.classNodes(l)) {
          if (inner.op !== node.op) continue
          const innerConstant = this.intValue(inner.args[1]!)
          if (innerConstant === undefined) continue
          const combined = fold(node.op, innerConstant, ri)
          if (combined !== undefined)
            changed =
              this.union(
                id,
                this.add(node.op, [
                  inner.args[0]!,
                  this.add(`int:${combined}`, []),
                ]),
              ) || changed
        }
      }
    }
    return changed
  }

  private classNodes(id: number): Array<ENode> {
    const out: Array<ENode> = []
    for (const k of this.classes.get(this.find(id))!)
      out.push(this.nodes.get(k)!)
    return out
  }

  saturate(limit = 50): void {
    let i = 0
    while (i++ < limit && this.step()) {
      // keep applying rules until no class merges (or the bound is hit)
    }
  }

  // extract the cheapest expression from a class (cost = node count)
  extract(root: number): Expr {
    const bestCost = new Map<number, number>()
    const bestNode = new Map<number, ENode>()
    let changed = true
    while (changed) {
      changed = false
      for (const [id, keys] of this.classes) {
        for (const k of keys) {
          const node = this.nodes.get(k)!
          let cost = 1
          let ok = true
          for (const a of node.args) {
            const c = bestCost.get(this.find(a))
            if (c === undefined) {
              ok = false
              break
            }
            cost += c
          }
          if (ok && cost < (bestCost.get(id) ?? Infinity)) {
            bestCost.set(id, cost)
            bestNode.set(id, node)
            changed = true
          }
        }
      }
    }
    const rebuild = (id: number): Expr => {
      const node = bestNode.get(this.find(id))!
      if (node.op.startsWith('int:'))
        return { t: 'int', value: Number(node.op.slice(4)) }
      if (node.op.startsWith('var:'))
        return { t: 'var', name: node.op.slice(4) }
      return {
        t: 'op',
        op: node.op,
        left: rebuild(node.args[0]!),
        right: rebuild(node.args[1]!),
      }
    }
    return rebuild(root)
  }
}

function fold(op: string, a: number, b: number): number | undefined {
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      return b === 0 ? undefined : Math.trunc(a / b)
    default:
      return undefined
  }
}

// optimize an arithmetic expression by equality saturation
export function optimize(expr: Expr): Expr {
  const graph = new EGraph()
  const root = graph.build(expr)
  graph.saturate()
  return graph.extract(root)
}

export function showExpr(expr: Expr): string {
  switch (expr.t) {
    case 'int':
      return String(expr.value)
    case 'var':
      return expr.name
    case 'op':
      return `(${showExpr(expr.left)} ${expr.op} ${showExpr(
        expr.right,
      )})`
  }
}
