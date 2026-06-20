// Hyperbolic-lattice tests: the {p,3} tessellation tree grows exponentially (the substrate property), and a net
// places onto distinct cells with a measurable locality. Run: npx tsx test/ir/lattice.ts

import { honeycomb, lattice, place } from '@/code/ir/lattice'
import { Net } from '@/code/ir/net'

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

function main(): void {
  const { cells, perShell } = lattice(7, 3, 3)

  ok(
    'centre then exponential shells',
    JSON.stringify(perShell) === JSON.stringify([1, 7, 28, 112]),
    JSON.stringify(perShell),
  )
  // hyperbolic: each shell is at least twice the previous (a Euclidean grid would grow linearly)
  let exponential = true
  for (let n = 2; n < perShell.length; n++)
    if (perShell[n]! < 2 * perShell[n - 1]!) exponential = false
  ok('growth is exponential (hyperbolic, not Euclidean)', exponential)

  ok('the centre has p children', cells[0]!.children.length === 7)
  const shell1 = cells.find(c => c.shell === 1)!
  ok(
    'a non-centre cell has p - 3 children',
    shell1.children.length === 4,
  )

  // place a small net (a chain of constructors) onto the lattice
  const net = new Net()
  const a = net.node('con')
  const b = net.node('con')
  const c = net.node('con')
  net.wire({ node: a, slot: 0 }, { node: b, slot: 0 })
  net.wire({ node: b, slot: 1 }, { node: c, slot: 0 })
  const { placement, locality } = place(net, cells)
  ok(
    'every node placed on a distinct cell',
    placement.size === 3 && new Set(placement.values()).size === 3,
  )
  ok('locality is a fraction in [0, 1]', locality >= 0 && locality <= 1)

  // the 3D and 4D realizations grow exponentially too (more room than a Euclidean grid of the same dimension)
  for (const symbol of ['{5,3,4}', '{3,4,3,4}'] as const) {
    const h = honeycomb(symbol, 3)
    let exp = true
    for (let n = 2; n < h.perShell.length; n++)
      if (h.perShell[n]! < 2 * h.perShell[n - 1]!) exp = false
    ok(
      `${symbol} honeycomb grows exponentially`,
      exp,
      JSON.stringify(h.perShell),
    )
  }

  console.log(`\nlattice: ${pass} pass, ${fail} fail`)
}

main()
