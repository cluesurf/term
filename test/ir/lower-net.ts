// Lowering tests: the lambda fragment compiles to interaction combinators, and reduction on the net IS beta reduction.
// Run: npx tsx test/ir/lower-net.ts

import { lower, agentCount } from '@term/make/code/ir/lower-net'
import type { Term } from '@term/make/code/ir/lower-net'

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

const v = (name: string): Term => ({ t: 'var', name })
const lam = (param: string, body: Term): Term => ({
  t: 'lam',
  param,
  body,
})

const app = (fn: Term, arg: Term): Term => ({ t: 'app', fn, arg })

function main(): void {
  // (\x. f x) y   beta-reduces to   f y : one application node remains, wiring f, y, and the root
  const term: Term = app(lam('x', app(v('f'), v('x'))), v('y'))
  const lowered = lower(term)
  ok(
    'before reduction there are three con nodes (two lam/app + inner app)',
    agentCount(lowered) === 3,
  )

  lowered.net.normalize()
  ok(
    'reduces to a single application node (f y)',
    agentCount(lowered) === 1,
  )
  ok('reduction fired the beta rule', lowered.net.rewrites >= 1)

  // the surviving node is `f y`: its function port reaches f, its argument port reaches y, its result reaches root
  const survivor = [...lowered.net.nodes.keys()].find(
    id => !lowered.net.interface.has(id),
  )!

  const fnPeer = lowered.net.peer({ node: survivor, slot: 0 })!
  const argPeer = lowered.net.peer({ node: survivor, slot: 1 })!
  const rootPeer = lowered.net.peer(lowered.root)!
  ok(
    'the application calls f',
    fnPeer.node === lowered.free.get('f')!.node,
  )
  ok(
    'the application is applied to y',
    argPeer.node === lowered.free.get('y')!.node,
  )
  ok('the result is wired to the root', rootPeer.node === survivor)

  console.log(`\nlower-net: ${pass} pass, ${fail} fail`)
}

main()
