// Interaction-combinator tests: the substrate's pure-plane reducer. Annihilation, erasure, and commutation.
// Run: npx tsx test/ir/net.ts
//
// ir/net is Term since 2026-10-04 (deck/make/code/ir/net.tree). A net is a value: every change hands it back.

import { addNode, makeNet, makePort, netSize, normalizeNet, stepNet, wirePorts } from '@term/make/code/ir/net'
import type { Net } from '@term/make/code/ir/net'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// a node of `label`, answering the net and its id
function node(net: Net, label: string): [Net, number] {
  const added = addNode(net, label)

  return [added.graph, added.id]
}

// two nodes facing each other at their principal ports
function facing(left: string, right: string): [Net, number, number] {
  const [one, a] = node(makeNet(), left)
  const [two, b] = node(one, right)

  return [wirePorts(two, makePort(a, 0), makePort(b, 0)), a, b]
}

// wire each auxiliary port of `binary` to a fresh eraser, so the net is closed
function closeAux(net: Net, binary: number): Net {
  const [one, e1] = node(net, 'era')
  const wired = wirePorts(one, makePort(binary, 1), makePort(e1, 0))
  const [two, e2] = node(wired, 'era')

  return wirePorts(two, makePort(binary, 2), makePort(e2, 0))
}

function count(net: Net, label: string): number {
  return [...net.nodes.values()].filter(l => l === label).length
}

function main(): void {
  // two erasers facing each other annihilate to nothing
  {
    const [net] = facing('era', 'era')
    ok('era ~ era annihilates to empty', netSize(normalizeNet(net)) === 0)
  }

  // two constructors facing each other annihilate; the closing erasers then cancel pairwise: empty net
  {
    const [net, a, b] = facing('con', 'con')
    ok('con ~ con annihilates, then erasers cancel', netSize(normalizeNet(closeAux(closeAux(net, a), b))) === 0)
  }

  // an eraser meeting a constructor erases it, leaving erasers that cascade away
  {
    const [net, c] = facing('con', 'era')
    ok('era ~ con erases the constructor (cascades to empty)', netSize(normalizeNet(closeAux(net, c))) === 0)
  }

  // con meeting dup commutes: one step removes the pair and creates two of each (duplication through)
  {
    const [net, c, d] = facing('con', 'dup')
    const stepped = stepNet(closeAux(closeAux(net, c), d))
    ok(
      'con ~ dup commutes into two con and two dup',
      count(stepped.graph, 'con') === 2 && count(stepped.graph, 'dup') === 2,
    )
    ok('commutation recorded one rewrite', stepped.graph.rewrites === 1)
  }

  console.log(`\nnet: ${pass} pass, ${fail} fail`)
}

main()
