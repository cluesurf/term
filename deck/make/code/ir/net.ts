// Interaction combinators: the substrate's pure-plane low IR. The runtime is a graph of agents wired port to
// port, reduced by purely local rewrites on "active pairs" (two agents touching principal port to principal
// port). This is Lafont's universal system (the model HVM and the hyperbolic substrate run on); the pure fragment
// of the language lowers to it. Three agents: `con` (a binary constructor/application node), `dup` (a binary
// duplicator), and `era` (a nullary eraser). See note/research/vibe/computation/plans/06-runtime-substrate.md.
// Pure and browser-safe.

export type Label = 'con' | 'dup' | 'era'

// a port: a node id and a slot. Slot 0 is the principal port; slots 1 and 2 are the auxiliaries (con / dup only).
export type Port = { node: number; slot: number }

const arity: Record<Label, number> = { con: 2, dup: 2, era: 0 }

export class Net {
  nodes = new Map<number, Label>()
  private link = new Map<string, Port>() // "node:slot" -> the port it is wired to
  private next = 0
  rewrites = 0 // count of interaction-rule applications, for measuring reduction cost
  interface = new Set<number>() // inert nodes: the free wires / root that form the net's external boundary

  private key(p: Port): string {
    return `${p.node}:${p.slot}`
  }

  node(label: Label): number {
    const id = this.next++
    this.nodes.set(id, label)

    return id
  }

  // wire two ports together (symmetric)
  wire(a: Port, b: Port): void {
    this.link.set(this.key(a), b)
    this.link.set(this.key(b), a)
  }

  peer(p: Port): Port | undefined {
    return this.link.get(this.key(p))
  }

  private remove(id: number): void {
    const n = arity[this.nodes.get(id)!]

    for (let slot = 0; slot <= n; slot++) {
      this.link.delete(`${id}:${slot}`)
    }

    this.nodes.delete(id)
  }

  // the active pairs: nodes whose principal ports are wired to each other's principal port
  private activePair(): [number, number] | undefined {
    for (const id of this.nodes.keys()) {
      if (this.interface.has(id)) {
        continue
      } // the boundary is inert

      const peer = this.peer({ node: id, slot: 0 })

      if (
        peer?.slot === 0 &&
        peer.node !== id &&
        this.nodes.has(peer.node) &&
        !this.interface.has(peer.node) &&
        peer.node > id
      ) {
        return [id, peer.node]
      }
    }

    return undefined
  }

  // apply one interaction rule; returns whether one fired
  step(): boolean {
    const pair = this.activePair()

    if (!pair) {
      return false
    }

    const [a, b] = pair
    const la = this.nodes.get(a)!
    const lb = this.nodes.get(b)!
    this.rewrites++

    if (la === 'era' && lb === 'era') {
      this.remove(a)
      this.remove(b)

      return true
    }

    if (la === 'era' || lb === 'era') {
      // erase a binary agent: its two auxiliaries each get a fresh eraser
      const [eraser, binary] = la === 'era' ? [a, b] : [b, a]
      const x1 = this.peer({ node: binary, slot: 1 })!
      const x2 = this.peer({ node: binary, slot: 2 })!
      this.remove(eraser)
      this.remove(binary)
      this.wire({ node: this.node('era'), slot: 0 }, x1)
      this.wire({ node: this.node('era'), slot: 0 }, x2)

      return true
    }

    const a1 = this.peer({ node: a, slot: 1 })!
    const a2 = this.peer({ node: a, slot: 2 })!
    const b1 = this.peer({ node: b, slot: 1 })!
    const b2 = this.peer({ node: b, slot: 2 })!

    if (la === lb) {
      // annihilation: same agents cancel, wiring their auxiliaries straight across
      this.remove(a)
      this.remove(b)
      this.wire(a1, b1)
      this.wire(a2, b2)

      return true
    }

    // commutation: each agent passes through the other, duplicating it
    this.remove(a)
    this.remove(b)

    const b1n = this.node(lb)
    const b2n = this.node(lb)
    const a1n = this.node(la)
    const a2n = this.node(la)
    this.wire({ node: b1n, slot: 0 }, a1)
    this.wire({ node: b2n, slot: 0 }, a2)
    this.wire({ node: a1n, slot: 0 }, b1)
    this.wire({ node: a2n, slot: 0 }, b2)
    this.wire({ node: b1n, slot: 1 }, { node: a1n, slot: 1 })
    this.wire({ node: b1n, slot: 2 }, { node: a2n, slot: 1 })
    this.wire({ node: b2n, slot: 1 }, { node: a1n, slot: 2 })
    this.wire({ node: b2n, slot: 2 }, { node: a2n, slot: 2 })

    return true
  }

  // reduce to normal form (no active pairs); `limit` is a safety bound
  normalize(limit = 100000): void {
    let n = 0

    while (this.step()) {
      if (++n >= limit) {
        break
      }
    }
  }

  size(): number {
    return this.nodes.size
  }
}
