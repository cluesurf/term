// Lowering the pure fragment to the interaction net: a lambda-calculus fragment (variable / abstraction / application)
// compiled to interaction combinators, so the language's pure functions run on the substrate. A `lam` and an `app`
// are both `con` nodes; application meeting abstraction at their principal ports annihilates, which IS beta
// reduction. Free variables and the result form the inert boundary (the net's interface).
//
// This lowers the LINEAR fragment (each bound variable used exactly once), where the binder wires straight to its
// single use. Sharing (`dup` for a variable used many times), weakening (`era` for an unused binder), and the
// self-loop of the bare identity all need the extra wiring described in plans/06-runtime-substrate.md; they are the
// next layer. Pure and browser-safe.

import { Net } from '@cluesurf/make/code/ir/net'
import type { Port } from '@cluesurf/make/code/ir/net'

export type Term =
  | { t: 'var'; name: string }
  | { t: 'lam'; param: string; body: Term }
  | { t: 'app'; fn: Term; arg: Term }

export type Lowered = { net: Net; root: Port; free: Map<string, Port> }

export function lower(term: Term): Lowered {
  const net = new Net()
  const free = new Map<string, Port>()

  function pin(name: string): Port {
    let p = free.get(name)

    if (!p) {
      const id = net.node('era')
      net.interface.add(id)
      p = { node: id, slot: 0 }
      free.set(name, p)
    }

    return p
  }

  function build(node: Term, scope: Map<string, Port>): Port {
    switch (node.t) {
      case 'var':
        return scope.get(node.name) ?? pin(node.name) // a bound variable wires straight to its binder; else free

      case 'lam': {
        const con = net.node('con') // slot 0 = the function value, slot 1 = the binder, slot 2 = the body
        const inner = new Map(scope)
        inner.set(node.param, { node: con, slot: 1 })
        net.wire({ node: con, slot: 2 }, build(node.body, inner))

        return { node: con, slot: 0 }
      }

      case 'app': {
        const con = net.node('con') // slot 0 = the function, slot 1 = the argument, slot 2 = the result
        net.wire({ node: con, slot: 0 }, build(node.fn, scope))
        net.wire({ node: con, slot: 1 }, build(node.arg, scope))

        return { node: con, slot: 2 }
      }
    }
  }

  const result = build(term, new Map())
  const rootId = net.node('era')
  net.interface.add(rootId)

  const root: Port = { node: rootId, slot: 0 }
  net.wire(root, result)

  return { net, root, free }
}

// count the non-interface (computational) agents in a lowered net
export function agentCount(lowered: Lowered): number {
  let n = 0

  for (const id of lowered.net.nodes.keys()) {
    if (!lowered.net.interface.has(id)) {
      n++
    }
  }

  return n
}
