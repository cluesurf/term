// Certificates for the linear prover: a refutation is a derivation the checker replays, and the checker must refuse
// a derivation that is not one. Run: npx tsx test/check/certificate.ts
//
// A checker that accepted anything would pass every other suite, so this one holds the checker to its refusals.

import {
  checkGram,
  checkRefutation,
  gramKey,
  refutation,
} from '@term/make/code/check/certificate'
import type { Step } from '@term/make/code/check/certificate'
import { atLeast, atMost, below, linear, proves } from '@term/make/code/check/refine'

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

const x = linear({ x: 1 })
const y = linear({ y: 1 })
const zero = linear({}, 0)
const five = linear({}, 5)

// x >= 0, y >= x, y < 0: unsatisfiable
const system = [atLeast(x, zero), atLeast(y, x), below(y, zero)]
const found = refutation(system)

ok('a refutation is found for an unsatisfiable system', found !== undefined)
ok(
  'and it replays',
  found !== undefined && checkRefutation(system, found),
  JSON.stringify(found),
)

// a satisfiable system: x >= 0, x <= 5
ok(
  'no refutation is found for a satisfiable system',
  refutation([atLeast(x, zero), atMost(x, five)]) === undefined,
)

// ---- tampering ----

const input = (at: number): Step => ({ by: 'input', at })

ok(
  'a derivation that ends at a satisfiable row is refused',
  !checkRefutation(system, input(0)),
)

ok(
  'a zero multiplier is refused',
  !checkRefutation(system, {
    by: 'sum',
    first: input(0),
    second: input(2),
    a: 0,
    b: 1,
  }),
)

ok(
  'a negative multiplier is refused',
  !checkRefutation(system, {
    by: 'sum',
    first: input(0),
    second: input(1),
    a: -1,
    b: 1,
  }),
)

ok(
  'an input that does not exist is refused',
  !checkRefutation(system, { by: 'input', at: 99 }),
)

// 2x <= 3 cut by 2 is x <= 1, which is fine, but a cut by 3 does not divide the coefficient 2
const twoX = [atMost(linear({ x: 2 }), linear({}, 3))]
ok(
  'a cut by a factor that does not divide every coefficient is refused',
  !checkRefutation(twoX, { by: 'cut', of: input(0), g: 3 }),
)

// ---- the integer reasoning the cuts carry ----

// 2x == 3 has no integer solution: only the cut sees it
const twoXisThree = [
  atMost(linear({ x: 2 }), linear({}, 3)),
  atLeast(linear({ x: 2 }), linear({}, 3)),
]
const parity = refutation(twoXisThree)
ok(
  'an integer refutation (2x == 3) is found, and replays',
  parity !== undefined && checkRefutation(twoXisThree, parity),
  JSON.stringify(parity),
)

// ---- end to end: proves() returns true only with a certificate ----

ok(
  'proves() proves a valid goal (x >= 0, y >= x |- y >= 0)',
  proves([atLeast(x, zero), atLeast(y, x)], atLeast(y, zero)),
)
ok(
  'proves() refuses an invalid one (x >= 0 |- x >= 1)',
  !proves([atLeast(x, zero)], atLeast(x, linear({}, 1))),
)

// ---- Gram certificates for the polynomial provers ----

// (x - y)² = x² - 2xy + y², so 2p = 2x² - 4xy + 2y², and over z = (x, y) the matrix M = 2Q is [[2, -2], [-2, 2]]
const square = (matrix: number[][], strict = false, basis: string[][] = [['x'], ['y']]) =>
  checkGram({
    basis,
    matrix,
    target: new Map([
      [gramKey(['x', 'x']), 2],
      [gramKey(['x', 'y']), -4],
      [gramKey(['y', 'y']), 2],
    ]),
    strict,
  })

ok('a Gram certificate for (x - y)² >= 0 replays', square([[2, -2], [-2, 2]]))
ok('a matrix whose expansion is not the polynomial is refused', !square([[2, -1], [-1, 2]]))
ok('an asymmetric matrix is refused, even with the right expansion', !square([[2, -3], [-1, 2]]))
ok(
  'the right expansion over a matrix that is not semidefinite is refused (x² - y²)',
  !checkGram({
    basis: [['x'], ['y']],
    matrix: [[2, 0], [0, -2]],
    target: new Map([
      [gramKey(['x', 'x']), 2],
      [gramKey(['y', 'y']), -2],
    ]),
    strict: false,
  }),
)
ok(
  'a strict claim needs a definite matrix: (x - y)² > 0 is refused',
  !square([[2, -2], [-2, 2]], true),
)
ok(
  'x² + 1 > 0 replays: definite, and the basis holds the constant',
  checkGram({
    basis: [['x'], []],
    matrix: [[2, 0], [0, 2]],
    target: new Map([
      [gramKey(['x', 'x']), 2],
      [gramKey([]), 2],
    ]),
    strict: true,
  }),
)
ok(
  'x² > 0 is refused: definite over z = (x), but zero at x = 0, and the basis has no constant',
  !checkGram({
    basis: [['x']],
    matrix: [[2]],
    target: new Map([[gramKey(['x', 'x']), 2]]),
    strict: true,
  }),
)

console.log(`\ncertificate: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
