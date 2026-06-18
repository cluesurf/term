// Interaction-combinator tests: the substrate's pure-plane reducer. Annihilation, erasure, and commutation.
// Run: npx tsx test/ir/net.ts

import { Net } from '@/code/ir/net'
import type { Label } from '@/code/ir/net'

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

// wire each auxiliary port of `binary` to a fresh eraser, so the net is closed
function closeAux(net: Net, binary: number): void {
  net.wire({ node: binary, slot: 1 }, { node: net.node('era'), slot: 0 })
  net.wire({ node: binary, slot: 2 }, { node: net.node('era'), slot: 0 })
}

function count(net: Net, label: Label): number {
  let n = 0
  for (const l of net.nodes.values()) if (l === label) n++
  return n
}

function main(): void {
  // two erasers facing each other annihilate to nothing
  {
    const net = new Net()
    const a = net.node('era')
    const b = net.node('era')
    net.wire({ node: a, slot: 0 }, { node: b, slot: 0 })
    net.normalize()
    ok('era ~ era annihilates to empty', net.size() === 0)
  }

  // two constructors facing each other annihilate; the closing erasers then cancel pairwise: empty net
  {
    const net = new Net()
    const a = net.node('con')
    const b = net.node('con')
    net.wire({ node: a, slot: 0 }, { node: b, slot: 0 })
    closeAux(net, a)
    closeAux(net, b)
    net.normalize()
    ok('con ~ con annihilates, then erasers cancel', net.size() === 0)
  }

  // an eraser meeting a constructor erases it, leaving erasers that cascade away
  {
    const net = new Net()
    const c = net.node('con')
    const e = net.node('era')
    net.wire({ node: c, slot: 0 }, { node: e, slot: 0 })
    closeAux(net, c)
    net.normalize()
    ok('era ~ con erases the constructor (cascades to empty)', net.size() === 0)
  }

  // con meeting dup commutes: one step removes the pair and creates two of each (duplication through)
  {
    const net = new Net()
    const c = net.node('con')
    const d = net.node('dup')
    net.wire({ node: c, slot: 0 }, { node: d, slot: 0 })
    closeAux(net, c)
    closeAux(net, d)
    net.step() // a single commutation
    ok('con ~ dup commutes into two con and two dup', count(net, 'con') === 2 && count(net, 'dup') === 2)
    ok('commutation recorded one rewrite', net.rewrites === 1)
  }

  console.log(`\nnet: ${pass} pass, ${fail} fail`)
}

main()
