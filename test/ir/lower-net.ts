// Lowering tests: the lambda fragment compiles to interaction combinators, and reduction on the net IS beta reduction.
// Run: npx tsx test/ir/lower-net.ts
//
// ir/lower-net and ir/net are Term since 2026-10-04. A lowered term carries its net as `graph`, and reducing it hands
// back the reduced net.

import { lower, agentCount } from '@term/make/code/ir/lower-net'
import type { LambdaTerm } from '@term/make/code/ir/lower-net'
import { hasPeer, isBoundary, makePort, normalizeNet, peerOf } from '@term/make/code/ir/net'

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

const v = (name: string): LambdaTerm => ({ t: 'var', name })
const lam = (param: string, body: LambdaTerm): LambdaTerm => ({
  t: 'lam',
  param,
  body,
})

const app = (fn: LambdaTerm, arg: LambdaTerm): LambdaTerm => ({ t: 'app', fn, arg })

function main(): void {
  // (\x. f x) y   beta-reduces to   f y : one application node remains, wiring f, y, and the root
  const term: LambdaTerm = app(lam('x', app(v('f'), v('x'))), v('y'))
  const lowered = lower(term)
  ok(
    'before reduction there are three con nodes (two lam/app + inner app)',
    agentCount(lowered) === 3,
  )

  const reduced = { ...lowered, graph: normalizeNet(lowered.graph) }
  ok(
    'reduces to a single application node (f y)',
    agentCount(reduced) === 1,
  )
  ok('reduction fired the beta rule', reduced.graph.rewrites >= 1)

  // the surviving node is `f y`: its function port reaches f, its argument port reaches y, its result reaches root
  const net = reduced.graph
  const survivor = [...net.nodes.keys()].find(id => !isBoundary(net, id))!

  const fnPeer = peerOf(net, makePort(survivor, 0))
  const argPeer = peerOf(net, makePort(survivor, 1))
  const rootPeer = peerOf(net, reduced.root)
  ok('every port of the survivor is wired', hasPeer(net, makePort(survivor, 0)) && hasPeer(net, makePort(survivor, 1)))
  ok(
    'the application calls f',
    fnPeer.node === reduced.free.get('f')!.node,
  )
  ok(
    'the application is applied to y',
    argPeer.node === reduced.free.get('y')!.node,
  )
  ok('the result is wired to the root', rootPeer.node === survivor)

  console.log(`\nlower-net: ${pass} pass, ${fail} fail`)
}

main()
